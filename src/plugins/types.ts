/** Public plugin API v1. Keep this module free of application side effects. */
export type Profile = "standard" | "pro";
export type JsonObject = Record<string, unknown>;
export type Schema = Record<string, unknown>;
export type Permission = "tools.register" | "commands.register" | "prompts.contribute" | "hooks.register" |
  "ui.contribute" | "conversation.read" | "composer.read" | "composer.write" | "composer.submit" |
  "filesystem.read" | "filesystem.write" | "network" | "process" | "storage";
export const PERMISSIONS: readonly Permission[] = ["tools.register", "commands.register", "prompts.contribute", "hooks.register",
  "ui.contribute", "conversation.read", "composer.read", "composer.write", "composer.submit", "filesystem.read",
  "filesystem.write", "network", "process", "storage"];
export type Effect = "filesystem.read" | "filesystem.write" | "network" | "process";
export const SLOTS = ["app.menu", "workspace.tabs", "sidebar.footer", "chat.header.actions", "chat.composer.toolbar",
  "chat.composer", "chat.message.actions", "chat.message.renderer", "chat.card.plan", "chat.card.tool", "settings.sections"] as const;
export type Slot = typeof SLOTS[number];
export interface UIContribution {
  id: string;
  slot: Slot;
  title: string;
  order?: number;
  view?: string;
  command?: string;
  text?: string;
  insert?: string;
  height?: number;
  match?: { role?: string; tool?: string };
  platforms?: Array<"web" | "tui">;
}
export interface PromptContribution {
  id: string;
  file?: string;
  text?: string;
  slot?: "persona" | "rules" | "context";
  order?: number;
  roles?: string[];
  replace?: boolean;
}
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  description?: string;
  license?: string;
  categories?: Array<"function" | "appearance" | "skill" | "prompt">;
  runtime?: "sandbox" | "native";
  entries?: { agent?: string; web?: string; tui?: string };
  webAssets?: string[];
  profiles?: Profile[];
  permissions?: Permission[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  configuration?: Schema;
  contributes?: {
    ui?: UIContribution[];
    prompts?: PromptContribution[];
    skills?: string[];
    theme?: Record<string, string>;
  };
}
export interface PluginScope {
  profile: Profile;
  cwd: string;
  sessionId?: string;
  role: string;
  runId?: string;
  request?: string;
}
export interface InvocationContext extends PluginScope { signal?: AbortSignal }
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Schema;
  effects: Effect[];
  roles?: string[];
  execute(args: JsonObject, context: InvocationContext): unknown | Promise<unknown>;
}
export interface CommandSpec {
  name: string;
  description: string;
  parameters?: Schema;
  effects: Effect[];
  execute(args: JsonObject, context: InvocationContext): unknown | Promise<unknown>;
}
export type HookName = "request.before" | "tool.before";
export type EventName = "turn.started" | "turn.finished" | "tool.finished";
export interface Registration { dispose(): void }
export interface PluginContext {
  readonly id: string;
  readonly config: Readonly<JsonObject>;
  readonly scope: Readonly<PluginScope>;
  tools: { register(spec: ToolSpec): Registration };
  commands: { register(spec: CommandSpec): Registration };
  prompts: { register(spec: PromptContribution): Registration };
  skills: { register(file: string): Registration };
  ui: { register(spec: UIContribution): Registration };
  hooks: { add(name: HookName, handler: (value: JsonObject, context: InvocationContext) => unknown | Promise<unknown>): Registration };
  events: { on(name: EventName, handler: (value: JsonObject, context: InvocationContext) => unknown | Promise<unknown>): Registration };
  fs: { read(path: string, reason: string): Promise<string>; write(path: string, content: string, reason: string): Promise<string>; list(path: string, reason: string): Promise<string> };
  net: { fetch(url: string, reason: string): Promise<{ status: number; body: string }> };
  process: { run(command: string, reason: string): Promise<string> };
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  services: { call(pluginId: string, command: string, args?: JsonObject): Promise<unknown> };
  log(message: string): void;
  effect(dispose: () => void | Promise<void>): void;
}
export interface Plugin {
  activate(ctx: PluginContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
export function definePlugin<T extends Plugin>(plugin: T): T { return plugin; }
export interface PluginPin { id: string; version: string; integrity: string; config: JsonObject }
export interface InstalledPlugin {
  manifest: PluginManifest;
  directory: string;
  integrity: string;
  source: string;
  installedAt: string;
  previous?: Omit<InstalledPlugin, "previous">;
}
export interface PluginActivation { enabled: boolean; config: JsonObject; nativeTrust?: string }
export interface PluginRecord extends InstalledPlugin { activation: PluginActivation; error?: string }
export interface PublicPlugin {
  manifest: PluginManifest;
  integrity: string;
  source: string;
  installedAt: string;
  enabled: boolean;
  config: JsonObject;
  error?: string;
  rollback: boolean;
}
