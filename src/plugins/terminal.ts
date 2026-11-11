import { C, type RGB } from "../colors.js";
import { pluginCatalog } from "./catalog.js";
import type { OwnedUI } from "./host.js";
const originals = { accent:[...C.accent] as RGB,toolHeader:[...C.toolHeader] as RGB,user:[...C.user] as RGB,assistant:[...C.assistant] as RGB,dim:[...C.dim] as RGB };
let checked=0;
let cached:ReturnType<typeof pluginCatalog>|undefined;
export function invalidateTuiPlugins():void { checked=0; }
export function tuiPlugins() {
  if(!cached||Date.now()-checked>2000) { checked=Date.now();try{cached=pluginCatalog("standard",process.cwd());}catch{cached={ui:[],theme:{},skills:[],prompts:[],permissions:{},entries:{},providers:{},errors:[],safeMode:false};} }
  return cached;
}
export function applyTuiTheme():void {
  const theme=tuiPlugins().theme;
  for(const [key,fallback] of Object.entries(originals)) {
    const token=`--neutrino-tui-${key.replace(/[A-Z]/g,c=>"-"+c.toLowerCase())}`;
    const value=theme[token];const color=/^#[a-fA-F0-9]{6}$/.test(value??"")?[parseInt(value.slice(1,3),16),parseInt(value.slice(3,5),16),parseInt(value.slice(5,7),16)] as RGB:fallback;
    Object.assign(C[key as keyof typeof originals],color);
  }
}
export function terminalUI():OwnedUI[] { return tuiPlugins().ui.filter(u=>!u.platforms||u.platforms.includes("tui")); }
export function terminalTemplate(slot:string,values:Record<string,string>):string|undefined {
  const catalog=tuiPlugins();
  const item=terminalUI().find(u=>u.slot===slot&&catalog.providers[slot]===u.key&&u.text&&(!u.match?.role||u.match.role===values.role)&&(!u.match?.tool||u.match.tool===values.name));
  return item?.text?.replace(/\{\{([a-z]+)\}\}/g,(_,key:string)=>values[key]??"");
}
