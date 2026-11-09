import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configurePlugin, installPlugin, listPlugins, removePlugin, rollbackPlugin, selectProvider } from "./manager.js";
import { PluginHost } from "./host.js";
import type { Profile } from "./types.js";
import { packPlugin } from "./package.js";

export async function runPluginCLI(args:string[]):Promise<void> {
  let profile:Profile="standard",cwd:string|undefined,trustNative=false;
  const values:string[]=[];
  for(let i=0;i<args.length;i++) {
    if(args[i]==="--profile") { const p=args[++i]; if(p!=="standard"&&p!=="pro") throw new Error("Profile must be standard or pro"); profile=p; }
    else if(args[i]==="--workspace") { const value=args[++i];if(!value||value.startsWith("--"))throw new Error("--workspace requires a directory");cwd=path.resolve(value); }
    else if(args[i]==="--trust-native") trustNative=true;
    else values.push(args[i]);
  }
  const [action,id,extra]=values;
  const print=(v:unknown)=>process.stdout.write((typeof v==="string"?v:JSON.stringify(v,null,2))+"\n");
  if(!action||action==="help"||action==="--help") { print(`Plugin API v1\n\nneutrino plugin list [--profile standard|pro] [--workspace <path>]\nneutrino plugin inspect <id>\nneutrino plugin install <local-directory-or-bundle>\nneutrino plugin enable <id> [--trust-native]\nneutrino plugin disable <id>\nneutrino plugin config <id> '<JSON object>'\nneutrino plugin update <id>\nneutrino plugin rollback <id>\nneutrino plugin remove <id>\nneutrino plugin provider <slot> <plugin-id/contribution-id|default>\nneutrino plugin doctor\nneutrino plugin create <directory>\nneutrino plugin pack <directory> <output.neutrino-plugin>\nneutrino --safe-mode --no-web\n\nInstall is separate from enable. Native plugins execute unrestricted local code.\n`); return; }
  if(action==="list") { print(listPlugins(profile,cwd)); return; }
  if(action==="pack") { if(!id||!extra)throw new Error("Usage: neutrino plugin pack <directory> <output.neutrino-plugin>");print(packPlugin(path.resolve(id),path.resolve(extra)));return; }
  if(action==="install") { if(!id) throw new Error("Missing source directory"); print(installPlugin(path.resolve(id))); return; }
  if(action==="enable"||action==="disable") { configurePlugin(id,{ enabled:action==="enable",trustNative },profile,cwd); print(`${id}: ${action}d`); return; }
  if(action==="config") { configurePlugin(id,{ config:JSON.parse(extra ?? "{}") },profile,cwd); print("Configuration saved"); return; }
  if(action==="remove") { removePlugin(id); print("Plugin removed; immutable files retained for running tasks"); return; }
  if(action==="rollback") { rollbackPlugin(id); print("Previous package revision restored"); return; }
  if(action==="provider") { selectProvider(id,extra==="default"?"":extra,profile); print("Provider selected"); return; }
  if(action==="update"||action==="inspect") { const p=listPlugins(profile,cwd).plugins.find(p=>p.manifest.id===id); if(!p) throw new Error("Unknown plugin"); print(action==="update"?installPlugin(p.source):p); return; }
  if(action==="doctor") {
    const host=await PluginHost.create({ scope:{ profile,cwd:cwd??process.cwd(),role:"main" } });
    try { print({ plugins:host.pins,tools:host.definitions(),commands:[...host.commands.keys()],errors:host.diagnostics }); if(host.diagnostics.length) process.exitCode=1; } finally { await host.dispose(); }
    return;
  }
  if(action==="create") {
    if(!id) throw new Error("Missing target directory");
    const dir=path.resolve(id); if(fs.existsSync(dir)) throw new Error("Target directory already exists");
    const source=fileURLToPath(new URL("../../examples/plugins/function-tools/",import.meta.url));
    fs.cpSync(source,dir,{ recursive:true }); print(`Created ${dir}. Edit neutrino.plugin.json and agent.js, then install the directory.`); return;
  }
  throw new Error(`Unknown plugin command ${action}`);
}
