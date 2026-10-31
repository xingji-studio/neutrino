/**
 * Retry policy for the model connection.
 *
 * A single turn is minutes of work, and the connection carries it the whole way.
 * Providers, and the proxies and load balancers in front of them, drop sockets
 * for reasons a client can never observe: an idle timeout, a rolling restart, a
 * middlebox resetting the flow. Those blips clear on their own within seconds,
 * so a failed request that is simply re-sent saves the turn — while surfacing
 * the error throws away everything the user typed and everything the model had
 * already produced.
 *
 * The policy is exponential: seven attempts in total, waiting 5s, 10s, 20s,
 * 40s, 80s and finally 160s between them (about five minutes end to end). The
 * waits grow because a link that is merely flaky recovers long before the
 * budget runs out, and a link that is genuinely down must not be hammered.
 */

/** Total tries, the first one included. */
export const DEFAULT_NETWORK_ATTEMPTS = 7;
/** Wait before the first retry; every further retry doubles it. */
export const DEFAULT_RETRY_DELAY_MS = 5_000;

export interface RetryPolicy {
  /** Total tries, including the first one. */
  attempts: number;
  /** Wait before the first retry; doubled for each retry after that. */
  baseDelayMs: number;
}

/** Parse an override, ignoring anything that is not a positive integer. */
function positiveInt(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The policy in force.
 *
 * Read on every use rather than cached at import time, so the environment can
 * tune it (`NEUTRINO_NETWORK_ATTEMPTS`, `NEUTRINO_RETRY_DELAY_MS`) without a
 * rebuild and the tests can collapse the waits to a millisecond.
 */
export function retryPolicy(): RetryPolicy {
  return {
    attempts: positiveInt(process.env.NEUTRINO_NETWORK_ATTEMPTS) ?? DEFAULT_NETWORK_ATTEMPTS,
    baseDelayMs: positiveInt(process.env.NEUTRINO_RETRY_DELAY_MS) ?? DEFAULT_RETRY_DELAY_MS,
  };
}

/** Wait before retry number `retry` (0-based): base, 2×base, 4×base, … */
export function retryDelayMs(retry: number, policy: RetryPolicy = retryPolicy()): number {
  return policy.baseDelayMs * 2 ** Math.max(0, Math.floor(retry));
}

/** What the UI is told before a retried request goes out again. */
export interface RetryNotice {
  /** The attempt about to go out (2 = the first retry), 1-based. */
  attempt: number;
  /** Total attempts allowed. */
  attempts: number;
  /** How long this attempt waits before it is sent. */
  delayMs: number;
  /** What went wrong, in the same wording the transcript uses. */
  reason: string;
}

/** A wait in human terms: "5s", "40s", "2m 40s". */
export function formatDelay(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Terse transport messages that all mean "the connection dropped mid-flight".
 * The \b keeps "terminated" from matching unrelated text such as
 * "Unterminated string constant".
 */
const DROP_HINT_SOURCE = "\\bterminated\\b|other side closed|socket hang up|premature close";

export const DROP_HINT_RE = new RegExp(DROP_HINT_SOURCE, "i");

/**
 * Superset of the hints above, used to decide whether to retry: a socket can
 * also be reported as a bare "read ECONNRESET" with no `code` attached.
 */
const TRANSIENT_MESSAGE_RE = new RegExp(
  `${DROP_HINT_SOURCE}|connection reset|network is unreachable|connection aborted|timed out|` +
    "\\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EAI_AGAIN)\\b",
  "i",
);

/** `code` values that describe a broken socket rather than a bad request. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_RESPONSE_STATUS_CODE",
]);

/**
 * Flatten an error and its `cause` chain into one readable line.
 *
 * `fetch` reports almost every transport problem as a bare
 * `TypeError: fetch failed`; the actual reason (`ECONNRESET`, `EMFILE`,
 * `ENOTFOUND`, `UND_ERR_…`) is tucked away in `error.cause`. Without walking
 * that chain a failure is impossible to diagnose, so this always reports it.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts: string[] = [];
  const push = (msg: string, code?: string): void => {
    const text = code && !msg.includes(code) ? `${msg} (${code})` : msg;
    if (text && !parts.includes(text)) parts.push(text);
  };

  let cur: unknown = e;
  const seen = new Set<unknown>();
  while (cur != null && !seen.has(cur)) {
    if (typeof cur === "string") {
      // fetch/undici sometimes stash the real reason in a plain string
      // (`cause: "other side closed"`), which an object-only walk would miss.
      push(cur);
      break;
    }
    if (typeof cur !== "object") break;
    seen.add(cur);
    const err = cur as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    const message = typeof err.message === "string" && err.message ? err.message : String(err.name ?? "Error");
    const code = typeof err.code === "string" ? err.code : undefined;
    push(message, code);
    cur = err.cause;
  }
  const text = parts.join(": ") || e.message;
  // A dropped mid-stream connection surfaces as a bare `TypeError: terminated`,
  // which on its own tells the user nothing worth reading.
  return DROP_HINT_RE.test(text) ? `${text} — the connection was closed before the response finished` : text;
}

/**
 * Whether a failed request is worth retrying: a transient connection problem
 * (reset / refused / DNS / timeout) rather than a real response from the API.
 */
export function isRetriableNetworkError(e: unknown): boolean {
  let cur: unknown = e;
  const seen = new Set<unknown>();
  while (cur != null && !seen.has(cur)) {
    if (typeof cur === "string") {
      if (TRANSIENT_MESSAGE_RE.test(cur)) return true;
      break;
    }
    if (typeof cur !== "object") break;
    seen.add(cur);
    const err = cur as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    // undici prefixes its own transport codes with UND_ERR_.
    if (typeof err.code === "string" && (TRANSIENT_CODES.has(err.code) || err.code.startsWith("UND_ERR_"))) {
      return true;
    }
    // Our own connect timeout aborts with a plain AbortError; undici wraps a
    // dropped socket in a SocketError.
    if (err.name === "AbortError" || err.name === "SocketError") return true;
    // A stream that dies mid-flight: "terminated", "socket hang up", …
    if (typeof err.message === "string" && TRANSIENT_MESSAGE_RE.test(err.message)) return true;
    cur = err.cause;
  }
  // Undici's generic wrapper: assume the socket dropped and try again.
  return e instanceof Error && /fetch failed/i.test(e.message);
}

/**
 * Statuses worth re-sending, because the server (or the proxy in front of it)
 * never produced an answer to *this* request: 408/425 mean "too slow, retry",
 * 429 and 529 mean "overloaded, back off", and the 5xx family is a transient
 * backend failure — a 502/503/504 from a load balancer is the HTTP face of the
 * very connection reset the retry policy exists for.
 *
 * Everything else — 400, 401, 403, 404, 422 — means the request itself is wrong
 * or the key is bad, and re-sending it would only delay the real message.
 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export function isRetriableStatus(status: number): boolean {
  return TRANSIENT_STATUS.has(status);
}

/** A response that did arrive, but carried a failure status. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`HTTP ${status}${body ? " - " + body : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/** Whether a failure is transient, including HTTP statuses that invite a retry. */
export function isRetriableFailure(e: unknown): boolean {
  if (e instanceof HttpStatusError) return isRetriableStatus(e.status);
  return isRetriableNetworkError(e);
}

/**
 * Sleep before retry number `retry`, in short slices.
 *
 * The wait can reach 160s, so it must not be a single `setTimeout`: a paused
 * turn or a newer message has to be able to cut it short. Returns false when
 * `cancelled` fired, which tells the caller to stop without an error.
 */
export async function waitBeforeRetry(
  retry: number,
  policy: RetryPolicy,
  cancelled?: () => boolean,
): Promise<boolean> {
  const sliceMs = 100;
  let left = retryDelayMs(retry, policy);
  while (left > 0) {
    if (cancelled?.()) return false;
    const step = Math.min(sliceMs, left);
    await new Promise<void>((resolve) => setTimeout(resolve, step));
    left -= step;
  }
  return !cancelled?.();
}
