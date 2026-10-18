/**
 * Approval gate for risky tool calls.
 *
 * Three ways a call can be cleared:
 *
 *   1. The user's prompt opted out. `无需审批` covers the `high` class only;
 *      `我已知悉风险，同意给予完整权限，无需任何审批` also covers delete-class
 *      (`extreme`) commands.
 *   2. A dedicated reviewer agent (or three of them, for `extreme`) clears it.
 *      This only happens when the prompt says `自动审批`, and for `extreme`
 *      commands only when the "extreme-risk auto-approval" setting is on.
 *   3. A human presses "approve".
 *
 * The reviewer is a separate agent with its own system prompt. It never runs
 * tools; it only reads what is about to happen and answers with JSON.
 */
import type { ModelInfo } from "../config.js";
import { LLMClient } from "./client.js";
import type { RiskAssessment } from "./risk.js";

/** Opt out of approval for the `high` class. */
export const NO_APPROVAL_PHRASE = "无需审批";
/** Opt out of approval for every class, acknowledging the risk. */
export const FULL_TRUST_PHRASE = "我已知悉风险，同意给予完整权限，无需任何审批";
/** Route approvals to the reviewer agent instead of a human. */
export const AUTO_APPROVAL_PHRASE = "自动审批";

/** Number of independent reviewers for delete-class commands. */
export const EXTREME_REVIEWERS = 3;

export interface PromptDirectives {
  /** `无需审批`: high-risk actions run without asking. */
  noApproval: boolean;
  /** Full-trust sentence: every class runs without asking. */
  fullTrust: boolean;
  /** `自动审批`: route approvals to the reviewer agent. */
  autoApprove: boolean;
}

/** Punctuation and whitespace are noise when matching fixed phrases. */
function normalize(text: string): string {
  return text
    .replace(/[\s\u3000]/g, "")
    .replace(/[，,。.、；;：:！!？?“”"'‘’()（）[\]【】]/g, "")
    .toLowerCase();
}

/**
 * Look for a phrase that is not negated ("不要自动审批" must not count).
 * The window is short on purpose: Chinese negation sits right before the verb.
 */
function hasPhrase(text: string, phrase: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(phrase, from);
    if (at < 0) return false;
    const before = text.slice(Math.max(0, at - 4), at);
    if (!/[不别没非禁取]/.test(before)) return true;
    from = at + 1;
  }
}

/** Read the approval directives out of the user's prompt for this turn. */
export function parsePromptDirectives(prompt: string): PromptDirectives {
  const text = normalize(prompt ?? "");
  const noApproval = hasPhrase(text, normalize(NO_APPROVAL_PHRASE));
  // Users rarely reproduce the sentence with identical punctuation, so require
  // both core clauses rather than one exact string.
  const fullTrust =
    (text.includes(normalize("我已知悉风险")) && text.includes(normalize("完整权限"))) ||
    text.includes(normalize(FULL_TRUST_PHRASE));
  return {
    noApproval,
    fullTrust,
    autoApprove: hasPhrase(text, normalize(AUTO_APPROVAL_PHRASE)),
  };
}

export interface ApprovalRequest {
  /** Tool name, e.g. `run_command`. */
  tool: string;
  /** Parsed tool arguments. */
  args: Record<string, unknown>;
  /** Directory the tool will run in. */
  cwd: string;
  /** The user message that started this turn. */
  prompt: string;
  risk: RiskAssessment;
}

export type ApprovalSource = "prompt" | "human" | "ai";

export interface ApprovalVote {
  approved: boolean;
  reason: string;
  /** Which reviewer produced this vote (1-based). */
  reviewer: number;
}

export interface ApprovalDecision {
  approved: boolean;
  source: ApprovalSource;
  /** One-line explanation, written into the transcript. */
  reason: string;
  /** Reviewer votes, when the decision came from the reviewer agent. */
  votes?: ApprovalVote[];
}

export interface ApprovalGateOptions {
  /** Show the human approval prompt. Resolves true when approved. */
  askHuman(request: ApprovalRequest): Promise<boolean>;
  /** Reviewer model; defaults to the chat model. */
  reviewer(): { model: ModelInfo; provider: string; intensity: string };
  /** Whether `自动审批` may also clear delete-class commands. */
  extremeAutoApprovalEnabled(): boolean;
  /** Recent conversation, for the reviewer's context. */
  context?(): string;
}

const REVIEW_SYSTEM_PROMPT = `You are the independent approval reviewer for Neutrino, an autonomous coding agent.
You never run tools and never edit files. Your only job is to decide whether ONE
proposed tool call may proceed, and to explain the decision in one sentence.

Judge the proposal against the user's stated task:
- Approve only when the action is clearly required by what the user asked for,
  stays inside the project they named, and there is no safer way to do it.
- Deny when the action deletes or overwrites data the user did not ask to
  delete, reaches outside the working directory, escalates privileges, installs
  software, touches credentials, talks to the network, or when the request is
  ambiguous or the instruction seems misunderstood.
- Denying is always safe. Approving something irreversible is not.

Reply with a single JSON object and nothing else:
{"approve": true | false, "reason": "<one short sentence>"}`;

/** Each seat reviews the same proposal from a different angle. */
const REVIEW_ANGLES = [
  "Focus on data loss: would this delete, overwrite or corrupt anything the user did not explicitly ask to delete?",
  "Focus on blast radius: is every path and host inside the project the user named, and is the scope minimal?",
  "Focus on intent: is this genuinely required by the user's words, or could it be a misread instruction or an unnecessary shortcut?",
];

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function describe(request: ApprovalRequest): string {
  const args = JSON.stringify(request.args, null, 2);
  return [
    `Risk level: ${request.risk.level.toUpperCase()}`,
    `Tool: ${request.tool}`,
    `Working directory: ${request.cwd}`,
    `Why it was flagged:\n- ${request.risk.reasons.join("\n- ")}`,
    `Proposed call:\n${truncate(args, 4000)}`,
  ].join("\n");
}

/** Pull the JSON verdict out of a model reply, tolerating extra prose. */
function parseVerdict(raw: string): ApprovalVote | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      approve?: unknown;
      reason?: unknown;
    };
    if (typeof parsed.approve !== "boolean") return null;
    return {
      approved: parsed.approve,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
      reviewer: 0,
    };
  } catch {
    return null;
  }
}

