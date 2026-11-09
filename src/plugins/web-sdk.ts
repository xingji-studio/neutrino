/** Browser plugins bundle this helper into their single-file ES module, or use window.neutrino in HTML views. */
export interface Draft { text:string;revision:number }
export interface ViewContext { pluginId:string;id:string;title:string;profile:"standard"|"pro";cwd?:string;message?:unknown;plan?:unknown }
export interface PluginViewAPI {
  readonly context:ViewContext;
  composer:{read():Promise<Draft>;write(draft:{text:string;expectedRevision:number}):Promise<Draft>;submit():Promise<void>};
  conversation:{read():Promise<{identity:string;cwd:string;messages:unknown[];model?:string;plan?:unknown}>};
  configuration:{read():Promise<{values:Record<string,unknown>;schema?:Record<string,unknown>;revision:number}>;write(value:{values:Record<string,unknown>;expectedRevision:number}):Promise<{revision:number}>};
  commands:{execute(name:string,args?:Record<string,unknown>):Promise<unknown>};
  view:{resize(height:number):Promise<void>};
  on(name:"context.changed",handler:(context:ViewContext)=>void):()=>void;
}
export interface WebPlugin<Root=unknown> { mount(api:PluginViewAPI,root:Root):void|Promise<void> }
export function defineWebPlugin<Root=unknown>(plugin:WebPlugin<Root>):WebPlugin<Root>{return plugin;}
