import { pluginPrompt } from "../plugins/session.js";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PRO_DIR, loadConfig, type ModelInfo } from "../config.js";

/** Provider URLs and credentials stay in the shared, ordinary model catalogue. */
export const PRO_MODEL_FILE = path.join(PRO_DIR, "model.json");
/** Presets the user adds or rewrites themselves; a same-named preset here wins. */
export const PRO_CUSTOM_MODEL_FILE = path.join(PRO_DIR, "model-custom.json");
/** The official presets, fetched on first use: nothing is bundled with the package. */
export const PRO_MODELS_URL = "https://ius.neutrino.xingjisoft.com/model.json";
const ASSET_DIR = fileURLToPath(new URL("../../assets/pro/", import.meta.url));
const DOWNLOAD_TIMEOUT_MS = 10_000;

export const PRO_ROLES = [
  "main_model", "thinking_model", "front_output_model", "backend_output_model",
  "confirm_model", "genimage_model", "plan_model", "modeling_model",
] as const;
export type ProRole = (typeof PRO_ROLES)[number];
export const ACTIVE_PRO_ROLES = PRO_ROLES.filter((role) => role !== "genimage_model");
export const PRO_ROLE_LABELS: Record<ProRole, string> = {
  main_model: "Main", thinking_model: "Reasoning", front_output_model: "Frontend",
  backend_output_model: "Backend", confirm_model: "Approval", genimage_model: "Image generation",
  plan_model: "Planning", modeling_model: "Modeling",
};

export interface ProModelSetting {
  type: ProRole;
  provider: string;
  model: string | null;
  intensity: string;
  context_window: number;
}

export interface ProPreset {
  name: string;
  chinese_name: string;
  "model-setting": ProModelSetting[];
}

export interface ProModelsData {
  tier: ProPreset[];
}

/** Contains credentials. Never send this shape over the public API. */
export interface ProResolvedModel {
  role: ProRole;
  provider: string;
  model: ModelInfo;
  intensity: string;
  context_window: number;
  tier: string;
}

export interface ProModelReference {
  provider: string;
  model: string;
  tier: string;
}

export interface ProFallback {
  role: ProRole;
  requested: ProModelReference;
  replacement: ProModelReference | null;
  reason: string;
}

export interface ProModelSyncResult {
  /** `updated`: the official copy replaced the file. `unchanged`: they agree. */
  status: "updated" | "unchanged" | "kept";
  /** Why the local presets were kept, when the official copy could not be used. */
  detail?: string;
}

let downloading: Promise<void> | null = null;

/**
 * Make sure the Pro presets are on disk, downloading the official set the first
 * time. A file the user already has is never touched here; a failed download
 * leaves nothing behind, so the next start simply tries again.
 */
export function ensureProModels(): Promise<void> {
  fs.mkdirSync(PRO_DIR, { recursive: true });
  if (fs.existsSync(PRO_MODEL_FILE)) return Promise.resolve();
  downloading ??= downloadProModels().finally(() => { downloading = null; });
  return downloading;
}