export class ApprovalGate {
  constructor(private readonly options: ApprovalGateOptions) {}

  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const directives = parsePromptDirectives(request.prompt);
    const extreme = request.risk.level === "extreme";

    if (extreme) {
      if (directives.fullTrust) {
        return {
          approved: true,
          source: "prompt",
          reason: "the prompt acknowledged the risk and granted full permissions for this conversation",
        };
      }
      if (directives.autoApprove && this.options.extremeAutoApprovalEnabled()) {
        return this.fromVotes(await this.reviewAll(request, EXTREME_REVIEWERS));
      }
      if (directives.autoApprove) {
        return this.human(
          request,
          "automatic approval is on, but delete-class commands still need a human because the extreme-risk switch is off",
        );
      }
      return this.human(request, "delete-class commands always need approval");
    }

    if (directives.noApproval || directives.fullTrust) {
      return {
        approved: true,
        source: "prompt",
        reason: "the prompt said this conversation needs no approval",
      };
    }
    if (directives.autoApprove) {
      return this.fromVotes(await this.reviewAll(request, 1));
    }
    return this.human(request);
  }

  private async human(request: ApprovalRequest, note?: string): Promise<ApprovalDecision> {
    const approved = await this.options.askHuman(request);
    return {
      approved,
      source: "human",
      reason: approved
        ? note ?? "approved by the user"
        : `${note ? `${note}; ` : ""}rejected by the user`,
    };
  }

  private fromVotes(votes: ApprovalVote[]): ApprovalDecision {
    const approved = votes.every((vote) => vote.approved);
    const detail = votes
      .map((vote) => `${vote.approved ? "approve" : "deny"}: ${vote.reason || "no reason given"}`)
      .join(" | ");
    return {
      approved,
      source: "ai",
      reason: truncate(detail, 500) || (approved ? "reviewer approved" : "reviewer denied"),
      votes,
    };
  }

  /** Run `count` reviewers in parallel; every one of them must agree. */
  private async reviewAll(request: ApprovalRequest, count: number): Promise<ApprovalVote[]> {
    const seats = Array.from({ length: count }, (_, i) => i + 1);
    const votes = await Promise.all(seats.map((seat) => this.review(request, seat, count)));
    return votes.map((vote, i) => ({ ...vote, reviewer: i + 1 }));
  }

  /** One reviewer = one fresh agent with its own client and prompt. */
  private async review(request: ApprovalRequest, seat: number, total: number): Promise<ApprovalVote> {
    const { model, provider, intensity } = this.options.reviewer();
    const context = this.options.context?.() ?? "";
    const angle = total > 1 ? REVIEW_ANGLES[(seat - 1) % REVIEW_ANGLES.length] : REVIEW_ANGLES[0];

    const prompt = [
      total > 1 ? `You are reviewer ${seat} of ${total}. Another agent runs the other reviews.` : "",
      angle,
      "",
      `The user's request for this turn:\n${truncate(request.prompt, 2000) || "(empty)"}`,
      context ? `\nRecent conversation:\n${truncate(context, 4000)}` : "",
      "",
      describe(request),
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const client = new LLMClient(model, provider, intensity);
      const raw = await client.complete(REVIEW_SYSTEM_PROMPT, prompt);
      const verdict = parseVerdict(raw);
      if (verdict) return verdict;
      // A reviewer that cannot answer in the expected shape is not an approval.
      return { approved: false, reason: "reviewer reply was not a verdict", reviewer: seat };
    } catch (err) {
      return {
        approved: false,
        reason: `reviewer failed: ${err instanceof Error ? err.message : String(err)}`,
        reviewer: seat,
      };
    }
  }
}
