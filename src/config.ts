import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sameCwd } from "./cwd.js";
import { normalizeContext, type ConversationContext } from "./compact.js";
import type { PlanState } from "./llm/plan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");

export const NEUTRINO_DIR = path.join(os.homedir(), ".neutrino");
export const MODEL_FILE = path.join(NEUTRINO_DIR, "model.json");
export const SESSION_DIR = path.join(NEUTRINO_DIR, "session");
export const CONFIG_FILE = path.join(NEUTRINO_DIR, "config.json");

/**
 * The browser console has two workspaces: the regular one and the isolated
 * "Pro" workspace served at `/pro`. Everything a workspace owns — transcripts,
 * model defaults, plan/compaction settings, reviewer model and interface
 * language — is stored per mode; only the credentials and the approval policy
 * below are shared, because they protect or gate the whole process.
 */
export const MODES = ["standard", "pro"] as const;
export type Mode = (typeof MODES)[number];

export const PRO_DIR = path.join(NEUTRINO_DIR, "pro");
export const PRO_CONFIG_FILE = path.join(PRO_DIR, "config.json");
export const PRO_SESSION_DIR = path.join(PRO_DIR, "session");

/**
 * Settings that intentionally apply to both workspaces. The Web password, the
 * approval policy and the console's interface are properties of this process,
 * not of a conversation workspace.
 */
export const SHARED_CONFIG_KEYS = ["web_password_hash", "approval_mode", "auto_approve_extreme_risk", "web_lan"] as const;

export function normalizeMode(value: unknown): Mode {
  return typeof value === "string" && value.trim().toLowerCase() === "pro" ? "pro" : "standard";
}

export function configFile(mode: Mode = "standard"): string {
  return mode === "pro" ? PRO_CONFIG_FILE : CONFIG_FILE;
}

export function sessionDir(mode: Mode = "standard"): string {
  return mode === "pro" ? PRO_SESSION_DIR : SESSION_DIR;
}

/** Key used to remember a model's context capacity per workspace. */
export function modelContextWindowKey(provider: string, modelName: string): string {
  return `${provider}/${modelName}`;
}

export interface ModelInfo {
  name: string;
  url: string;
  api_key: string;
  supports_streaming: boolean;
  /** Context capacity in tokens; omitted models use 1M. */
  context_window?: number;
  /**
   * DeepSeek-style thinking mode: the endpoint rejects a request that offers
   * tools while an assistant message in the history carries no
   * `reasoning_content`. Defaults to true for DeepSeek endpoints; set it
   * explicitly for a differently named endpoint (or to opt out).
   */
  reasoning?: boolean;
  /**
   * Thinking intensities this model accepts, e.g. `["low", "high", "max"]`.
   * Names are matched case-insensitively and normalised to the canonical
   * `INTENSITY_LEVELS` spelling. Omitted or empty means every level is allowed,
   * which keeps hand-written catalogues backwards compatible.
   */
  intensity?: string[];
}

/**
 * Whether assistant messages must be sent back with a `reasoning_content`
 * field. DeepSeek's thinking mode requires one on *every* assistant message of
 * a tools-bearing request (an empty string is accepted), and the plan message
 * written by the planner is otherwise an assistant message without it.
 */
export function modelUsesReasoning(provider: string, model: ModelInfo): boolean {
  if (typeof model.reasoning === "boolean") return model.reasoning;
  return provider === "DeepSeek" || /deepseek|reasoner|thinking/i.test(model.name);
}

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const CONTEXT_COMPRESSION_RATIO = 0.8;
export const CONTEXT_WINDOW_OPTIONS = [32_000, 64_000, 128_000, 200_000, 256_000, 512_000, 1_000_000, 2_000_000, 4_000_000];

export function isContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function contextWindow(value: unknown): number {
  return isContextWindow(value) ? value : DEFAULT_CONTEXT_WINDOW;
}

/** Reload the exact provider/model so settings also apply to active chats. */
export function modelContextWindow(provider: string, model: ModelInfo, mode: Mode = "standard"): number {
  // The Pro workspace keeps its own context capacities: changing one there must
  // not move the compression threshold of the regular workspace (and vice
  // versa). The capacity is a per-workspace setting, not shared model metadata,
  // so an unset Pro value starts from the documented default instead of
  // inheriting whatever the regular workspace saved in model.json.
  if (mode === "pro") {
    const configured = loadConfig("pro").model_context_windows;
    if (configured && typeof configured === "object" && !Array.isArray(configured)) {
      const override = (configured as Record<string, unknown>)[modelContextWindowKey(provider, model.name)];
      if (isContextWindow(override)) return override;
    }
    return contextWindow(undefined);
  }
  const saved = loadModels().providers.find((p) => p.name === provider)?.models.find((m) => m.name === model.name);
  return contextWindow((saved ?? model).context_window);
}

