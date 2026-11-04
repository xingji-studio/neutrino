import { loadAgentSession, safeAgentSessionId, type AgentId } from "./agents.js";
import {
  loadConfig, loadSession, normalizeApprovalMode, saveSession,
  type Mode, type ModelSelection, type SessionData, type SessionMessage,
} from "./config.js";

export class SessionMigrationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Copy the readable conversation into a fresh native transcript, ready to resume. */
export function migrateAgentSession(
  agent: AgentId,
  sourceId: string,
  cwd: string,
  selection: ModelSelection,
  mode: Mode = "standard",
  proPreset?: string,
): SessionData {
  if (!safeAgentSessionId(sourceId)) throw new SessionMigrationError(400, "invalid session id");
  const source = loadAgentSession(agent, sourceId, cwd);
  if (!source) throw new SessionMigrationError(404, "session not found in this working directory");
  // Preserve the roles and text exposed by the history viewer. Resumed native
  // sessions supply their own system prompt and model/tool configuration.
  const messages: SessionMessage[] = source.messages.map(({ role, content }) => ({ role, content }));
  if (!messages.length) throw new SessionMigrationError(400, "this session has no messages to migrate");
  let id: string;
  try {
    id = saveSession(
      messages, selection.model, selection.provider, selection.intensity, source.cwd,
      undefined, { prompt: 0, completion: 0 }, undefined, normalizeApprovalMode(loadConfig(mode).approval_mode),
      undefined, mode, proPreset,
    );
  } catch (error) {
    throw new SessionMigrationError(500, error instanceof Error ? error.message : String(error));
  }
  const saved = loadSession(id, mode);
  if (!saved) throw new SessionMigrationError(500, "could not read the migrated conversation");
  return saved;
}
