import fs from "node:fs";
import path from "node:path";
import { PERMISSIONS, SLOTS, type PluginManifest, type Schema, type UIContribution, type PromptContribution } from "./types.js";

export const ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
export const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
export function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function safeFile(root: string, relative: string): string {
  assert(typeof relative === "string" && relative.length > 0 && !relative.includes("\\") && !relative.includes("\0") && !path.isAbsolute(relative), "Plugin resources must use relative paths");
  const base = fs.realpathSync(root);
  const target = fs.realpathSync(path.resolve(base, relative));
  const rel = path.relative(base, target);
  assert(rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), "Plugin resource escapes its package");
  assert(fs.statSync(target).isFile(), "Plugin resource is not a file");
  return target;
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(x => typeof x === "string"); }
export function validateUI(value: unknown): asserts value is UIContribution {
  assert(object(value) && NAME.test(String(value.id)) && SLOTS.includes(value.slot as never), "Invalid UI id or slot");
  assert(typeof value.title === "string" && value.title.length > 0 && value.title.length <= 100, "UI title is required (maximum 100 characters)");
  for (const key of ["view", "command", "text", "insert"]) assert(value[key] === undefined || typeof value[key] === "string", `UI ${key} must be a string`);
  assert(value.order === undefined || Number.isFinite(value.order), "UI order must be finite");
  assert(value.height === undefined || (Number.isInteger(value.height) && Number(value.height) >= 40 && Number(value.height) <= 1200), "UI height must be 40–1200");
  assert(value.platforms === undefined || (strings(value.platforms) && value.platforms.every(p => p === "web" || p === "tui")), "Invalid UI platforms");
  assert(value.match === undefined || (object(value.match) && Object.entries(value.match).every(([k,v]) => ["role", "tool"].includes(k) && typeof v === "string")), "Invalid UI match");
}
export function validatePrompt(value: unknown): asserts value is PromptContribution {
  assert(object(value) && NAME.test(String(value.id)), "Invalid prompt id");
  assert((typeof value.file === "string") !== (typeof value.text === "string"), "A prompt needs exactly one of file/text");
  assert(value.slot === undefined || ["persona", "rules", "context"].includes(String(value.slot)), "Invalid prompt slot");
  assert(value.order === undefined || Number.isFinite(value.order), "Invalid prompt order");
  assert(value.roles === undefined || strings(value.roles), "Invalid prompt roles");
  assert(value.replace === undefined || typeof value.replace === "boolean", "Invalid prompt replacement");
}
/** Deliberately bounded JSON Schema subset; unsupported keywords fail rather than silently weakening validation. */
export function validateSchema(schema: unknown, depth = 0): asserts schema is Schema {
  assert(object(schema) && depth < 16, "Invalid or excessively nested configuration schema");
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "default", "title", "description", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);
  assert(Object.keys(schema).every(k => allowed.has(k)), "Unsupported JSON Schema keyword");
  assert(["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(schema.type)), "Schema type is required");
  if (schema.properties !== undefined) {
    assert(object(schema.properties), "Schema properties must be an object");
    for (const [key, child] of Object.entries(schema.properties)) { assert(!["__proto__", "constructor", "prototype"].includes(key), "Reserved schema key"); validateSchema(child, depth + 1); }
  }
  assert(schema.required === undefined || strings(schema.required), "Schema required must be a string array");
  assert(schema.additionalProperties === undefined || typeof schema.additionalProperties === "boolean", "additionalProperties must be boolean");
  if (schema.items !== undefined) validateSchema(schema.items, depth + 1);
  assert(schema.enum === undefined || (Array.isArray(schema.enum) && schema.enum.length > 0), "Schema enum cannot be empty");
  for (const k of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) assert(schema[k] === undefined || Number.isFinite(schema[k]), `Invalid schema ${k}`);
}
export function validateValue(value: unknown, schema: Schema, location = "config"): void {
  const type = schema.type;
  assert(type === "null" ? value === null : type === "object" ? object(value) : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isSafeInteger(value) : typeof value === type, `${location}: expected ${type}`);
  if (schema.enum) assert((schema.enum as unknown[]).some(x => JSON.stringify(x) === JSON.stringify(value)), `${location}: value is not in enum`);
  if (typeof value === "number") { assert(Number.isFinite(value), `${location}: invalid number`); assert(schema.minimum === undefined || value >= Number(schema.minimum), `${location}: below minimum`); assert(schema.maximum === undefined || value <= Number(schema.maximum), `${location}: above maximum`); }
  if (typeof value === "string") { assert(schema.minLength === undefined || value.length >= Number(schema.minLength), `${location}: too short`); assert(schema.maxLength === undefined || value.length <= Number(schema.maxLength), `${location}: too long`); }
  if (Array.isArray(value)) { assert(schema.minItems === undefined || value.length >= Number(schema.minItems), `${location}: too few items`); assert(schema.maxItems === undefined || value.length <= Number(schema.maxItems), `${location}: too many items`); if (schema.items) value.forEach((item, i) => validateValue(item, schema.items as Schema, `${location}[${i}]`)); }
  if (object(value)) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) assert(Object.hasOwn(value, key), `${location}.${key}: required`);
    for (const [key, item] of Object.entries(value)) { assert(!["__proto__", "constructor", "prototype"].includes(key), "Reserved configuration key"); if (Object.hasOwn(properties, key)) validateValue(item, properties[key], `${location}.${key}`); else assert(schema.additionalProperties !== false, `${location}.${key}: unknown property`); }
  }
}
export function defaults(schema: Schema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries((schema?.properties ?? {}) as Record<string, Schema>)) if (field.default !== undefined) out[key] = structuredClone(field.default);
  return out;
}
export function readManifest(directory: string): PluginManifest {
  const file = safeFile(directory, "neutrino.plugin.json");
  assert(fs.statSync(file).size <= 128_000, "Plugin manifest is too large");
  const m: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  assert(object(m) && ID.test(String(m.id)) && String(m.id).length <= 80, "Plugin id must be namespaced, e.g. acme.review");
  assert(typeof m.name === "string" && m.name.length > 0 && m.name.length <= 100, "Plugin name is required");
  assert(typeof m.version === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version), "Invalid plugin version");
  assert(m.apiVersion === 1, "Unsupported plugin API version (expected 1)");
  assert(m.runtime === undefined || m.runtime === "sandbox" || m.runtime === "native", "Invalid plugin runtime");
  assert(m.permissions === undefined || (strings(m.permissions) && m.permissions.every(p => PERMISSIONS.includes(p as never))), "Unknown plugin permission");
  assert(m.profiles === undefined || (strings(m.profiles) && m.profiles.every(p => p === "standard" || p === "pro")), "Invalid plugin profiles");
  assert(m.categories === undefined || (strings(m.categories) && m.categories.every(c => ["function", "appearance", "skill", "prompt"].includes(c))), "Invalid plugin categories");
  for (const field of ["description", "license"]) assert(m[field] === undefined || typeof m[field] === "string", `Invalid ${field}`);
  for (const field of ["dependencies", "optionalDependencies"]) if (m[field] !== undefined) {
    assert(object(m[field]), `Invalid ${field}`);
    for (const [id, version] of Object.entries(m[field])) assert(ID.test(id) && typeof version === "string" && /^(?:\*|[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(version), "Dependency versions support exact, ^, ~, or *");
  }
  if (m.entries !== undefined) {
    assert(object(m.entries) && Object.keys(m.entries).every(k => ["agent", "web", "tui"].includes(k)), "Invalid plugin entries");
    for (const entry of Object.values(m.entries)) { assert(typeof entry === "string", "Entry path must be a string"); safeFile(directory, entry); }
  }
  if(m.webAssets !== undefined) { assert(strings(m.webAssets) && m.webAssets.length <= 100,"Invalid webAssets"); for(const file of m.webAssets) safeFile(directory,file); }
  if (m.configuration !== undefined) { validateSchema(m.configuration); assert(m.configuration.type === "object", "Configuration schema must be an object"); }
  if (m.contributes !== undefined) {
    assert(object(m.contributes), "Invalid contributes");
    const c = m.contributes;
    for (const key of ["ui", "prompts", "skills"]) assert(c[key] === undefined || (Array.isArray(c[key]) && c[key].length <= 100), `Invalid contributes.${key}`);
    for (const ui of (c.ui ?? []) as unknown[]) { validateUI(ui); if (ui.view) safeFile(directory, ui.view); }
    for (const prompt of (c.prompts ?? []) as unknown[]) { validatePrompt(prompt); if (prompt.file) safeFile(directory, prompt.file); }
    for (const file of (c.skills ?? []) as unknown[]) { assert(typeof file === "string", "Skill path must be a string"); safeFile(directory, file); }
    if (c.theme !== undefined) { assert(object(c.theme) && Object.keys(c.theme).length <= 50, "Invalid theme"); for (const [key, value] of Object.entries(c.theme)) assert(/^--(?:neutrino-)?[a-z][a-z0-9-]*$/.test(key) && typeof value === "string" && value.length <= 100 && !/[;{}<>\\]|url\s*\(|expression\s*\(|@|\/\*/i.test(value), "Theme values must be simple CSS tokens"); }
  }
  return m as unknown as PluginManifest;
}
export function satisfies(actual: string, range: string): boolean {
  if (range === "*") return true;
  const expected = range.replace(/^[~^]/, "");
  if (!/^[~^]/.test(range)) return actual === expected;
  if (actual.includes("-") || expected.includes("-")) return actual === expected;
  const a = actual.split(".").map(Number), b = expected.split(".").map(Number);
  const compare = (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  return compare >= 0 && (range[0] === "~" ? a[0] === b[0] && a[1] === b[1] : b[0] > 0 ? a[0] === b[0] : b[1] > 0 ? a[0] === 0 && a[1] === b[1] : a[0] === 0 && a[1] === 0 && a[2] === b[2]);
}
