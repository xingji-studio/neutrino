import type http from "node:http";
import { configurePlugin, installPlugin, listPlugins, pluginAsset, removePlugin, rollbackPlugin, selectProvider } from "../plugins/manager.js";
import { pluginCatalog } from "../plugins/catalog.js";
import { assert, object } from "../plugins/validation.js";
import type { Profile } from "../plugins/types.js";

/** Called only after the server's existing authentication check. */
export async function handlePlugins(req:http.IncomingMessage,res:http.ServerResponse,url:URL,pathname:string,profile:Profile,
  helpers:{ sameOrigin:boolean;read():Promise<unknown>;json(status:number,value:unknown):void }):Promise<boolean> {
  if(pathname!=="/api/plugins"&&!pathname.startsWith("/api/plugins/")) return false;
  try {
    const cwd=url.searchParams.get("cwd")||undefined;
    if(req.method==="GET") {
      if(pathname==="/api/plugins") helpers.json(200,listPlugins(profile,cwd));
      else if(pathname==="/api/plugins/catalog") helpers.json(200,pluginCatalog(profile,cwd));
      else if(pathname==="/api/plugins/asset") helpers.json(200,{ body:pluginAsset(url.searchParams.get("id")??"",url.searchParams.get("file")??"",profile,cwd) });
      else helpers.json(404,{ error:"Unknown plugin endpoint" });
      return true;
    }
    if(req.method!=="POST"||pathname!=="/api/plugins") { helpers.json(405,{ error:"Method not allowed" }); return true; }
    if(!helpers.sameOrigin) { helpers.json(403,{ error:"cross-origin request rejected" }); return true; }
    const body=await helpers.read(); assert(object(body),"Invalid plugin request");
    assert(body.revision===undefined||Number.isSafeInteger(body.revision),"Invalid plugin revision");
    const revision=body.revision as number|undefined;
    const id=String(body.id??"");
    if(body.action==="install") { assert(typeof body.source==="string","Source directory is required"); installPlugin(body.source,revision); }
    else if(body.action==="configure") {
      assert(object(body.patch),"Plugin patch is required");
      assert(Object.keys(body.patch).every(k=>["enabled","config","trustNative"].includes(k)),"Unknown plugin patch field");
      configurePlugin(id,body.patch,profile,cwd,revision);
    } else if(body.action==="remove") removePlugin(id,revision);
    else if(body.action==="update") { const plugin=listPlugins(profile,cwd).plugins.find(p=>p.manifest.id===id); assert(plugin,"Unknown plugin"); installPlugin(plugin.source,revision); }
    else if(body.action==="rollback") rollbackPlugin(id,revision);
    else if(body.action==="provider") { assert(typeof body.slot==="string"&&typeof body.provider==="string","Slot and provider are required"); selectProvider(body.slot,body.provider,profile,revision); }
    else throw new Error("Unknown plugin action");
    helpers.json(200,listPlugins(profile,cwd));
  } catch(e) { helpers.json((e as Error).message.includes("state changed")?409:400,{ error:(e as Error).message }); }
  return true;
}
