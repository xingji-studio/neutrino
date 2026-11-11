// Plugin views are opaque-origin iframes. The host owns permissions and conversation state.
export function createPluginUI(host) {
  const zh = () => String(document.documentElement.lang).startsWith("zh");
  const t = (en,cn) => zh() ? cn : en;
  const node = (tag,className,text) => { const el=document.createElement(tag); if(className) el.className=className; if(text!==undefined) el.textContent=text; return el; };
  const button = (text,action,className="control") => { const el=node("button",className,text); el.type="button"; el.addEventListener("click",action); return el; };
  // getRandomValues also works on the LAN HTTP console, where randomUUID is unavailable.
  const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");
  let catalog={ ui:[],theme:{},skills:[],providers:{},errors:[] }, listing=null, scopeWorkspace=false;
  const identityOf=c=>`${host.profile}:${c.identity||""}:${c.cwd||""}`;
  let contextKey=identityOf(host.context()), catalogScope=null, activeTab="", selectedTab=null, disposed=false, timer=null, syncTimer=null;
  let lastDraft="",draftRevision=0,loading=false;
  let chromeSignature="";
  const frames=new Map(), appliedTheme=new Map(), failed=new Set(), assets=new Map();
  const dialog=node("dialog","sheet-dialog plugin-dialog"); dialog.setAttribute("aria-label","Plugins / 插件");
  const sheet=node("div","sheet"), header=node("header","sheet-header"), title=node("h2","","Plugins / 插件");
  const feedback=node("p","form-feedback"); feedback.setAttribute("role","status");
  const body=node("div","sheet-body plugin-manager-body");
  header.append(title,button("×",()=>dialog.close(),"icon-btn")); sheet.append(header,body,feedback); dialog.append(sheet); document.body.append(dialog);
  header.querySelector("button").setAttribute("aria-label","Close plugins / 关闭插件");
  const open=button("◈ "+t("Plugins","插件"),()=>{ if(!dialog.open)dialog.showModal(); void loadManager(); },"workspace-button plugin-open");
  open.id="plugins-open"; document.querySelector(".sidebar-tools")?.append(open);
  const menu=node("div","plugin-menu"),tabs=node("nav","plugin-tabs"),sidebar=node("div","plugin-sidebar"),toolbar=node("div","plugin-toolbar"),headerActions=node("div","plugin-header-actions"),panel=node("section","plugin-panel hidden");
  tabs.setAttribute("aria-label","Plugin tabs / 插件选项卡");
  document.querySelector(".sidebar-tools")?.append(menu);
  document.getElementById("sidebar")?.append(sidebar);
  document.getElementById("main-header")?.after(tabs,panel);
  document.getElementById("main-header")?.append(headerActions);
  document.querySelector(".composer-inner")?.prepend(toolbar);

  function scopeQuery(forManager=false) { const cwd=host.context().cwd; return cwd&&(!forManager||scopeWorkspace)?`?cwd=${encodeURIComponent(cwd)}`:""; }
  async function request(path,body) { const response=await host.api(path,body===undefined?undefined:{ method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body) }); const value=await response.json(); if(!response.ok)throw new Error(value.error||`HTTP ${response.status}`); return value; }
  function error(e) { feedback.textContent=e.message; feedback.classList.add("error"); }
  async function mutate(value) {
    try { feedback.textContent=""; listing=await request(`/api/plugins${scopeQuery(true)}`,{...value,revision:listing?.revision}); assets.clear(); failed.clear(); renderManager(); await refresh(true); }
    catch(e) { error(e); }
  }
  async function loadManager() { try { listing=await request(`/api/plugins${scopeQuery(true)}`); renderManager(); } catch(e){error(e);} }
  function field(label,input) { const el=node("label","plugin-field"); el.append(node("span","",label),input); return el; }
  function renderManager() {
    if(!listing)return;
    body.replaceChildren();
    const scope=node("select"); scope.append(new Option(t("This profile","当前模式"),"profile"),new Option(t("Current project","当前项目"),"workspace")); scope.value=scopeWorkspace?"workspace":"profile";
    scope.addEventListener("change",()=>{scopeWorkspace=scope.value==="workspace";void loadManager();});
    if(!host.context().cwd)scope.options[1].disabled=true;
    body.append(field(t("Enable and configure for","启用与配置范围"),scope));
    if(listing.safeMode)body.append(node("p","plugin-warning",t("Safe mode is active. External plugins are not loaded.","安全模式已开启，外部插件不会加载。")));
    const install=node("form","plugin-install"),source=node("input","path-input");source.placeholder=t("Plugin directory on this computer","此电脑上的插件目录");source.setAttribute("aria-label",source.placeholder);source.required=true;
    const installButton=button(t("Install","安装"),()=>{},"control primary");installButton.type="submit";
    install.addEventListener("submit",e=>{e.preventDefault();void mutate({action:"install",source:source.value});});install.append(source,installButton);body.append(install);
    body.append(node("p","settings-note",t("Installation is shared. Enablement and configuration follow the selected scope. Running turns keep their current versions.","安装包共用，启用状态和配置按所选范围保存；正在执行的回合继续使用原版本。")));
    const search=node("input","path-input");search.placeholder=t("Filter plugins…","筛选插件…");search.setAttribute("aria-label",search.placeholder);body.append(search);
    const cards=node("div","plugin-list");body.append(cards);
    const draw=()=>{
      cards.replaceChildren();
      for(const p of listing.plugins.filter(p=>`${p.manifest.id} ${p.manifest.name} ${p.manifest.description||""}`.toLowerCase().includes(search.value.toLowerCase()))) {
        const m=p.manifest,card=node("article","plugin-card"),heading=node("div","plugin-card-heading");
        heading.append(node("strong","",m.name),node("span","plugin-badge",p.enabled?t("Enabled","已启用"):t("Disabled","已停用")));card.append(heading,node("code","",`${m.id} · ${m.version} · API ${m.apiVersion}`),node("p","",m.description||""));
        card.append(node("p","settings-note",`${(m.categories||[]).join(" / ")} · ${m.runtime||"sandbox"}`),node("p","settings-note",t("Permissions: ","权限：")+(m.permissions||[]).join(", ")));
        if(p.error)card.append(node("p","plugin-warning",p.error));
        let trust=null;
        if(m.runtime==="native"&&m.entries?.agent&&!p.enabled) {
          trust=node("input");trust.type="checkbox";
          card.append(field(t("Trust this exact native package. It can execute unrestricted local code.","信任此版本的原生插件：它能运行不受限制的本机代码。"),trust));
        }
        const actions=node("div","plugin-actions");
        actions.append(button(p.enabled?t("Disable","停用"):t("Enable","启用"),()=>{
          if(trust&&!trust.checked){error(new Error(t("Select native trust before enabling.","启用前请勾选原生代码信任。")));return;}
          void mutate({action:"configure",id:m.id,patch:{enabled:!p.enabled,trustNative:Boolean(trust?.checked)}});
        }),button(t("Update","更新"),()=>void mutate({action:"update",id:m.id})));
        if(p.rollback)actions.append(button(t("Roll back","回滚"),()=>void mutate({action:"rollback",id:m.id})));
        actions.append(button(t("Remove","卸载"),()=>void mutate({action:"remove",id:m.id})));card.append(actions);
        if(m.configuration) {
          const details=node("details"),summary=node("summary","",t("Configuration","配置")),form=node("form","plugin-config");details.append(summary,form);
          const inputs=[];
          for(const [key,schema] of Object.entries(m.configuration.properties||{})) {
            let input;
            if(schema.enum){input=node("select");for(const value of schema.enum)input.append(new Option(String(value),JSON.stringify(value)));input.value=JSON.stringify(p.config[key]??schema.default??schema.enum[0]);}
            else if(schema.type==="boolean"){input=node("input");input.type="checkbox";input.checked=Boolean(p.config[key]??schema.default);}
            else if(["array","object"].includes(schema.type)){input=node("textarea");input.value=JSON.stringify(p.config[key]??schema.default??(schema.type==="array"?[]:{}),null,2);}
            else {input=node("input","path-input");input.type=["number","integer"].includes(schema.type)?"number":"text";input.value=String(p.config[key]??schema.default??"");if(schema.minimum!==undefined)input.min=schema.minimum;if(schema.maximum!==undefined)input.max=schema.maximum;}
            input.setAttribute("aria-label",schema.title||key);form.append(field(schema.title||key,input));if(schema.description)form.append(node("small","settings-note",schema.description));inputs.push({key,schema,input});
          }
          const save=button(t("Save configuration","保存配置"),()=>{},"control primary");save.type="submit";form.append(save);
          form.addEventListener("submit",e=>{e.preventDefault();try{const config={...p.config};for(const {key,schema,input} of inputs){if(schema.enum)config[key]=JSON.parse(input.value);else if(schema.type==="boolean")config[key]=input.checked;else if(["number","integer"].includes(schema.type))config[key]=Number(input.value);else if(["array","object"].includes(schema.type))config[key]=JSON.parse(input.value);else config[key]=input.value;}void mutate({action:"configure",id:m.id,patch:{config}});}catch(e){error(e);}});card.append(details);
        }
        const inspect=node("details"),inspectTitle=node("summary","",t("Package details","包详情")),pre=node("pre","plugin-details",JSON.stringify({source:p.source,integrity:p.integrity,manifest:m},null,2));inspect.append(inspectTitle,pre);card.append(inspect);cards.append(card);
      }
      if(!cards.childNodes.length)cards.append(node("p","settings-note",t("No plugins installed. Start with examples/plugins in the repository.","尚未安装插件，可从仓库 examples/plugins 中的示例开始。")));
    };
    search.addEventListener("input",draw);draw();
    const providers=node("div","plugin-providers");providers.append(node("strong","",t("Component providers","组件提供者")));
    for(const slot of ["chat.composer","chat.message.renderer","chat.card.plan","chat.card.tool","persona"]) {
      const choices=slot==="persona"?(catalog.prompts||[]).filter(p=>p.replace).map(p=>({key:p.id,title:p.id})):catalog.ui.filter(u=>u.slot===slot);
      const select=node("select");select.append(new Option(t("Built in","内置"),""));for(const u of choices)select.append(new Option(u.title,u.key));select.value=listing.providers[slot]||"";
      select.addEventListener("change",()=>void mutate({action:"provider",slot,provider:select.value}));providers.append(field(slot,select));
    }
    body.append(providers,node("p","settings-note",t("Disable a broken UI plugin here, or start neutrino --safe-mode --no-web. See docs/plugins/README.md for the SDK and tutorials.","界面插件异常时可在此停用，或使用 neutrino --safe-mode --no-web 启动。SDK 与教程见 docs/plugins/README.md。")));
    const current=host.context();if(current.pluginPrompt||current.pluginErrors?.length){const details=node("details"),summary=node("summary","",t("Current turn diagnostics","当前回合诊断"));details.append(summary,node("pre","plugin-details",JSON.stringify({prompt:current.pluginPrompt,errors:current.pluginErrors},null,2)));body.append(details);}
    for(const item of contributions().filter(u=>u.slot==="settings.sections"&&(!u.platforms||u.platforms.includes("web")))){const section=node("section","plugin-card");section.append(node("strong","",item.title));if(item.view||item.entry)void mount(item,section);else section.append(node("p","",item.text||""));body.append(section);}
  }

  function draft() { const text=host.getDraft();if(text!==lastDraft){lastDraft=text;draftRevision++;}return{text,revision:draftRevision}; }
  function setDraft(value) {const current=draft();if(!value||typeof value.text!=="string"||value.text.length>200000)throw new Error("Invalid draft");if(value.expectedRevision!==current.revision)throw new Error("Draft changed; read it again before editing");host.setDraft(value.text);return draft();}
  function viewContext(item,extra={}) {
    const c=host.context(),canRead=item.permissions.includes("conversation.read");
    return {pluginId:item.pluginId,id:item.id,title:item.title,profile:host.profile,...(canRead?extra:{}),...(canRead?{cwd:c.cwd}: {})};
  }
  function removeFrame(key) {const frame=frames.get(key);if(!frame)return;clearTimeout(frame.timer);frame.node.remove();if(frame.restore)frame.restore();frames.delete(key);}
  function disposeViews(){for(const key of [...frames.keys()])removeFrame(key);}
  async function asset(item,file) {const key=`${item.pluginId}/${file}/${scopeQuery()}`;if(!assets.has(key))assets.set(key,request(`/api/plugins/asset${scopeQuery()}${scopeQuery()?"&":"?"}id=${encodeURIComponent(item.pluginId)}&file=${encodeURIComponent(file)}`).then(r=>r.body));return assets.get(key);}
  function encoded(value){return JSON.stringify(value).replace(/</g,"\\u003c");}
  async function mount(item,target,extra={},fallback=null) {
    const key=`${item.key}:${target.dataset.pluginTarget||(target.dataset.pluginTarget=randomToken())}`;
    if(failed.has(key))return;
    if(frames.has(key)){const f=frames.get(key);f.context=viewContext(item,extra);f.node.contentWindow?.postMessage({neutrino:f.nonce,type:"context",context:f.context},"*");return;}
    const iframe=node("iframe","plugin-frame");iframe.title=item.title;iframe.setAttribute("sandbox","allow-scripts");iframe.setAttribute("referrerpolicy","no-referrer");iframe.style.height=`${item.height||160}px`;
    const nonce=randomToken(), frame={node:iframe,nonce,item,target,context:viewContext(item,extra),ready:false,timer:null,restore:null,identity:contextKey,rateAt:Date.now(),rate:0};frames.set(key,frame);
    const fail=message=>{failed.add(key);removeFrame(key);host.notice?.(`${item.title}: ${message}`);};frame.fail=fail;
    if(fallback){frame.restore=()=>{fallback.style.display="";};}
    target.append(iframe);
    try {
      const html=item.view?await asset(item,item.view):"<div id=\"plugin-root\"></div>";
      const entry=item.entry?await asset(item,item.entry):null;
      if(!frames.has(key)||frame.identity!==contextKey)return;
      const boot=`(() => { const nonce=${encoded(nonce)}, pending=new Map(), listeners=new Map();let id=0,context=${encoded(frame.context)};
        const request=(op,args)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error('Plugin request timed out'));},30000);pending.set(key,{resolve,reject,timer});parent.postMessage({neutrino:nonce,type:'request',id:key,op,args},'*');});
        const api={get context(){return context},request,composer:{read:()=>request('composer.read'),write:args=>request('composer.write',args),submit:()=>request('composer.submit')},conversation:{read:()=>request('conversation.read')},configuration:{read:()=>request('configuration.read'),write:args=>request('configuration.write',args)},commands:{execute:(name,args={})=>request('commands.execute',{name,args})},view:{resize:height=>request('view.resize',{height})},on:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name).delete(fn);}};
        Object.defineProperty(window,'neutrino',{value:Object.freeze(api)});
        addEventListener('message',event=>{if(event.source!==parent||event.data?.neutrino!==nonce)return;const m=event.data;if(m.type==='context'){context=m.context;for(const fn of listeners.get('context.changed')||[])try{fn(context)}catch(e){}}else if(m.type==='response'){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.value);}}});
        addEventListener('error',event=>parent.postMessage({neutrino:nonce,type:'failure',error:event.message},'*'));
        addEventListener('unhandledrejection',event=>parent.postMessage({neutrino:nonce,type:'failure',error:String(event.reason)},'*'));
        addEventListener('DOMContentLoaded',async()=>{try{${entry?`const source=${encoded(entry)};const module=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));await (module.default?.mount||module.mount)?.(api,document.getElementById('plugin-root')||document.body);`:""}parent.postMessage({neutrino:nonce,type:'ready'},'*');}catch(e){parent.postMessage({neutrino:nonce,type:'failure',error:String(e)},'*');}});
      })();`;
      const prefix=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><script>${boot.replace(/<\/script/gi,"<\\/script")}<\/script>`;
      iframe.srcdoc=/<head[^>]*>/i.test(html)?html.replace(/<head[^>]*>/i,m=>m+prefix):prefix+html;
      frame.timer=setTimeout(()=>fail(t("View did not become ready","视图加载超时")),10000);
      frame.fallback=fallback;
    }catch(e){fail(e.message);}
  }
  async function onMessage(event) {
    const f=[...frames.values()].find(f=>f.node.contentWindow===event.source&&event.data?.neutrino===f.nonce);
    if(!f||event.origin!=="null"||f.identity!==contextKey)return;
    const m=event.data;
    if(m.type==="ready"){f.ready=true;clearTimeout(f.timer);if(f.fallback)f.fallback.style.display="none";return;}
    if(m.type==="failure"){f.fail(String(m.error));return;}
    if(m.type!=="request")return;
    if(Date.now()-f.rateAt>1000){f.rateAt=Date.now();f.rate=0;}if(++f.rate>100){f.fail("Plugin message rate exceeded");return;}
    const requirePermission=p=>{if(!f.item.permissions.includes(p))throw new Error(`Plugin requires ${p}`);};
    try {
      let value;
      if(m.op==="composer.read"){requirePermission("composer.read");value=draft();}
      else if(m.op==="composer.write"){requirePermission("composer.write");value=setDraft(m.args);}
      else if(m.op==="composer.submit"){requirePermission("composer.submit");value=await host.submit();draft();}
      else if(m.op==="conversation.read"){requirePermission("conversation.read");value=host.context();}
      else if(m.op==="configuration.read"||m.op==="configuration.write"){
        requirePermission("ui.contribute");const path=`/api/plugins${scopeQuery()}`;const state=await request(path),plugin=state.plugins.find(p=>p.manifest.id===f.item.pluginId);if(!plugin)throw new Error("Plugin is unavailable");
        if(m.op==="configuration.read")value={values:plugin.config,schema:plugin.manifest.configuration,revision:state.revision};
        else{if(m.args?.expectedRevision!==state.revision)throw new Error("Configuration changed; read it again");const updated=await request(path,{action:"configure",id:f.item.pluginId,revision:state.revision,patch:{config:m.args.values}});value={revision:updated.revision};void refresh(true);}
      }
      else if(m.op==="commands.execute"){requirePermission("commands.register");if(!/^[a-z][a-z0-9_-]{0,39}$/.test(m.args?.name))throw new Error("Invalid command name");value=await host.command(`${f.item.pluginId}/${m.args.name}`,m.args.args||{});}
      else if(m.op==="view.resize"){const h=Number(m.args?.height);if(!Number.isFinite(h))throw new Error("Invalid view height");f.node.style.height=`${Math.min(1200,Math.max(40,h))}px`;value=true;}
      else throw new Error("Unsupported plugin operation");
      event.source?.postMessage({neutrino:f.nonce,type:"response",id:m.id,value:value??null},"*");
    }catch(e){event.source?.postMessage({neutrino:f.nonce,type:"response",id:m.id,error:e.message},"*");}
  }
  window.addEventListener("message",onMessage);
  const matches=(item,message)=>!item.match||((!item.match.role||item.match.role===message?.role)&&(!item.match.tool||item.match.tool===message?.name));
  function runItem(item){if(item.command){void host.command(`${item.pluginId}/${item.command}`,{}).catch(e=>host.notice?.(e.message));}else if(item.insert!==undefined){const d=draft();setDraft({text:d.text+item.insert,expectedRevision:d.revision});}else{activeTab=item.key;selectedTab=item;renderPanel();}}
  function renderPanel(){panel.replaceChildren();panel.classList.toggle("hidden",!selectedTab);if(!selectedTab)return;const close=button(t("Close panel","关闭面板"),()=>{selectedTab=null;activeTab="";renderPanel();});panel.append(close);const target=node("div","plugin-panel-content");panel.append(target);if(selectedTab.view||selectedTab.entry)void mount(selectedTab,target);else target.textContent=selectedTab.text||selectedTab.title;}
  function contributions(){
    const merged=new Map(catalog.ui.map(u=>[u.key,u]));
    for(const item of host.context().pluginUI||[])if(catalog.permissions?.[item.pluginId]?.includes("ui.contribute")&&item.key===`${item.pluginId}/${item.id}`)merged.set(item.key,{...item,permissions:catalog.permissions[item.pluginId],entry:catalog.entries?.[item.pluginId]});
    return [...merged.values()].filter(u=>!u.platforms||u.platforms.includes("web")).sort((a,b)=>(a.order||0)-(b.order||0)||a.key.localeCompare(b.key));
  }
  function rebuildChrome(){
    for(const target of [menu,tabs,sidebar,toolbar,headerActions])target.replaceChildren();
    const targets={"app.menu":menu,"workspace.tabs":tabs,"sidebar.footer":sidebar,"chat.composer.toolbar":toolbar,"chat.header.actions":headerActions};
    const items=contributions();chromeSignature=JSON.stringify(items.filter(u=>targets[u.slot]));
    for(const item of items){const target=targets[item.slot];if(!target)continue;if(item.slot==="sidebar.footer"&&item.text){target.append(node("p","settings-note",item.text));}else target.append(button(item.title,()=>runItem(item)));}
    if(catalog.skills.length){const select=node("select","plugin-skill-select");select.setAttribute("aria-label",t("Skills","技能"));select.append(new Option(t("Add skill…","加入技能…"),""));for(const s of catalog.skills)select.append(new Option(s.id,s.id));select.addEventListener("change",()=>{if(select.value){const d=draft();setDraft({text:`/skill ${select.value}\n${d.text}`,expectedRevision:d.revision});select.value="";}});toolbar.append(select);}
    if(selectedTab){selectedTab=items.find(u=>u.key===activeTab)||null;renderPanel();}
  }
  function replacement(item,target,extra={}) {
    if(!target||!item||(!item.view&&!item.entry))return;
    let content=target.querySelector(":scope > .plugin-fallback");
    if(!content){content=node("div","plugin-fallback");while(target.firstChild)content.append(target.firstChild);target.append(content);}
    void mount(item,target,extra,content);
  }
  function sync(){
    if(disposed)return;
    const openLabel="◈ "+t("Plugins","插件");if(open.textContent!==openLabel)open.textContent=openLabel;
    const c=host.context(),key=identityOf(c);
    if(key!==contextKey){contextKey=key;disposeViews();failed.clear();for(const target of [menu,tabs,sidebar,toolbar,headerActions])target.replaceChildren();selectedTab=null;activeTab="";panel.replaceChildren();panel.classList.add("hidden");void refresh(true);return;}
    if(catalogScope!==scopeQuery())return;
    for(const [key,f] of frames)if(!f.node.isConnected)removeFrame(key);
    const ui=contributions();if(JSON.stringify(ui.filter(u=>["app.menu","workspace.tabs","sidebar.footer","chat.composer.toolbar","chat.header.actions"].includes(u.slot)))!==chromeSignature)rebuildChrome();
    const provider=slot=>ui.find(u=>u.slot===slot&&catalog.providers[slot]===u.key);
    const composer=provider("chat.composer"),input=document.getElementById("input");
    if(composer&&input){const target=input.parentElement;if(target){let view=target.querySelector(":scope > .plugin-composer-target");if(!view){view=node("div","plugin-composer-target");target.insertBefore(view,input);}void mount(composer,view,{},input);}}
    if(!composer&&input){input.style.display="";document.querySelector(".plugin-composer-target")?.remove();}
    const plan=document.getElementById("plan-card");if(plan&&!plan.classList.contains("hidden"))replacement(provider("chat.card.plan"),plan,{plan:c.plan});
    for(const article of document.querySelectorAll("article.message[data-plugin-message]")) {
      const index=Number(article.dataset.pluginMessage),message=index<0?{role:"assistant",content:c.streamingContent||""}:c.messages?.filter(m=>m.role!=="system")[index];
      const tool=message?.role==="tool"?provider("chat.card.tool"):null;
      const item=tool||provider("chat.message.renderer");if(item&&matches(item,message))replacement(item,article,{message});
      for(const action of ui.filter(u=>u.slot==="chat.message.actions"&&matches(u,message)))if(!article.querySelector(`[data-plugin-action="${action.key}"]`)){const b=button(action.title,()=>runItem(action));b.dataset.pluginAction=action.key;article.append(b);}
    }
    for(const f of frames.values())if(f.ready){const extra=f.context.message?{message:f.context.message}:f.context.plan?{plan:c.plan}:{};f.node.contentWindow?.postMessage({neutrino:f.nonce,type:"context",context:viewContext(f.item,extra)},"*");}
  }
  async function refresh(force=false){
    if(loading||disposed)return;loading=true;
    const requestedScope=scopeQuery();let stale=false;
    try{
      const next=await request(`/api/plugins/catalog${requestedScope}`);
      if(disposed)return;
      if(requestedScope!==scopeQuery()){stale=true;return;}
      catalogScope=requestedScope;
      if(force||JSON.stringify(next)!==JSON.stringify(catalog)){
        disposeViews();failed.clear();catalog=next;
        for(const [key,old] of appliedTheme){if(old)document.documentElement.style.setProperty(key,old);else document.documentElement.style.removeProperty(key);}appliedTheme.clear();
        for(const [key,value] of Object.entries(catalog.theme)){appliedTheme.set(key,document.documentElement.style.getPropertyValue(key));document.documentElement.style.setProperty(key,value);}
        rebuildChrome();
      }
    }catch(e){if(dialog.open)error(e);}finally{loading=false;if(stale&&!disposed)void refresh(true);else sync();}
  }
  const observer=new MutationObserver(()=>{clearTimeout(syncTimer);syncTimer=setTimeout(sync,40);});observer.observe(document.getElementById("app"),{childList:true,subtree:true});
  timer=setInterval(()=>void refresh(),5000);void refresh(true);
  return { sync,open:()=>open.click(),dispose(){disposed=true;clearInterval(timer);clearTimeout(syncTimer);observer.disconnect();window.removeEventListener("message",onMessage);disposeViews();dialog.remove();} };
}
