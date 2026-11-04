import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRO_DIR, loadConfig, type ModelInfo } from "../config.js";

/** Provider URLs and credentials stay in the shared, ordinary model catalogue. */
export const PRO_MODEL_FILE = path.join(PRO_DIR, "model.json");
const ASSET_DIR = fileURLToPath(new URL("../../assets/pro/", import.meta.url));

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

/** Copy the bundled template byte-for-byte, exclusively on first use. */
export function ensureProModels(): void {
  fs.mkdirSync(PRO_DIR, { recursive: true });
  try {
    fs.copyFileSync(path.join(ASSET_DIR, "model-template.json"), PRO_MODEL_FILE, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function loadProModels(): ProModelsData {
  ensureProModels();
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(PRO_MODEL_FILE, "utf8"));
  } catch {
    throw new Error("Pro model.json is not valid JSON; fix ~/.neutrino/pro/model.json");
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as ProModelsData).tier) ||
      (value as ProModelsData).tier.length === 0) {
    throw new Error("Pro model.json must contain a nonempty tier array");
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
  return fs.readFileSync(path.join(ASSET_DIR, "common.txt"), "utf8") + "\n\n" +
    fs.readFileSync(path.join(ASSET_DIR, `${role}.txt`), "utf8");
}
