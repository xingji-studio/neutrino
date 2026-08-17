import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export type AgentId = "claude" | "codex" | "opencode";

export interface AgentSessionMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model: string;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

const HOME = os.homedir();

function parseJsonlLines(filePath: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") out.push(v as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
          return (b as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function iso(ms: unknown): string {
  const n = typeof ms === "number" ? ms : typeof ms === "string" ? Number(ms) : 0;
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString();
}

function cleanTitle(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

// ---------------- Claude Code ----------------

function claudeProjectDirs(): string[] {
  const base = path.join(HOME, ".claude", "projects");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(base, e.name));
}

function claudeTitle(lines: Record<string, unknown>[]): string {
  for (const o of lines) {
    if (o.type === "user") {
      const t = contentText((o.message as { content?: unknown })?.content).trim();
      if (t) return t;
    }
  }
  return "";
}

function listClaude(): AgentSessionMeta[] {
  const metas: AgentSessionMeta[] = [];
  for (const dir of claudeProjectDirs()) {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      const id = f.slice(0, -".jsonl".length);
      const title = cleanTitle(claudeTitle(parseJsonlLines(fp)) || id.slice(0, 8));
      metas.push({
        id,
        title: title.slice(0, 80),
        created_at: iso(st.birthtimeMs ?? st.mtimeMs),
        updated_at: iso(st.mtimeMs),
        model: "",
      });
    }
  }
  metas.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return metas;
}

function loadClaude(id: string): AgentMessage[] {
  for (const dir of claudeProjectDirs()) {
    const fp = path.join(dir, `${id}.jsonl`);
    if (!fs.existsSync(fp)) continue;
    const out: AgentMessage[] = [];
    for (const o of parseJsonlLines(fp)) {
      if (o.type === "user") {
        const t = contentText((o.message as { content?: unknown })?.content).trim();
        if (t) out.push({ role: "user", content: t });
      } else if (o.type === "assistant") {
        const t = contentText((o.message as { content?: unknown })?.content).trim();
        if (t) out.push({ role: "assistant", content: t });
      }
    }
    return out;
  }
  return [];
}

// ---------------- Codex ----------------

function codexIndex(): Map<string, { title: string; updated_at: string }> {
  const map = new Map<string, { title: string; updated_at: string }>();
  const idx = path.join(HOME, ".codex", "session_index.jsonl");
  for (const o of parseJsonlLines(idx)) {
    if (typeof o.id === "string" && o.id) {
      map.set(o.id, {
        title: typeof o.thread_name === "string" ? o.thread_name : "",
        updated_at: typeof o.updated_at === "string" ? o.updated_at : "",
      });
    }
  }
  return map;
}

function codexRolloutId(filename: string): string | null {
  const m = filename.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/);
  return m ? m[1] : null;
}

function codexRolloutFiles(): Map<string, string> {
  const map = new Map<string, string>();
  const roots = [
    path.join(HOME, ".codex", "sessions"),
    path.join(HOME, ".codex", "archived_sessions"),
  ];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".jsonl")) {
        const id = codexRolloutId(e.name);
        if (!id) continue;
        const prev = map.get(id);
        if (!prev) {
          map.set(id, p);
          continue;
        }
        let pm = 0;
        let cm = 0;
        try {
          pm = fs.statSync(prev).mtimeMs;
        } catch {}
        try {
          cm = fs.statSync(p).mtimeMs;
        } catch {}
        if (cm > pm) map.set(id, p);
      }
    }
  };
  for (const r of roots) walk(r);
  return map;
}

function codexMessageText(payload: Record<string, unknown>): string {
  if (payload.role !== "user" && payload.role !== "assistant") return "";
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
        return (c as { text: string }).text;
      }
      return "";
    })
    .join("")
    .trim();
}

function listCodex(): AgentSessionMeta[] {
  const index = codexIndex();
  const files = codexRolloutFiles();
  const metas: AgentSessionMeta[] = [];
  for (const [id, fp] of files) {
    const info = index.get(id);
    let title = info?.title ?? "";
    let updated = info?.updated_at ?? "";
    if (!updated) {
      try {
        updated = iso(fs.statSync(fp).mtimeMs);
      } catch {}
    }
    if (!title) {
      for (const o of parseJsonlLines(fp)) {
        if (o.type === "response_item") {
          const t = codexMessageText((o.payload as Record<string, unknown>) ?? {});
          if (t) {
            title = t;
            break;
          }
        }
      }
      if (!title) title = id.slice(0, 8);
    }
    metas.push({
      id,
      title: cleanTitle(title).slice(0, 80),
      created_at: updated,
      updated_at: updated,
      model: "",
    });
  }
  metas.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return metas;
}

