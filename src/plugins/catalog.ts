import fs from "node:fs";
import { pluginRecords, providerSelections, safeMode } from "./manager.js";
import { safeFile } from "./validation.js";
import type { OwnedUI } from "./host.js";
import type { Profile } from "./types.js";

/** Reading the UI catalogue must never activate backend code or start a worker. */
export function pluginCatalog(profile: Profile = "standard",cwd?: string) {
  const ui:OwnedUI[] = [], theme:Record<string,string> = {}, skills:Array<{ id:string;description:string }> = [], prompts:Array<{ id:string;replace:boolean }> = [];
  const errors:string[] = [];
  const permissions:Record<string,string[]> = {},entries:Record<string,string|undefined> = {};
  try {
    for (const record of pluginRecords(profile,cwd)) {
      const m=record.manifest;
      if (record.error) { errors.push(`${m.id}: ${record.error}`); continue; }
      permissions[m.id]=m.permissions??[];entries[m.id]=m.entries?.web;
      if (m.permissions?.includes("ui.contribute")) {
        for (const item of m.contributes?.ui ?? []) ui.push({ ...item,key:`${m.id}/${item.id}`,pluginId:m.id,entry:m.entries?.web,permissions:m.permissions ?? [] });
        Object.assign(theme,m.contributes?.theme ?? {});
      }
      if (m.permissions?.includes("prompts.contribute")) {
        for (const p of m.contributes?.prompts ?? []) prompts.push({ id:`${m.id}/${p.id}`,replace:p.replace === true });
        for (const file of m.contributes?.skills ?? []) {
          const text=fs.readFileSync(safeFile(record.directory,file),"utf8").slice(0,64_000);
          const name=/^name:\s*["']?([^\r\n"']+)/m.exec(text)?.[1]?.trim() ?? file.split("/").slice(-2,-1)[0];
          skills.push({ id:`${m.id}/${name}`,description:/^description:\s*["']?([^\r\n"']+)/m.exec(text)?.[1]?.trim() ?? String(name) });
        }
      }
    }
  } catch(e) { errors.push((e as Error).message); }
  let providers:Record<string,string>={};try{providers=providerSelections(profile);}catch(e){errors.push((e as Error).message);}
  return { ui,theme,skills,prompts,permissions,entries,providers,errors,safeMode:safeMode() };
}