export function contextCompressionThreshold(provider: string, model: ModelInfo, mode: Mode = "standard"): number {
  return Math.max(1, Math.floor(modelContextWindow(provider, model, mode) * CONTEXT_COMPRESSION_RATIO));
}

export interface ModelSelection {
  provider: string;
  model: string;
  intensity: string;
}

/** Resolved only on the server; credentials must never be serialized to clients. */
export interface ResolvedModelSelection {
  provider: string;
  model: ModelInfo;
  intensity: string;
}

export interface Provider {
  name: string;
  models: ModelInfo[];
}

export interface ModelsData {
  providers: Provider[];
}

export const DEFAULT_MODELS: ModelsData = {
  providers: [
    {
      name: "DeepSeek",
      models: [
        { name: "deepseek-v4-pro", url: "https://api.deepseek.com/v1", api_key: "", supports_streaming: true },
        { name: "deepseek-chat", url: "https://api.deepseek.com/v1", api_key: "", supports_streaming: true },
      ],
    },
    {
      name: "OpenAI",
      models: [
        { name: "gpt-4o", url: "https://api.openai.com/v1", api_key: "", supports_streaming: true },
        { name: "gpt-4o-mini", url: "https://api.openai.com/v1", api_key: "", supports_streaming: true },
      ],
    },
    {
      name: "Anthropic",
      models: [
        { name: "claude-3-5-sonnet-20241022", url: "https://api.anthropic.com/v1", api_key: "", supports_streaming: true },
      ],
    },
  ],
};

/** Languages the browser console can render its own interface in. */
export const WEB_LANGUAGES = ["en", "zh"] as const;
export type WebLanguage = (typeof WEB_LANGUAGES)[number];

/** Unknown or missing values fall back to English rather than breaking the UI. */
export function normalizeWebLanguage(value: unknown): WebLanguage {
  return typeof value === "string" && value.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const DEFAULT_CONFIG: Record<string, unknown> = {
  language: "en",
  theme: "default",
  default_intensity: "High",
  // Plan a request into steps before answering it: the planner agent writes the
  // plan, the worker executes one step per turn. Requests that look like a
  // single action are never planned (see needsPlan), and false turns planning
  // off for every request.
  plan_first: true,
  // Default for new conversations; each conversation can override it.
  approval_mode: "request",
  // Delete-class commands need a human unless this and Auto Approval are on.
  auto_approve_extreme_risk: false,
  // Audible cue when a turn ends or an approval request is waiting.
  sound_alerts: true,
  // Model that reviews approval requests. Empty = same model as the chat.
  approval_model: "",
  // Mount the browser UI alongside the terminal UI unless it is turned off
  // here or on the command line.
  web_console: true,
  // Listen on every interface (the equivalent of --lan) instead of loopback.
  // The listener belongs to the process, so both workspaces share this value.
  web_lan: false,
  // Working directories opened from the browser, newest first. They remain
  // listed even when they hold no conversations yet.
  web_workspaces: [],
  // Initialized as a salted hash of the default Web password on first use.
  web_password_hash: "",
};

export const INTENSITY_LEVELS = ["Low", "Medium", "High", "Max", "Ultra"];

export const INTENSITY_PARAMS: Record<string, { temperature: number; top_p: number }> = {
  Low: { temperature: 0.1, top_p: 0.1 },
  Medium: { temperature: 0.3, top_p: 0.5 },
  High: { temperature: 0.7, top_p: 0.9 },
  Max: { temperature: 1.0, top_p: 1.0 },
  Ultra: { temperature: 1.5, top_p: 1.0 },
};

/** Canonical spelling of a configured intensity name, or null when unknown. */
export function normalizeIntensity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const wanted = value.trim().toLowerCase();
  return INTENSITY_LEVELS.find((level) => level.toLowerCase() === wanted) ?? null;
}

/**
 * The intensities a model accepts, in the canonical Low → Ultra order.
 *
 * An absent or empty list keeps the historical behaviour: every level is
 * allowed. Unknown names are ignored rather than making the model unusable, so
 * a typo in `model.json` falls back to the remaining valid entries (or to all
 * levels when none is valid).
 */
