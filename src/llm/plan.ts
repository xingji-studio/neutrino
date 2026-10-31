/**
 * Plan-first turns.
 *
 * A request is answered in two passes. A *planner* agent turns the user's text
 * into an ordered list of independent steps; a *worker* agent is then handed one
 * step at a time and never sees the rest of the plan as work it may start. That
 * split is what makes the later work explicit: every step names one deliverable,
 * so it can be executed, verified and shown on its own.
 *
 * This module is deliberately free of I/O: it parses the planner's answer, turns
 * the plan into prompt text, and lays the plan out as the rows of the info card.
 * The model calls themselves live in the two agent loops.
 */
import { displayWidth, ellipsize } from "../width.js";

/** `active` is the step the worker is on; the rest are its past and future. */
export type PlanStepStatus = "pending" | "active" | "done" | "failed";

export interface PlanStep {
  /** One imperative action, in the language of the request. */
  title: string;
  /** What the step needs: files, parameters, acceptance criteria. */
  detail?: string;
  status: PlanStepStatus;
}

/** The plan of one user turn, persisted with the session. */
export interface PlanState {
  /** The request restated in one line. */
  goal: string;
  steps: PlanStep[];
  /** The turn stopped before the last step: paused, cancelled, or interrupted. */
  stopped?: boolean;
}

/**
 * One step is not a plan, it is the answer: such a turn runs as a plain turn.
 * The ceiling keeps the card readable and the turn's cost proportionate.
 */
export const PLAN_MIN_STEPS = 2;
export const PLAN_MAX_STEPS = 10;
export const PLAN_MAX_TITLE = 160;
export const PLAN_MAX_DETAIL = 400;

// ------------------------------------------------------------------ parsing

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeStep(value: unknown): PlanStep | null {
  if (typeof value === "string") {
    const title = cleanText(value, PLAN_MAX_TITLE);
    return title ? { title, status: "pending" } : null;
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  // Models name the same field differently; accept the common spellings rather
  // than rejecting a plan over a key name.
  const title = cleanText(o.title ?? o.step ?? o.task ?? o.action, PLAN_MAX_TITLE);
  if (!title) return null;
  const detail = cleanText(o.detail ?? o.description ?? o.how ?? o.acceptance, PLAN_MAX_DETAIL);
  return { title, status: "pending", ...(detail ? { detail } : {}) };
}

/** Turn an already-parsed planner answer into a plan, or null when unusable. */
export function normalizePlan(value: unknown): PlanState | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const rawSteps = Array.isArray(value) ? value : Array.isArray(o.steps) ? o.steps : Array.isArray(o.plan) ? o.plan : null;
  if (!rawSteps) return null;
  const steps: PlanStep[] = [];
  for (const item of rawSteps) {
    const step = normalizeStep(item);
    if (step) steps.push(step);
    if (steps.length >= PLAN_MAX_STEPS) break;
  }
  if (steps.length < PLAN_MIN_STEPS) return null;
  const goal = cleanText(o.goal ?? o.title ?? o.summary ?? o.request, 240);
  return { goal, steps };
}

/**
 * Every top-level `{…}` block in the text, in order.
 *
 * A planner is asked for bare JSON but models still wrap it in a fence or add a
 * sentence before it; scanning for a balanced object finds it without guessing
 * where the JSON starts and stops. Strings and escapes are tracked so a brace
 * inside a step title cannot end the scan early.
 */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/** A numbered or bulleted list, for a planner that answered in prose. */
function planFromList(text: string): PlanState | null {
  const steps: PlanStep[] = [];
  for (const line of text.split("\n")) {
    // "1." "1)" "1、" and bullets all show up in practice, with or without a
    // space after the marker.
    const match = /^\s*(?:\d+\s*[.):、]\s*|[-*•]\s+)(.+)$/.exec(line);
    if (!match) continue;
    const title = cleanText(match[1], PLAN_MAX_TITLE);
    if (!title) continue;
    steps.push({ title, status: "pending" });
    if (steps.length >= PLAN_MAX_STEPS) break;
  }
  if (steps.length < PLAN_MIN_STEPS) return null;
  return { goal: "", steps };
}

/**
 * Read a planner answer. JSON first, because that is what the prompt asks for,
 * then a numbered list so a model that ignores the format still produces a
 * usable plan. Anything else is "no plan": the turn then runs as before.
 */