function loadCodex(id: string): AgentMessage[] {
  const files = codexRolloutFiles();
  const fp = files.get(id);
  if (!fp) return [];
  const out: AgentMessage[] = [];
  for (const o of parseJsonlLines(fp)) {
    if (o.type !== "response_item") continue;
    const payload = (o.payload as Record<string, unknown>) ?? {};
    if (payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = codexMessageText(payload);
    if (text) out.push({ role, content: text });
  }
  return out;
}

// ---------------- OpenCode ----------------

function opencodeDataDir(): string | null {
  const candidates: string[] = [];
  if (process.env.XDG_DATA_HOME) {
    candidates.push(path.join(process.env.XDG_DATA_HOME, "opencode"));
  }
  candidates.push(path.join(HOME, ".local", "share", "opencode"));
  candidates.push(path.join(HOME, "Library", "Application Support", "opencode"));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "opencode.db"))) return c;
  }
  return null;
}

let opencodeDb: unknown = null;

function opencodeDbHandle(): { prepare(sql: string): any } | null {
  if (opencodeDb) return opencodeDb as { prepare(sql: string): any };
  const dir = opencodeDataDir();
  if (!dir) return null;
  try {
    process.env.NODE_NO_WARNINGS = "1";
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string, o?: object) => any };
    opencodeDb = new DatabaseSync(path.join(dir, "opencode.db"), { readOnly: true });
    return opencodeDb as { prepare(sql: string): any };
  } catch {
    return null;
  }
}

function opencodeModelName(modelJson: unknown): string {
  if (typeof modelJson !== "string" || !modelJson) return "";
  try {
    const m = JSON.parse(modelJson) as { id?: string; providerID?: string; provider?: string };
    const id = m.id ?? "";
    const pid = m.providerID ?? m.provider ?? "";
    return pid && id ? `${pid}/${id}` : id;
  } catch {
    return "";
  }
}

function listOpencode(): AgentSessionMeta[] {
  const db = opencodeDbHandle();
  if (!db) return [];
  try {
    const rows = db
      .prepare("SELECT id, title, agent, model, time_created, time_updated FROM session ORDER BY time_updated DESC")
      .all();
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id ?? ""),
      title: cleanTitle(typeof r.title === "string" ? r.title : "").slice(0, 80),
      created_at: iso(r.time_created),
      updated_at: iso(r.time_updated),
      model: opencodeModelName(r.model) || (typeof r.agent === "string" ? r.agent : ""),
    }));
  } catch {
    return [];
  }
}

function loadOpencode(id: string): AgentMessage[] {
  const db = opencodeDbHandle();
  if (!db) return [];
  try {
    const msgs = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(id);
    const out: AgentMessage[] = [];
    for (const m of msgs as Array<{ id: string; data: string }>) {
      let data: { role?: string };
      try {
        data = JSON.parse(m.data) as { role?: string };
      } catch {
        continue;
      }
      if (data.role !== "user" && data.role !== "assistant") continue;
      const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id").all(m.id);
      let text = "";
      for (const pr of parts as Array<{ data: string }>) {
        let pd: { type?: string; text?: string };
        try {
          pd = JSON.parse(pr.data) as { type?: string; text?: string };
        } catch {
          continue;
        }
        if (pd.type === "text" && typeof pd.text === "string") text += pd.text;
      }
      if (text.trim()) out.push({ role: data.role as "user" | "assistant", content: text.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------- Public API ----------------

export function listAgentSessions(agent: AgentId): AgentSessionMeta[] {
  if (agent === "claude") return listClaude();
  if (agent === "codex") return listCodex();
  return listOpencode();
}

export function loadAgentMessages(agent: AgentId, id: string): AgentMessage[] {
  if (agent === "claude") return loadClaude(id);
  if (agent === "codex") return loadCodex(id);
  return loadOpencode(id);
}