export function modelIntensities(model: ModelInfo | null | undefined): string[] {
  const raw: unknown = model?.intensity;
  const entries: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const allowed = new Set<string>();
  for (const entry of entries) {
    const level = normalizeIntensity(entry);
    if (level) allowed.add(level);
  }
  if (allowed.size === 0) return [...INTENSITY_LEVELS];
  return INTENSITY_LEVELS.filter((level) => allowed.has(level));
}

/**
 * Pick a usable intensity for a model. The preferred value wins when the model
 * accepts it; otherwise the configured fallback, then High, then the first
 * supported level. This is the one place stale UI state, a saved session or a
 * hand-edited `config.json` is reconciled with the model's limits.
 */
export function intensityForModel(
  model: ModelInfo | null | undefined,
  preferred?: unknown,
  fallback?: unknown,
): string {
  const allowed = modelIntensities(model);
  for (const candidate of [preferred, fallback, "High"]) {
    const level = normalizeIntensity(candidate);
    if (level && allowed.includes(level)) return level;
  }
  return allowed[0] ?? "High";
}

/** Exact model lookup within a provider (names may repeat across providers). */
export function findConfiguredModel(providerName: string, modelName: string): ModelInfo | null {
  return loadModels().providers.find((provider) => provider.name === providerName)
    ?.models.find((model) => model.name === modelName) ?? null;
}

export interface SessionMeta {
  id: string;
  created_at: string;
  updated_at: string;
  model: string;
  provider: string;
  intensity: string;
  cwd: string;
  title: string;
  message_count: number;
}

export interface ToolMessage {
  role: "tool";
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export type SessionMessage = ChatMessage | ToolMessage;

export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface SessionData {
  id: string;
  created_at: string;
  updated_at: string;
  model: string;
  provider: string;
  intensity: string;
  cwd: string;
  title: string;
  messages: SessionMessage[];
  tokens?: TokenUsage;
  /** Model context is separate from messages, which always retain the originals. */
  context?: ConversationContext;
  approval_mode?: ApprovalMode;
  /** The plan of the turn being worked on, so reopening shows the same steps. */
  plan?: PlanState | null;
  /** Pro preset selection; resolved fallback models are always task-local. */
  pro_preset?: string;
}

export type ApprovalMode = "request" | "auto";

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  // Config files are hand-edited: "Auto" or " autO " must not silently
  // downgrade the conversation to a prompt on every tool call.
  return typeof value === "string" && value.trim().toLowerCase() === "auto"
    ? "auto"
    : "request";
}

export function ensureDirs(mode: Mode = "standard"): void {
  fs.mkdirSync(NEUTRINO_DIR, { recursive: true });
  fs.mkdirSync(sessionDir(mode), { recursive: true });
  if (mode === "pro") fs.mkdirSync(PRO_DIR, { recursive: true });
}

export function loadModels(): ModelsData {
  try {
    ensureDirs();
    if (!fs.existsSync(MODEL_FILE)) {
      saveModels(DEFAULT_MODELS);
      return DEFAULT_MODELS;
    }
    return JSON.parse(fs.readFileSync(MODEL_FILE, "utf-8")) as ModelsData;
  } catch {
    // Same reasoning as loadConfig: this sits on the approval path.
    return DEFAULT_MODELS;
  }
}