export function parsePlan(text: string): PlanState | null {
  const raw = String(text ?? "").trim();
  if (!raw || /^\[Error/.test(raw)) return null;
  for (const candidate of jsonCandidates(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const plan = normalizePlan(value);
    if (plan) return plan;
  }
  return planFromList(raw);
}

// ---------------------------------------------------------------- prompting

export interface PlannerInput {
  /** The request being planned. */
  request: string;
  /** The conversation before that request, oldest first. */
  transcript?: string;
  /** Directory the work happens in. */
  cwd?: string;
}

/**
 * The user turn handed to the planner agent. The planner gets no tools, so
 * everything it needs to make the steps concrete is in this text: where the
 * work happens, what was said before, and what is being asked now.
 */
export function buildPlannerInput(input: PlannerInput): string {
  const parts: string[] = [];
  if (input.cwd) parts.push(`Working directory: ${input.cwd}`);
  const transcript = (input.transcript ?? "").trim();
  if (transcript) parts.push(`Conversation so far (oldest first):\n${transcript}`);
  parts.push(`Current request:\n${input.request.trim()}`);
  return parts.join("\n\n");
}

/** The plan as numbered text: what the worker and the reviewers read. */
export function planSpec(plan: PlanState): string {
  return plan.steps
    .map((step, i) => `${i + 1}. ${step.title}${step.detail ? `\n   detail: ${step.detail}` : ""}`)
    .join("\n");
}

/**
 * The plan as the user reads it in the transcript. It is an ordinary assistant
 * message on purpose: it is saved, replayed, folded and sent back to the model
 * exactly like any other answer.
 *
 * A detail stays on its step's line: markdown renderers fold an indented line
 * into the list item before it, which would run two steps together in the log.
 */
export function planMessage(plan: PlanState): string {
  const count = plan.steps.length;
  const lines = [`Plan · ${count} step${count === 1 ? "" : "s"}`];
  if (plan.goal) lines.push(`> ${plan.goal}`);
  plan.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.title}${step.detail ? ` — ${step.detail}` : ""}`);
  });
  return lines.join("\n");
}

/**
 * The system text for one step. It repeats the whole plan so the worker knows
 * where the step sits, and states the two rules the split exists for: do only
 * this step, and stop when it is verified.
 */
export function renderStepDirective(template: string, plan: PlanState, index: number): string {
  const step = plan.steps[index];
  const detail = step?.detail ? `Detail for this step: ${step.detail}` : "";
  return template
    .replace(/\{\{index\}\}/g, String(index + 1))
    .replace(/\{\{total\}\}/g, String(plan.steps.length))
    .replace(/\{\{plan\}\}/g, planSpec(plan))
    .replace(/\{\{step\}\}/g, step?.title ?? "")
    .replace(/\{\{detail\}\}/g, detail)
    .trim();
}

/** How far a plan got. Used by the card header and by tests. */
export function planProgress(plan: PlanState): { done: number; total: number; active: number } {
  let done = 0;
  let active = -1;
  plan.steps.forEach((step, i) => {
    if (step.status === "done") done++;
    if (step.status === "active" && active < 0) active = i;
  });
  return { done, total: plan.steps.length, active };
}

// ------------------------------------------------------- plan bookkeeping
//
// Both agent loops (terminal and browser) keep the same plan state machine, so
// the transitions live here instead of being copied into each of them.

/** A plan loaded from disk was, by definition, no longer running. */
export function resumePlan(loaded: PlanState | null | undefined): PlanState | null {
  if (!loaded || !Array.isArray(loaded.steps)) return null;
  // Session files are hand-editable: drop entries that are not steps rather
  // than rendering "undefined" in the card.
  const steps = loaded.steps.filter((step) => step && typeof step.title === "string" && step.title.trim());
  if (steps.length === 0) return null;
  loaded.steps = steps;
  for (const step of steps) {
    if (step.status !== "pending" && step.status !== "active" && step.status !== "done" && step.status !== "failed") {
      step.status = "pending";
    }
    if (step.status === "active") {
      // Its worker is gone: the card must not claim a step is running, and the
      // plan is now a record of where the turn stopped.
      step.status = "pending";
      loaded.stopped = true;
    }
  }
  return loaded;
}

/** Point the plan at one step. Returns false when there was nothing to change. */
export function advancePlan(plan: PlanState | null, index: number, status: PlanStepStatus): boolean {
  const step = plan?.steps[index];
  if (!plan || !step) return false;
  step.status = status;
  if (status === "active") plan.stopped = false;
  return true;
}

/** A turn that cannot continue must not leave a step looking alive. */
export function stopPlan(plan: PlanState | null): boolean {
  if (!plan) return false;
  const active = plan.steps.find((step) => step.status === "active");
  if (!active) return false;
  active.status = "pending";
  plan.stopped = true;
  return true;
}

/** The message shape both loops share: enough to tell the planner what happened. */
export interface TranscriptMessage {
  role: string;
  content?: string;
  name?: string;
  result?: string;
}

/** The user message a turn answers. */
export function lastRequestText(messages: readonly TranscriptMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return message.content ?? "";
  }
  return "";
}

/** How many earlier messages and how much of each the planner is shown. */
const PLANNER_TRANSCRIPT_MESSAGES = 8;
const PLANNER_TRANSCRIPT_CHARS = 600;
const PLANNER_TOOL_CHARS = 400;

/**
 * The exchanges before the current request, for the planner.
 *
 * Tool output is clipped hard: the planner needs to know what was done, not to
 * re-read it, and a long log must not crowd the request out of its own plan.
 */
export function planTranscript(messages: readonly TranscriptMessage[]): string {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return "";
  const from = Math.max(0, lastUser - PLANNER_TRANSCRIPT_MESSAGES);
  const lines: string[] = [];
  for (let i = from; i < lastUser; i++) {
    const message = messages[i];
    if (message.role === "system") continue;
    if (message.role === "tool") {
      lines.push(`TOOL ${message.name ?? "tool"}: ${clipText(message.result ?? "", PLANNER_TOOL_CHARS)}`);
    } else if (message.role === "summary") {
      lines.push(`SUMMARY: ${clipText(message.content ?? "", PLANNER_TOOL_CHARS)}`);
    } else {
      lines.push(`${message.role.toUpperCase()}: ${clipText(message.content ?? "", PLANNER_TRANSCRIPT_CHARS)}`);
    }
  }
  return lines.join("\n");
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

// ------------------------------------------------------------------ card UI

/**
 * One row of the info card. The kind carries the meaning (and therefore the
 * colour); the text is what goes on screen.
 */
export type PlanRowKind =
  | "header"
  | "step-active"
  | "step-done"
  | "step-pending"
  | "step-failed"
  | "connector"
  | "more"
  | "line";

export interface PlanRow {
  kind: PlanRowKind;
  text: string;
}

// Deliberately plain glyphs: every one of these is already used elsewhere in the
// terminal UI, so a font that draws those lines draws the plan too.
const STEP_GLYPH: Record<PlanStepStatus, string> = {
  pending: "○",
  active: "●",
  done: "✓",
  failed: "✗",
};

/**
 * Lay the plan out as a vertical timeline, top to bottom in execution order.
 *
 * A finished step is drawn dark, a step still to come is drawn lit, and the step
 * being worked on is the one highlighted row — so the card reads as "these are
 * done, this is running, these are next" without a legend. When the plan is
 * longer than the room, a window around the running step is shown with the
 * number of steps above and below it, rather than dropping the middle.
 */
export function planCardRows(plan: PlanState, options: { width: number; maxRows: number }): PlanRow[] {
  const width = Math.max(12, Math.floor(options.width));
  const maxRows = Math.max(2, Math.floor(options.maxRows));
  const steps = plan.steps;
  const { done } = planProgress(plan);
  const failed = steps.some((step) => step.status === "failed");
  let header = `Plan · ${done}/${steps.length}`;
  if (failed) header += " · failed";
  else if (done === steps.length) header += " · done";
  else if (plan.stopped) header += " · stopped";
  const rows: PlanRow[] = [{ kind: "header", text: ellipsize(header, width) }];
  const available = maxRows - rows.length;
  if (available <= 0) return rows;

  const focus = (() => {
    const active = steps.findIndex((step) => step.status === "active");
    if (active >= 0) return active;
    const firstFailed = steps.findIndex((step) => step.status === "failed");
    if (firstFailed >= 0) return firstFailed;
    const firstPending = steps.findIndex((step) => step.status === "pending");
    if (firstPending >= 0) return firstPending;
    return Math.max(0, steps.length - 1);
  })();

  // A step occupies a node row plus the connector below it, except the last
  // visible one; the "… more" markers take a row each.
  let span = Math.max(1, Math.min(steps.length, Math.floor((available + 1) / 2)));
  let start = 0;
  let end = steps.length;
  for (;;) {
    start = Math.max(0, Math.min(focus - Math.floor(span / 2), steps.length - span));
    end = start + span;
    const markers = (start > 0 ? 1 : 0) + (end < steps.length ? 1 : 0);
    if (span * 2 - 1 + markers <= available || span <= 1) break;
    span -= 1;
  }

  const plural = (n: number): string => `step${n === 1 ? "" : "s"}`;
  if (start > 0) {
    rows.push({ kind: "more", text: ellipsize(`… ${start} earlier ${plural(start)}`, width) });
  }
  for (let i = start; i < end; i++) {
    const step = steps[i];
    rows.push({
      kind: `step-${step.status}`,
      text: ellipsize(`${STEP_GLYPH[step.status]} ${i + 1}. ${step.title}`, width),
    });
    if (i < end - 1) rows.push({ kind: "connector", text: "│" });
  }
  if (end < steps.length) {
    const later = steps.length - end;
    rows.push({ kind: "more", text: ellipsize(`… ${later} later ${plural(later)}`, width) });
  }
  return rows;
}

/** The width a card row actually needs, in columns. */
export function planRowsWidth(rows: PlanRow[]): number {
  let width = 0;
  for (const row of rows) width = Math.max(width, displayWidth(row.text));
  return width;
}
