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

export interface ModelInfo {
  name: string;
  url: string;
  api_key: string;
  supports_streaming: boolean;
  /** Context capacity in tokens; omitted models use 1M. */
  context_window?: number;
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
export function modelContextWindow(provider: string, model: ModelInfo): number {
  const saved = loadModels().providers.find((p) => p.name === provider)?.models.find((m) => m.name === model.name);
  return contextWindow((saved ?? model).context_window);
}

export function contextCompressionThreshold(provider: string, model: ModelInfo): number {
  return Math.max(1, Math.floor(modelContextWindow(provider, model) * CONTEXT_COMPRESSION_RATIO));
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

export const DEFAULT_CONFIG: Record<string, unknown> = {
  language: "en",
  theme: "default",
  default_intensity: "High",
  // Plan a request into steps before answering it: the planner agent writes the
  // plan, the worker executes one step per turn. Off = answer in one pass.
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
}

export type ApprovalMode = "request" | "auto";

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  // Config files are hand-edited: "Auto" or " autO " must not silently
  // downgrade the conversation to a prompt on every tool call.
  return typeof value === "string" && value.trim().toLowerCase() === "auto"
    ? "auto"
    : "request";
}

export function ensureDirs(): void {
  fs.mkdirSync(NEUTRINO_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
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

export function loadConfig(): Record<string, unknown> {
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

export function saveConfig(data: Record<string, unknown>): void {
  ensureDirs();
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
  if (!INTENSITY_LEVELS.includes(input.intensity)) throw new Error("invalid thinking intensity");
  const provider = loadModels().providers.find((p) => p.name === input.provider);
  if (!provider) throw new Error("unknown provider");
  const model = provider.models.find((m) => m.name === input.model);
  if (!model) throw new Error("unknown model for this provider");
  if (requireKey && !model.api_key?.trim()) throw new Error("this model has no API key configured");
  return { provider: provider.name, model: { ...model }, intensity: input.intensity };
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
): string {
  ensureDirs();
  const now = new Date();
  const id = sessionId ?? `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const existing = sessionId ? loadSession(sessionId) : null;
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
  };
  const validContext = normalizeContext(context, messages.filter((m) => m.role !== "system").length);
  if (validContext) session.context = validContext;
  // A plan outlives the turn that produced it: reopening a conversation shows
  // how far it got, and a stopped plan is still the record of what was agreed.
  if (plan && plan.steps.length) session.plan = plan;

  const filePath = path.join(SESSION_DIR, `${id}.json`);
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

export function loadSession(sessionId: string): SessionData | null {
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionData;
  } catch {
    return null;
  }
}

export function deleteSession(sessionId: string): boolean {
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function listSessions(): SessionMeta[] {
  ensureDirs();
  const sessions: SessionMeta[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return sessions;
  }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), "utf-8")) as SessionData;
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
export function listSessionsForCwd(cwd: string = process.cwd()): SessionMeta[] {
  return listSessions().filter((s) => sameCwd(s.cwd, cwd));
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
export function planFirstEnabled(): boolean {
  const override = String(process.env.NEUTRINO_PLAN ?? "").trim().toLowerCase();
  if (override === "off" || override === "0" || override === "false" || override === "no") return false;
  if (override === "on" || override === "1" || override === "true" || override === "yes") return true;
  return loadConfig().plan_first !== false;
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
