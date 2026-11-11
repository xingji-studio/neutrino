import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"neutrino-plugins-"));
process.env.NEUTRINO_HOME=path.join(root,"home");
process.env.NEUTRINO_PLUGIN_HOME=path.join(root,"installed");
process.env.NEUTRINO_PLAN="off";
const manager=await import("../dist/plugins/manager.js");
const {PluginHost}=await import("../dist/plugins/host.js");
const {runPluginTurn,pluginPrompt}=await import("../dist/plugins/session.js");
const {pluginCatalog}=await import("../dist/plugins/catalog.js");
const {packPlugin,unpackPlugin}=await import("../dist/plugins/package.js");
const {TaskRuntime,currentTask}=await import("../dist/llm/runtime.js");
const {getToolDefinitions,getSubAgentToolDefinitions,executeTool}=await import("../dist/llm/tools.js");
const {getProToolDefinitions}=await import("../dist/pro/agents.js");
const {assessToolCall}=await import("../dist/llm/risk.js");
const examples=fileURLToPath(new URL("../examples/plugins/",import.meta.url));
const scope={profile:"standard",cwd:root,role:"main",request:"test"};
let hosts=[];
const open=async(options={})=>{const h=await PluginHost.create({scope,...options});hosts.push(h);return h;};
function fixture(name,source,extra={}){
  const dir=path.join(root,"sources",name);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({type:"module"}));
  fs.writeFileSync(path.join(dir,"neutrino.plugin.json"),JSON.stringify({id:`tests.${name}`,name,version:"1.0.0",apiVersion:1,permissions:["tools.register"],entries:{agent:"agent.js"},...extra}));
  fs.writeFileSync(path.join(dir,"agent.js"),source);return dir;
}
function tool(name="test",body="return 'ok'",effects=[],roles){return `ctx.tools.register({name:${JSON.stringify(name)},description:'fixture',parameters:{type:'object',additionalProperties:false},effects:${JSON.stringify(effects)},${roles?`roles:${JSON.stringify(roles)},`:""}async execute(args,context){${body}}});`;}
function enable(dir){const p=manager.installPlugin(dir);manager.configurePlugin(p.manifest.id,{enabled:true});return p.manifest.id;}
async function close(){await Promise.all(hosts.map(h=>h.dispose()));hosts=[];}
try{
  for(const name of ["function-tools","menus-tabs","composer","cards","theme","skills-prompts"])manager.installPlugin(path.join(examples,name));
  assert.equal(manager.listPlugins().plugins.length,6);
  assert.equal(manager.listPlugins().plugins.some(p=>p.enabled),false,"installation never executes or enables a package");
  manager.configurePlugin("community.text-tools",{enabled:true});
  const h=await open();assert.deepEqual(h.diagnostics,[]);assert.equal(h.tools.size,2);
  const count=h.definitions().find(t=>t.function.description.includes("word_count")).function.name;
  assert.equal(JSON.parse(await h.execute(count,{text:"hello 世界\nplugin"})).words,3);
  await assert.rejects(h.execute(count,{text:9}),/expected string/);
  assert.deepEqual(await h.runCommand("community.text-tools/count",{text:"abc"}),{label:"Text statistics",characters:3,words:1,lines:1});
  const rev=manager.listPlugins().revision;
  assert.throws(()=>manager.configurePlugin("community.text-tools",{config:{label:2}}),/expected string/);
  assert.equal(manager.listPlugins().revision,rev,"invalid config leaves state unchanged");
  manager.configurePlugin("community.text-tools",{config:{label:"Changed"}});
  assert.throws(()=>manager.configurePlugin("community.text-tools",{enabled:true},"standard",undefined,rev),/state changed/);
  assert.equal(JSON.parse(await h.execute(count,{text:"frozen"})).label,"Text statistics","running composition keeps config snapshot");
  const next=await open();assert.equal(JSON.parse(await next.execute(count,{text:"new"})).label,"Changed");
  assert.equal(manager.listPlugins("pro").plugins.find(p=>p.manifest.id==="community.text-tools").enabled,false);
  manager.configurePlugin("community.text-tools",{enabled:false},"standard",root);
  assert.equal(manager.listPlugins("standard",root).plugins.find(p=>p.manifest.id==="community.text-tools").enabled,false,"project override does not affect profile default");
  manager.configurePlugin("community.text-tools",{enabled:true},"standard",root);
  await close();

  // Real task bridge: plugin tools share policy, cancellation, evidence and PTC/Pro vocabulary.
  fs.writeFileSync(path.join(root,"fixture.txt"),"one two\nthree");
  const runtime=new TaskRuntime({request:"Inspect fixture",cwd:root});const approvals=[];
  await runPluginTurn(runtime,scope,async(name,args)=>{approvals.push({name,args});return{approved:true,source:"prompt",reason:"fixture"};},async()=>{
    const tools=getToolDefinitions(),file=tools.find(t=>t.function.description.includes("file_stats")).function.name;
    assert(getProToolDefinitions().some(t=>t.function.name===file));
    const result=await runtime.tool(file,{path:"fixture.txt",reason:"Inspect the local test fixture"},()=>executeTool(file,{path:"fixture.txt",reason:"Inspect the local test fixture"},root));
    assert.equal(JSON.parse(result).words,3);assert.equal(approvals[0].name,"read_file");
    assert(runtime.evidence.some(e=>e.name==="read_file"));
    await runtime.child("subagent","Read a fixture",async()=>{assert(runtime.availableTools(getSubAgentToolDefinitions()).some(t=>t.function.name===file));return null;},{readOnly:true});
    assert.equal(assessToolCall("plugin_fetch",{url:"https://example.invalid"},root).level,"high");
  });runtime.finish("completed");assert.equal(runtime.snapshot().plugins.length,1);
  assert.equal(manager.pluginStorage("community.text-tools","turn-count"),1,"observer executes and persists before teardown");
  const proDir=fixture("pro-role",`export default {activate(ctx){${tool("role","return context.role",[],["main_model"])}}}`);manager.installPlugin(proDir);manager.configurePlugin("tests.pro-role",{enabled:true},"pro");
  const proRuntime=new TaskRuntime({request:"Check Pro role",cwd:root});
  await runPluginTurn(proRuntime,{...scope,profile:"pro"},async()=>({approved:true,source:"prompt",reason:"fixture"}),async()=>{const definition=getProToolDefinitions().find(t=>t.function.description.includes("tests.pro-role"));assert(definition);proRuntime.assertTool(definition.function.name,{});assert.equal(await executeTool(definition.function.name,{},root),"main_model");});proRuntime.finish("completed");

  // Pure tools cannot gain host effects just because their plugin requested a permission.
  const deniedId=enable(fixture("effects",`export default {activate(ctx){${tool("bad","await ctx.fs.write('must-not-exist','bad','Attempt an undeclared write'); return 'bad'")}}}`,{permissions:["tools.register","filesystem.write"]}));
  const bad=await open({broker:async()=>{throw new Error("broker should not be reached");}});
  await assert.rejects(bad.execute(bad.definitions().find(t=>t.function.description.includes("tests.effects")).function.name,{}),/exceeds callback effects/);
  assert.equal(fs.existsSync(path.join(root,"must-not-exist")),false);await close();manager.configurePlugin(deniedId,{enabled:false});

  // Startup failure unwinds earlier registrations; it does not prevent other plugins from loading.
  const broken=enable(fixture("broken",`export default {activate(ctx){${tool()}throw new Error('broken activation')}}`));
  const brokenHost=await open();assert(brokenHost.diagnostics.some(e=>e.includes("broken activation")));assert(!brokenHost.definitions().some(t=>t.function.description.includes("tests.broken")));assert.equal(brokenHost.tools.size,2);await close();manager.configurePlugin(broken,{enabled:false});
  const noNode=enable(fixture("no-node",`export default {activate(ctx){if(typeof process!=='undefined'||typeof fetch!=='undefined')throw Error('globals leaked');${tool()}}}`));
  const safe=await open();assert(!safe.diagnostics.length);await close();manager.configurePlugin(noNode,{enabled:false});

  // A hung callback is killed and cleanup completes within a bound.
  const hung=enable(fixture("hung",`export default {activate(ctx){${tool("spin","while(true){}")}}}`));
  const hungHost=await open({timeoutMs:3000});const spin=hungHost.definitions().find(t=>t.function.description.includes("tests.hung")).function.name;
  await assert.rejects(hungHost.execute(spin,{}),/interrupted|timed out/);await close();manager.configurePlugin(hung,{enabled:false});

  // Native trust is tied to bytes. Restricted children never execute native handlers.
  const nativeDir=fixture("native",`export default {activate(ctx){${tool()}}}`,{runtime:"native"});manager.installPlugin(nativeDir);
  assert.throws(()=>manager.configurePlugin("tests.native",{enabled:true}),/trust/);
  manager.configurePlugin("tests.native",{enabled:true,trustNative:true});
  const nativeRuntime=new TaskRuntime({request:"Check native restrictions",cwd:root});
  await runPluginTurn(nativeRuntime,scope,async()=>({approved:true,source:"prompt",reason:"fixture"}),async()=>{
    const name=nativeRuntime.plugins.definitions().find(t=>t.function.description.includes("tests.native")).function.name;
    await nativeRuntime.child("readonly","Validate native isolation",async()=>{assert.throws(()=>nativeRuntime.assertTool(name,{}),/Native plugins/);assert(!nativeRuntime.availableTools(getSubAgentToolDefinitions()).some(t=>t.function.name===name));},{readOnly:true});
    assert.equal(assessToolCall(name,{},root).level,"high");
  });nativeRuntime.finish("completed");manager.configurePlugin("tests.native",{enabled:false});

  manager.configurePlugin("community.review-skills",{enabled:true});manager.selectProvider("persona","community.review-skills/reviewer","standard");
  const promptHost=await open();const plain=promptHost.composePrompt("BASE","main").text;
  assert(plain.includes("careful code reviewer"));assert(plain.includes("Available skills"));assert(!plain.includes("Give each finding"),"skill body stays lazy");
  const selected=await open({scope:{...scope,request:"/skill community.review-skills/review Inspect"}});assert(selected.composePrompt("BASE","main").text.includes("Give each finding"));
  assert.equal(promptHost.composePrompt("APPROVAL","confirm_model").text,"APPROVAL","plugins do not rewrite the approval reviewer prompt");
  assert.equal(promptHost.composePrompt(plain,"main").text,plain,"prompt contribution is not duplicated on delegation");
  await close();

  manager.configurePlugin("community.workbench",{enabled:true});manager.configurePlugin("community.indigo-theme",{enabled:true});
  const catalog=pluginCatalog("standard",root);assert(catalog.ui.some(u=>u.slot==="workspace.tabs"));assert.equal(catalog.theme["--accent"],"#b8b2ff");
  assert(manager.pluginAsset("community.workbench","panel.html","standard",root).includes("Workspace overview"));
  assert.throws(()=>manager.pluginAsset("community.workbench","../../state.json","standard",root),/declared/);

  // Bundles are reproducible and reject path traversal and corruption.
  const packed=path.join(root,"theme.neutrino-plugin");packPlugin(path.join(examples,"theme"),packed);
  const archive=unpackPlugin(packed);assert.equal(manager.packageIntegrity(archive.directory),manager.packageIntegrity(path.join(examples,"theme")));archive.dispose();
  manager.installPlugin(packed);assert.equal(manager.listPlugins().plugins.find(p=>p.manifest.id==="community.indigo-theme").source,packed);
  const forged=JSON.parse(fs.readFileSync(packed,"utf8"));forged.files.push({path:"../outside",data:"eA=="});fs.writeFileSync(path.join(root,"bad.neutrino-plugin"),JSON.stringify(forged));assert.throws(()=>unpackPlugin(path.join(root,"bad.neutrino-plugin")),/Unsafe/);

  // Update/rollback retains old bytes and frozen instances. Reinstall repairs tampering.
  const updateDir=fixture("update",`export default {activate(ctx){${tool("value","return 'v1'")}}}`);enable(updateDir);
  const v1=await open();const alias=v1.definitions().find(t=>t.function.description.includes("tests.update")).function.name;
  fs.writeFileSync(path.join(updateDir,"agent.js"),`export default {activate(ctx){${tool("value","return 'v2'")}}}`);manager.installPlugin(updateDir);
  assert.equal(await v1.execute(alias,{}),"v1");const v2=await open();assert.equal(await v2.execute(alias,{}),"v2");manager.rollbackPlugin("tests.update");const rollback=await open();assert.equal(await rollback.execute(alias,{}),"v1");await close();manager.configurePlugin("tests.update",{enabled:false});

  // Missing dependencies and incompatible APIs fail before activation.
  const future=fixture("future","",{apiVersion:99});assert.throws(()=>manager.installPlugin(future),/API version/);
  const dependency=fixture("dependent","export default {activate(){}}",{dependencies:{"tests.missing":"^1.0.0"}});manager.installPlugin(dependency);assert.throws(()=>manager.configurePlugin("tests.dependent",{enabled:true}),/dependency/);
  const permissionDir=fixture("permission-update",`export default {activate(ctx){${tool()}}}`);enable(permissionDir);
  enable(fixture("permission-dependent","export default {activate(){}}",{dependencies:{"tests.permission-update":"^1.0.0"}}));
  const permissionManifest=path.join(permissionDir,"neutrino.plugin.json"),permissionData=JSON.parse(fs.readFileSync(permissionManifest,"utf8"));permissionData.permissions.push("storage");fs.writeFileSync(permissionManifest,JSON.stringify(permissionData));manager.installPlugin(permissionDir);
  const upgraded=manager.listPlugins().plugins;assert.equal(upgraded.find(p=>p.manifest.id==="tests.permission-update").enabled,false,"new capabilities require explicit re-enablement");assert.equal(upgraded.find(p=>p.manifest.id==="tests.permission-dependent").enabled,false,"incompatible dependent cannot disable unrelated plugins");
  const corrupted=manager.pluginRecords().find(p=>p.manifest.id==="community.text-tools");fs.appendFileSync(path.join(corrupted.directory,"agent.js"),"\n// tampered\n");assert(manager.listPlugins().plugins.find(p=>p.manifest.id==="community.text-tools").error.includes("changed"));manager.configurePlugin("community.text-tools",{enabled:false});manager.installPlugin(path.join(examples,"function-tools"));manager.configurePlugin("community.text-tools",{enabled:true});const repaired=await open();assert(!repaired.diagnostics.length);await close();
  process.env.NEUTRINO_SAFE_MODE="1";const emergency=await open();assert.equal(emergency.pins.length,0);assert.equal(pluginCatalog().ui.length,0);delete process.env.NEUTRINO_SAFE_MODE;await close();
  console.log("PLUGIN TESTS PASSED: packages, immutable snapshots, sandbox, native trust, scoped tools, approval bridge, skills, prompts, UI, updates and recovery");
}finally{await close();fs.rmSync(root,{recursive:true,force:true});}
