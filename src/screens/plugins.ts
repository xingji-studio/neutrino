import { Screen } from "../terminal/screen.js";
import type { Buffer } from "../terminal/buffer.js";
import type { Key,MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { drawHeader } from "../header.js";
import { drawHint } from "../ui.js";
import { configurePlugin,installPlugin,listPlugins,removePlugin,rollbackPlugin,selectProvider } from "../plugins/manager.js";
import { invalidateTuiPlugins,terminalUI } from "../plugins/terminal.js";
import { sanitizeText } from "../sanitize.js";
import type { OwnedUI } from "../plugins/host.js";
import type { Profile,PublicPlugin } from "../plugins/types.js";

export class PluginViewScreen extends Screen {
  private offset=0;
  constructor(private item:OwnedUI){super();}
  onKey(key:Key):void {if(key.name==="escape"||key.name==="backspace"){this.app.popScreen();return;}if(key.name==="down"||key.name==="pagedown")this.offset++;if(key.name==="up"||key.name==="pageup")this.offset=Math.max(0,this.offset-1);this.app.render();}
  onMouse(ev:MouseEvent):void {if(ev.type==="click"&&ev.button===2)this.app.popScreen();}
  render(buf:Buffer):void {drawHeader(buf,this.app.state);buf.writeText(2,3,this.item.title,{fg:C.accent,bold:true});const text=sanitizeText(this.item.text??"This view is available in the browser. / 此视图可在浏览器中打开。");text.split("\n").slice(this.offset,this.offset+Math.max(1,buf.height-8)).forEach((line,i)=>buf.writeText(2,5+i,line.slice(0,Math.max(1,buf.width-4)),{fg:C.white}));drawHint(buf,buf.height-2,"Esc back · ↑/↓ scroll");}
}
export class PluginsScreen extends Screen {
  private profile:Profile="standard";
  private plugins:PublicPlugin[]=[];
  private index=0;
  private detail=false;
  private editing:"install"|"config"|null=null;
  private draft="";
  private message="";
  private trustPending=false;
  onActivate():void {this.refresh();}
  private refresh():void {try{this.plugins=listPlugins(this.profile).plugins;this.index=Math.min(this.index,Math.max(0,this.plugins.length-1));invalidateTuiPlugins();}catch(e){this.message=(e as Error).message;}}
  private action(run:()=>void):void {try{run();this.message="Saved / 已保存";this.refresh();}catch(e){this.message=(e as Error).message;}this.app.render();}
  onKey(key:Key):void {
    if(this.editing) {
      if(key.name==="escape"){this.editing=null;this.app.render();return;}
      if(key.name==="return"){const type=this.editing;this.editing=null;this.action(()=>{if(type==="install")installPlugin(this.draft);else configurePlugin(this.plugins[this.index].manifest.id,{config:JSON.parse(this.draft)},this.profile);});return;}
      if(key.name==="backspace")this.draft=this.draft.slice(0,-1);
      else if(!key.ctrl&&!key.meta&&key.name.length===1)this.draft+=key.name;
      this.app.render();return;
    }
    if(key.name==="escape"||key.name==="backspace"){if(this.detail){this.detail=false;this.trustPending=false;this.app.render();}else this.app.popScreen();return;}
    if(key.name==="tab"){this.profile=this.profile==="standard"?"pro":"standard";this.refresh();this.app.render();return;}
    if(key.name==="up"){this.index=Math.max(0,this.index-1);this.app.render();return;}
    if(key.name==="down"){this.index=Math.min(this.plugins.length-1,this.index+1);this.app.render();return;}
    if(key.name==="i"){this.editing="install";this.draft="";this.app.render();return;}
    if(key.name==="m"){const items=terminalUI().filter(u=>["app.menu","workspace.tabs","settings.sections"].includes(u.slot));if(items.length)this.app.pushScreen(new PluginViewScreen({ ...items[0],text:items.map(i=>`${i.title}\n${i.text??""}`).join("\n\n") }));return;}
    const p=this.plugins[this.index];if(!p)return;
    if(key.name==="return"){this.detail=!this.detail;this.app.render();return;}
    if(key.name==="e"){
      if(!p.enabled&&p.manifest.runtime==="native"&&p.manifest.entries?.agent){this.trustPending=true;this.message="Native plugin can execute unrestricted local code. Press Y to trust this exact revision, Esc to cancel.";this.app.render();return;}
      this.action(()=>configurePlugin(p.manifest.id,{enabled:!p.enabled},this.profile));return;
    }
    if(key.name==="y"&&this.trustPending){this.trustPending=false;this.action(()=>configurePlugin(p.manifest.id,{enabled:true,trustNative:true},this.profile));return;}
    if(key.name==="c"){this.editing="config";this.draft=JSON.stringify(p.config);this.app.render();return;}
    if(key.name==="u"){this.action(()=>{installPlugin(p.source);});return;}
    if(key.name==="r"){this.action(()=>rollbackPlugin(p.manifest.id));return;}
    if(key.name==="d"){this.action(()=>removePlugin(p.manifest.id));return;}
    if(key.name==="v"){
      const replacements=(p.manifest.contributes?.ui??[]).filter(u=>["chat.composer","chat.message.renderer","chat.card.plan","chat.card.tool"].includes(u.slot));
      this.action(()=>{for(const u of replacements)selectProvider(u.slot,`${p.manifest.id}/${u.id}`,this.profile);for(const prompt of p.manifest.contributes?.prompts??[])if(prompt.replace)selectProvider("persona",`${p.manifest.id}/${prompt.id}`,this.profile);});
    }
  }
  onPaste(text:string):void {if(this.editing){this.draft+=text;this.app.render();}}
  onMouse(ev:MouseEvent):void {if(ev.type==="click"&&ev.button===2)this.app.popScreen();else if(ev.type==="click"&&ev.button===0&&ev.y>=5){this.index=Math.min(this.plugins.length-1,Math.max(0,ev.y-5));this.app.render();}}
  render(buf:Buffer):void {
    drawHeader(buf,this.app.state);buf.writeText(2,2,`Plugins / 插件 · ${this.profile}`,{fg:C.accent,bold:true});
    let y=4;
    if(this.editing){buf.writeText(2,y++,this.editing==="install"?"Local plugin directory / 本机插件目录":"Configuration JSON / 配置 JSON",{fg:C.white});buf.writeText(2,y++,this.draft.slice(-Math.max(1,buf.width-5)),{fg:C.accent});}
    else if(this.detail&&this.plugins[this.index]){
      const p=this.plugins[this.index];const lines=[p.manifest.name,`${p.manifest.id} @ ${p.manifest.version}`,p.manifest.description??"",`Runtime: ${p.manifest.runtime??"sandbox"}`,`Permissions: ${(p.manifest.permissions??[]).join(", ")}`,`Source: ${p.source}`,`Integrity: ${p.integrity}`,p.error??"",JSON.stringify(p.config)];
      for(const line of lines)buf.writeText(2,y++,sanitizeText(line,{singleLine:true}).slice(0,buf.width-4),{fg:C.white});
    }else{
      if(!this.plugins.length)buf.writeText(2,5,"No plugins. Press I to install a local directory. / 按 I 安装本机插件。",{fg:C.dim});
      const start=Math.max(0,this.index-Math.max(1,buf.height-12)+1);
      this.plugins.slice(start,start+Math.max(1,buf.height-12)).forEach((p,i)=>buf.writeText(2,5+i,`${i+start===this.index?"›":" "} ${p.enabled?"●":"○"} ${p.manifest.name}  ${p.manifest.version}${p.error?" !":""}`.slice(0,buf.width-4),{fg:i+start===this.index?C.accent:C.white,bold:i+start===this.index}));
    }
    if(this.message)buf.writeText(2,buf.height-4,sanitizeText(this.message,{singleLine:true}).slice(0,buf.width-4),{fg:C.amber});
    drawHint(buf,buf.height-3,"↑/↓ select · Enter details · E enable/disable · I install · C config · U update");
    drawHint(buf,buf.height-2,"R rollback · D remove · V select providers · M extensions · Tab profile · Esc back");
  }
}