export function saveModels(data: ModelsData): void {
  ensureDirs();
  fs.writeFileSync(MODEL_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** Read a config file without creating it; null when missing or unreadable. */
function readConfigFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function loadConfig(mode: Mode = "standard"): Record<string, unknown> {
  if (mode === "pro") {
    // Pro keeps its own file, with credentials/approval policy layered on top
    // from the main config so those stay shared by construction.
    const own = readConfigFile(PRO_CONFIG_FILE) ?? {};
    const shared = readConfigFile(CONFIG_FILE) ?? DEFAULT_CONFIG;
    const merged: Record<string, unknown> = { ...DEFAULT_CONFIG, ...own };
    for (const key of SHARED_CONFIG_KEYS) merged[key] = shared[key] ?? DEFAULT_CONFIG[key];
    return merged;
  }
  try {
    ensureDirs();
    if (!fs.existsSync(CONFIG_FILE)) {
      saveConfig(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    // The approval gate reads this on every tool call; a directory we cannot
    // create or a file we cannot parse must fall back, not throw.
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(data: Record<string, unknown>, mode: Mode = "standard"): void {
  ensureDirs(mode);
  if (mode === "pro") {
    fs.mkdirSync(PRO_DIR, { recursive: true });
    const own = { ...data };
    for (const key of SHARED_CONFIG_KEYS) delete own[key];
    fs.writeFileSync(PRO_CONFIG_FILE, JSON.stringify(own, null, 2), "utf-8");

    // A Pro settings save that touched a shared key (password, approval policy)
    // writes it back to the main config, where the terminal and both pages read it.
    const shared = readConfigFile(CONFIG_FILE) ?? { ...DEFAULT_CONFIG };
    let changed = false;
    for (const key of SHARED_CONFIG_KEYS) {
      if (data[key] === undefined) continue;
      if (JSON.stringify(data[key]) === JSON.stringify(shared[key])) continue;
      shared[key] = data[key];
      changed = true;
    }
    if (changed) fs.writeFileSync(CONFIG_FILE, JSON.stringify(shared, null, 2), "utf-8");
    return;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** Look a model up by name across every configured provider. */
export function findModel(name: string): { provider: string; model: ModelInfo } | null {
  const wanted = name.trim();
  if (!wanted) return null;
  for (const [provider, models] of Object.entries(getModelsByProvider())) {
    const model = models.find((m) => m.name === wanted);
    if (model) return { provider, model };
  }
  return null;
}

export function getModelsByProvider(): Record<string, ModelInfo[]> {
  const data = loadModels();
  const result: Record<string, ModelInfo[]> = {};
  for (const provider of data.providers ?? []) {
    result[provider.name] = provider.models ?? [];
  }
  return result;
}

/** Resolve a provider/model pair exactly, including when names repeat across providers. */
export function resolveModelSelection(value: unknown, requireKey = true): ResolvedModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid model selection");
  const input = value as Partial<ModelSelection>;
  if (typeof input.provider !== "string" || typeof input.model !== "string" ||
      typeof input.intensity !== "string") throw new Error("provider, model and intensity are required");
  const intensity = normalizeIntensity(input.intensity);
  if (!intensity) throw new Error("invalid thinking intensity");
  const provider = loadModels().providers.find((p) => p.name === input.provider);
  if (!provider) throw new Error("unknown provider");
  const model = provider.models.find((m) => m.name === input.model);
  if (!model) throw new Error("unknown model for this provider");
  if (!modelIntensities(model).includes(intensity)) throw new Error("this model does not support that thinking intensity");
  if (requireKey && !model.api_key?.trim()) throw new Error("this model has no API key configured");
  return { provider: provider.name, model: { ...model }, intensity };
}

export function saveSession(
  messages: SessionMessage[],
  modelName: string,
  provider: string,
  intensity: string,
  cwd?: string,
  sessionId?: string,
  tokens?: TokenUsage,
  context?: ConversationContext | null,
  approvalMode?: ApprovalMode,
  plan?: PlanState | null,
  mode: Mode = "standard",
  proPreset?: string,
): string {
  ensureDirs(mode);
  const now = new Date();
  const id = sessionId ?? `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const existing = sessionId ? loadSession(sessionId, mode) : null;
  const created_at = existing ? existing.created_at : now.toISOString();

  let title = "";
  for (const msg of messages) {
    if (msg.role === "user") {
      title = (msg.content ?? "").slice(0, 80);
      break;
    }
  }

  const session: SessionData = {
    id,
    created_at,
    updated_at: now.toISOString(),
    model: modelName,
    provider,
    intensity,
    cwd: cwd ?? process.cwd(),
    title,
    messages,
    tokens,
    approval_mode: normalizeApprovalMode(approvalMode ?? existing?.approval_mode),
    ...(mode === "pro" && (proPreset ?? existing?.pro_preset)
      ? { pro_preset: proPreset ?? existing?.pro_preset } : {}),
  };
  const validContext = normalizeContext(context, messages.filter((m) => m.role !== "system").length);
  if (validContext) session.context = validContext;
  // A plan outlives the turn that produced it: reopening a conversation shows
  // how far it got, and a stopped plan is still the record of what was agreed.
  if (plan && plan.steps.length) session.plan = plan;

  const filePath = path.join(sessionDir(mode), `${id}.json`);
  // Keep the last complete transcript intact if writing or replacing fails.
  // The temporary file shares the destination directory so rename is atomic.
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = JSON.stringify(session, null, 2);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Preserve the write error. */ }
    }
    try { fs.rmSync(tempPath, { force: true }); } catch { /* Best-effort cleanup. */ }
  }
  return id;
}

export function loadSession(sessionId: string, mode: Mode = "standard"): SessionData | null {
  const filePath = path.join(sessionDir(mode), `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionData;
  } catch {
    return null;
  }
}

export function deleteSession(sessionId: string, mode: Mode = "standard"): boolean {
  const filePath = path.join(sessionDir(mode), `${sessionId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function listSessions(mode: Mode = "standard"): SessionMeta[] {
  ensureDirs(mode);
  const sessions: SessionMeta[] = [];
  const dir = sessionDir(mode);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return sessions;
  }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as SessionData;
      sessions.push({
        id: data.id ?? f.replace(/\.json$/, ""),
        created_at: data.created_at ?? "",
        updated_at: data.updated_at ?? data.created_at ?? "",
        model: data.model ?? "",
        provider: data.provider ?? "",
        intensity: data.intensity ?? "",
        cwd: data.cwd ?? "",
        title: data.title ?? "",
        message_count: (data.messages ?? []).length,
      });
    } catch {
      // ignore unreadable sessions
    }
  }
  sessions.sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at));
  return sessions;
}

/**
 * Sessions that were started in `cwd` (the directory neutrino runs in).
 * The history menu is scoped to the current project so sessions started in
 * other directories do not clutter it.
 */
export function listSessionsForCwd(cwd: string = process.cwd(), mode: Mode = "standard"): SessionMeta[] {
  return listSessions(mode).filter((s) => sameCwd(s.cwd, cwd));
}

function readAsset(...candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs
          .readFileSync(candidate, "utf-8")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
      }
    } catch {
      // continue
    }
  }
  return null;
}

export function loadLogo(): string {
  return (
    readAsset(path.join(PKG_ROOT, "logo.txt"), path.join(PKG_ROOT, "assets", "logo.txt")) ?? "NEUTRINO"
  );
}

export function loadPrompt(): string {
  return (
    readAsset(path.join(PKG_ROOT, "assets", "prompt.txt"), path.join(PKG_ROOT, "prompt.txt")) ??
    "You are Neutrino, a helpful AI coding assistant."
  );
}

/** The planning agent's system prompt. */
export function loadPlannerPrompt(): string {
  return (
    readAsset(path.join(PKG_ROOT, "assets", "planner.txt"), path.join(PKG_ROOT, "planner.txt")) ??
    "Split the user's request into ordered, independent steps a coding agent can execute one at a " +
      "time. Answer with JSON only: {\"goal\": \"...\", \"steps\": [{\"title\": \"...\"}]}."
  );
}

/** Template for the per-step system text; `{{index}}`, `{{plan}}`, … are filled in. */
export function loadStepPrompt(): string {
  return (
    readAsset(path.join(PKG_ROOT, "assets", "step.txt"), path.join(PKG_ROOT, "step.txt")) ??
    "You are executing step {{index}} of {{total}} of this plan:\n{{plan}}\n\nDo only: {{step}}\n" +
      "Verify it, then stop and report what you did."
  );
}

/** The system prompt a delegated sub-agent works from. */
export function loadSubAgentPrompt(): string {
  return (
    readAsset(path.join(PKG_ROOT, "assets", "subagent.txt"), path.join(PKG_ROOT, "subagent.txt")) ??
    "You are a sub-agent working on one task delegated by another agent. You cannot ask the user " +
      "anything and you cannot delegate further. Do the task with the tools you have, verify it, and " +
      "report what you did and what you found in your final message."
  );
}

/**
 * Whether a turn is planned before it is executed. Unset means on: the plan is
 * the default workflow, and only an explicit `false` turns it off.
 *
 * `NEUTRINO_PLAN=off` overrides both ways for a single run, the way the other
 * environment variables override the saved configuration.
 */
export function planFirstEnabled(mode: Mode = "standard"): boolean {
  const override = String(process.env.NEUTRINO_PLAN ?? "").trim().toLowerCase();
  if (override === "off" || override === "0" || override === "false" || override === "no") return false;
  if (override === "on" || override === "1" || override === "true" || override === "yes") return true;
  return loadConfig(mode).plan_first !== false;
}

let cachedVersion: string | null = null;

/**
 * Read the CLI version straight from the package's `package.json` so the
 * displayed version can never drift out of sync with the published package.
 * The result is cached after the first successful read.
 */
export function loadVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    cachedVersion = "";
  }
  return cachedVersion;
}
