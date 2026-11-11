/** Dependency-free distributable bundle. No extraction of executable installation scripts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert,object,readManifest } from "./validation.js";
import { packageIntegrity } from "./manager.js";
interface Bundle { format:"neutrino-plugin";version:1;integrity:string;files:Array<{path:string;data:string}> }
export function packPlugin(directory:string,output:string):string {
  const base=fs.realpathSync(directory),dest=path.resolve(output);assert(dest!==base&&!dest.startsWith(base+path.sep),"Bundle output must be outside the source package");
  readManifest(directory);const integrity=packageIntegrity(directory);const files:Bundle["files"]=[];
  const visit=(dir:string,relative="")=>{for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(["node_modules",".git",".DS_Store"].includes(item.name))continue;const file=path.join(dir,item.name),name=path.posix.join(relative,item.name);if(item.isDirectory())visit(file,name);else files.push({path:name,data:fs.readFileSync(file).toString("base64")});}};visit(directory);
  fs.writeFileSync(output,JSON.stringify({format:"neutrino-plugin",version:1,integrity,files} satisfies Bundle),{flag:"wx"});return output;
}
export function unpackPlugin(file:string):{directory:string;dispose():void} {
  assert(fs.statSync(file).size<=48*1024*1024,"Plugin bundle exceeds 48 MiB");
  const bundle:unknown=JSON.parse(fs.readFileSync(file,"utf8"));assert(object(bundle)&&bundle.format==="neutrino-plugin"&&bundle.version===1&&typeof bundle.integrity==="string"&&Array.isArray(bundle.files)&&bundle.files.length<=2000,"Invalid plugin bundle");
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"neutrino-plugin-unpack-"));
  try{
    let bytes=0;const seen=new Set<string>();
    for(const item of bundle.files){assert(object(item)&&typeof item.path==="string"&&typeof item.data==="string","Invalid bundle file");const parts=item.path.split("/");assert(parts.every(p=>p&&p!=="."&&p!==".."&&!/[\\:\0]/.test(p))&&!seen.has(item.path),"Unsafe or duplicate bundle path");seen.add(item.path);const data=Buffer.from(item.data,"base64");assert((bytes+=data.length)<=32*1024*1024,"Plugin data exceeds 32 MiB");const dest=path.join(directory,...parts);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,data,{flag:"wx",mode:0o600});}
    readManifest(directory);assert(packageIntegrity(directory)===bundle.integrity,"Plugin bundle integrity mismatch");
    return{directory,dispose:()=>fs.rmSync(directory,{recursive:true,force:true})};
  }catch(e){fs.rmSync(directory,{recursive:true,force:true});throw e;}
}