async function downloadProModels(): Promise<void> {
  const body = await fetchProModels();
  // An error page or a truncated reply must never become the user's presets.
  parseProModels(body, "model.json", PRO_MODELS_URL);
  try {
    fs.writeFileSync(PRO_MODEL_FILE, body, { flag: "wx" });
  } catch (error) {
    // Another process won the race and wrote the file first: that is fine.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Keep ~/.neutrino/pro/model.json in step with the official presets, which own
 * that file: any difference is overwritten. Presets the user keeps for
 * themselves belong in model-custom.json, so nothing personal is lost. When the
 * official copy cannot be read, the local presets stay exactly as they are.
 *
 * Called once at start-up by both the terminal and the Web console.
 */
export async function syncProModels(): Promise<ProModelSyncResult> {
  const failure = `could not download the Pro model presets from ${PRO_MODELS_URL}`;
  let body: string;
  try {
    body = await fetchProModels();
  } catch (error) {
    // Offline, or the server is down: the local presets are still usable.
    if (!fs.existsSync(PRO_MODEL_FILE)) throw error;
    return { status: "kept", detail: error instanceof Error ? error.message : String(error) };
  }
  const remote = parseProModels(body, "model.json", PRO_MODELS_URL);
  const present = fs.existsSync(PRO_MODEL_FILE);
  if (remote.tier.length === 0) {
    if (!present) throw new Error(`${failure}: it contains no presets`);
    return { status: "kept", detail: `${failure}: it contains no presets` };
  }
  // Only formatting differences are not a difference: the file keeps its shape.
  // A local file that does not parse is replaced, so a hand edit cannot block Pro.
  if (present && samePresets(readProModelsQuietly(), remote)) return { status: "unchanged" };
  writeProModels(body);
  return { status: "updated" };
}

async function fetchProModels(): Promise<string> {
  try {
    const response = await fetch(PRO_MODELS_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new Error(
      `could not download the Pro model presets from ${PRO_MODELS_URL}: `
        + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Write the official copy in one step, so no reader ever sees half a file. */
function writeProModels(body: string): void {
  fs.mkdirSync(PRO_DIR, { recursive: true });
  const temp = `${PRO_MODEL_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, PRO_MODEL_FILE);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function readProModelsQuietly(): ProModelsData | null {
  try {
    return readProModels(PRO_MODEL_FILE, "model.json");
  } catch {
    return null;
  }
}

function samePresets(left: ProModelsData | null, right: ProModelsData): boolean {
  return left !== null && canonicalJson(left) === canonicalJson(right);
}

/** Compare documents by content, so reformatting alone is never a difference. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Parse and validate one presets document; each file has to be valid on its own. */
function parseProModels(text: string, label: string, where: string): ProModelsData {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Pro ${label} is not valid JSON; fix ${where}`);
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as ProModelsData).tier)) {
    throw new Error(`Pro ${label} must contain a tier array`);
  }
  const names = new Set<string>();
  for (const preset of (value as ProModelsData).tier) {
    if (!preset || typeof preset !== "object" || typeof preset.name !== "string" || !preset.name.trim() ||
        names.has(preset.name) || typeof preset.chinese_name !== "string" || !Array.isArray(preset["model-setting"])) {
      throw new Error("Each Pro preset needs a unique name, chinese_name and model-setting array");
    }
    names.add(preset.name);
    const roles = new Set<string>();
    for (const setting of preset["model-setting"]) {
      if (!setting || typeof setting !== "object" || !PRO_ROLES.includes(setting.type) || roles.has(setting.type) ||
          typeof setting.provider !== "string" || (setting.model !== null && typeof setting.model !== "string") ||
          typeof setting.intensity !== "string" ||
          !Number.isSafeInteger(setting.context_window) || setting.context_window < 1) {
        throw new Error(`Invalid model-setting in Pro preset ${preset.name}`);
      }
      roles.add(setting.type);
    }
  }
  return value as ProModelsData;
}

function readProModels(file: string, label: string): ProModelsData {
  return parseProModels(fs.readFileSync(file, "utf8"), label, `~/.neutrino/pro/${label}`);
}

export function loadProModels(): ProModelsData {
  if (!fs.existsSync(PRO_MODEL_FILE)) {
    // The download is asynchronous, so it happens at start-up (see ensureProModels).
    throw new Error(`Pro model.json is missing; it is downloaded from ${PRO_MODELS_URL} on first use`);
  }
  const { tier } = readProModels(PRO_MODEL_FILE, "model.json");
  // Presets the user keeps in model-custom.json are merged in. Their place in the
  // list is read as strength (the slider runs from weak to strong), so entries that
  // are not official rungs lead it: a preset named after an official one edits that
  // rung in place, every other one sits left of the graded presets.
  if (fs.existsSync(PRO_CUSTOM_MODEL_FILE)) {
    const own: ProPreset[] = [];
    for (const preset of readProModels(PRO_CUSTOM_MODEL_FILE, "model-custom.json").tier) {
      const index = tier.findIndex((entry) => entry.name === preset.name);
      if (index === -1) own.push(preset);
      else tier[index] = preset;
    }
    tier.unshift(...own);
  }
  if (tier.length === 0) throw new Error("Pro model.json must contain a nonempty tier array");
  return { tier };
}

export function requireProPreset(value: unknown): string {
  if (typeof value !== "string" || !loadProModels().tier.some((preset) => preset.name === value)) {
    throw new Error("Unknown Pro preset");
  }
  return value;
}

export function defaultProPreset(): string {
  const presets = loadProModels().tier;
  const preferred = loadConfig("pro").pro_preset;
  return presets.find((preset) => preset.name === preferred)?.name ??
    presets.find((preset) => preset.name === "medium")?.name ??
    presets.find((preset) => preset.name !== "custom")?.name ?? presets[0].name;
}

export const DEFAULT_PRO_RECURSION_DEPTH = 10;
export const MAX_PRO_RECURSION_DEPTH = 100;

export function proMaxRecursionDepth(): number {
  const configured = loadConfig("pro").pro_max_recursion_depth;
  return typeof configured === "number" && Number.isSafeInteger(configured) &&
    configured >= 1 && configured <= MAX_PRO_RECURSION_DEPTH ? configured : DEFAULT_PRO_RECURSION_DEPTH;
}

/** Every agent prompt lives in the requested assets/pro directory. */
export function loadProPrompt(role: ProRole): string {
  if (!PRO_ROLES.includes(role)) throw new Error("Unknown Pro role");
  return pluginPrompt(fs.readFileSync(path.join(ASSET_DIR, "common.txt"), "utf8") + "\n\n" +
    fs.readFileSync(path.join(ASSET_DIR, `${role}.txt`), "utf8"),role);
}
