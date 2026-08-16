import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}

export function ensureDirs(): void {
  fs.mkdirSync(NEUTRINO_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

export function loadModels(): ModelsData {
  ensureDirs();
  if (!fs.existsSync(MODEL_FILE)) {
    saveModels(DEFAULT_MODELS);
    return DEFAULT_MODELS;
  }
  try {
    return JSON.parse(fs.readFileSync(MODEL_FILE, "utf-8")) as ModelsData;
  } catch {
    return DEFAULT_MODELS;
  }
}

export function saveModels(data: ModelsData): void {
  ensureDirs();
  fs.writeFileSync(MODEL_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function loadConfig(): Record<string, unknown> {
  ensureDirs();
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(data: Record<string, unknown>): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function getModelsByProvider(): Record<string, ModelInfo[]> {
  const data = loadModels();
  const result: Record<string, ModelInfo[]> = {};
  for (const provider of data.providers ?? []) {
    result[provider.name] = provider.models ?? [];
  }
  return result;
}

export function saveSession(
  messages: SessionMessage[],
  modelName: string,
  provider: string,
  intensity: string,
  cwd?: string,
  sessionId?: string,
  tokens?: TokenUsage,
): string {
  ensureDirs();
  const now = new Date();
  const id = sessionId ?? now.toISOString().replace(/[:.]/g, "-");
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
  };

  const filePath = path.join(SESSION_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
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
