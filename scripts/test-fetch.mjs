// Regression tests for LLMClient's HTTP handling.
//
// The bugs these lock down:
//   * A stream that the consumer walks away from (ESC ESC pause, or a newer
//     turn taking over) used to be left un-cancelled, so its socket lingered.
//     Over a long session that leaks connections and every later request
//     eventually fails with "fetch failed".
//   * `fetch` hides the real failure in `error.cause`, so the log only ever
//     showed the useless "[Error: fetch failed]".
//   * A transient reset killed the whole turn because nothing retried.
//   * A stream cut off mid-flight ("terminated" / "other side closed") ended
//     the turn before a single byte arrived, even though retrying was free.
import { LLMClient, describeError } from "../dist/llm/client.js";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log("FAIL " + msg);
  }
}

const enc = new TextEncoder();
const sse = (...objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("");
const DONE = "data: [DONE]\n\n";

const MODEL = {
  name: "test-model",
  url: "https://example.test/v1",
  api_key: "k",
  supports_streaming: true,
};

const makeClient = () => new LLMClient(MODEL, "OpenAI", "High");
// Yield to the event loop so a queued stream can settle.
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// 1. describeError walks the cause chain (that's where the real reason lives)
// ---------------------------------------------------------------------------
{
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
  const d = describeError(err);
  assert(d.includes("fetch failed"), `describeError keeps the top message: ${d}`);
  assert(d.includes("ECONNRESET"), `describeError digs into cause for the code: ${d}`);

  const plain = new Error("boom");
  assert(describeError(plain) === "boom", `describeError handles a plain error: ${describeError(plain)}`);
  assert(describeError("nope") === "nope", "describeError handles non-errors");
}

// ---------------------------------------------------------------------------
// 2. Abandoning a stream must cancel the response body (no socket leak)
// ---------------------------------------------------------------------------
{
  let cancelled = false;
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      start(c) {
        // One token, then the stream stays open like a real generation would.
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "hello" } }] })));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, { status: 200 });
  };

  const client = makeClient();
  let text = "";
  for await (const chunk of client.streamTurn([{ role: "user", content: "hi" }])) {
    text += chunk;
    break; // pause / superseded turn
  }
  assert(text === "hello", `the first chunk should still be delivered, got ${JSON.stringify(text)}`);
  assert(cancelled, "abandoning a stream must cancel its body, or the socket leaks");
}

// ---------------------------------------------------------------------------
// 3. A normal, fully-consumed stream still works (content, usage, no tool calls)
// ---------------------------------------------------------------------------
{
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          enc.encode(
            sse(
              { choices: [{ delta: { content: "a" } }] },
              { choices: [{ delta: { content: "b" } }] },
              { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
            ),
          ),
        );
        c.enqueue(enc.encode(DONE));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  const client = makeClient();
  let text = "";
  for await (const chunk of client.streamTurn([{ role: "user", content: "hi" }])) text += chunk;
  assert(text === "ab", `content streams in order, got ${JSON.stringify(text)}`);
  assert(client.usage?.total === 5, `usage is captured, got ${JSON.stringify(client.usage)}`);
  assert(client.toolCalls.length === 0, "no tool calls expected");
}

// ---------------------------------------------------------------------------
// 4. A transient connection reset is retried instead of ending the turn
// ---------------------------------------------------------------------------
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    }
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "recovered" } }] })));
        c.enqueue(enc.encode(DONE));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  const client = makeClient();
  let text = "";
  for await (const chunk of client.streamTurn([{ role: "user", content: "hi" }])) text += chunk;
  assert(calls === 2, `a transient ECONNRESET should be retried once, calls=${calls}`);
  assert(text === "recovered", `the retried request succeeds, got ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 5. A non-network error is surfaced immediately, with no pointless retries
// ---------------------------------------------------------------------------
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("boom");
  };

  const client = makeClient();
  let text = "";
  for await (const chunk of client.streamTurn([{ role: "user", content: "hi" }])) text += chunk;
  assert(calls === 1, `a non-network error must not be retried, calls=${calls}`);
  assert(text.includes("boom"), `the error is surfaced to the transcript, got ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 6. Tool-call arguments split across chunks are still assembled (regression
//    guard for the reader refactor)
// ---------------------------------------------------------------------------
{
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          enc.encode(
            sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run_command", arguments: '{"comm' } }] } }] }),
          ),
        );
        c.enqueue(
          enc.encode(
            sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
          ),
        );
        c.enqueue(enc.encode(DONE));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  const client = makeClient();
  for await (const _ of client.streamTurn([{ role: "user", content: "hi" }], [])) {
    // drain
  }
  assert(client.toolCalls.length === 1, `one tool call expected, got ${client.toolCalls.length}`);
  const tc = client.toolCalls[0];
  assert(tc?.name === "run_command", `tool name assembled, got ${tc?.name}`);
  assert(tc?.arguments === '{"command":"ls"}', `tool args assembled, got ${JSON.stringify(tc?.arguments)}`);
}

// ---------------------------------------------------------------------------
// 7. A stream cut off *before the first byte* ("terminated") is retried.
//    Nothing reached the user, so retrying is invisible and cannot duplicate.
// ---------------------------------------------------------------------------
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      // The socket drops before the server sends a single byte — exactly the
      // "[Error: terminated]" seen in the saved session.
      const stream = new ReadableStream({
        start(c) {
          c.error(new TypeError("terminated"));
        },
      });
      return new Response(stream, { status: 200 });
    }
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "second try" } }] })));
        c.enqueue(enc.encode(DONE));
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  };

  const client = makeClient();
  let text = "";
  for await (const chunk of client.streamTurn([{ role: "user", content: "hi" }])) text += chunk;
  assert(calls === 2, `a mid-flight "terminated" before any byte should be retried, calls=${calls}`);
  assert(text === "second try", `the retried request succeeds, got ${JSON.stringify(text)}`);
  assert(!text.includes("[Error"), `no error is shown when the retry works, got ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 8. A stream that dies *after* emitting text is NOT retried (that would
//    duplicate content); the error is surfaced and the partial text is kept.
// ---------------------------------------------------------------------------
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "half" } }] })));
        // Drop the socket only *after* the first chunk is handed over, so this
        // really models "some text arrived, then the stream died".
        setTimeout(() => c.error(new TypeError("terminated")), 0);
      },
    });
    return new Response(stream, { status: 200 });
  };

  const client = makeClient();
  let text = "";
  for await (const chunk of client.streamTurn([{ role: "user", content: "hi" }])) text += chunk;
  assert(calls === 1, `a stream that already emitted must not be retried, calls=${calls}`);
  assert(text.startsWith("half"), `the partial text survives, got ${JSON.stringify(text)}`);
  assert(text.includes("terminated"), `the drop is surfaced, got ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// 9. describeError turns a bare "terminated" into something readable, and
//    surfaces a string-valued cause the old object-only walk skipped.
// ---------------------------------------------------------------------------
{
  const d = describeError(new TypeError("terminated"));
  assert(d.includes("terminated"), `keeps the transport message: ${d}`);
  assert(/closed before the response finished/i.test(d), `explains what happened: ${d}`);

  const withStringCause = new TypeError("fetch failed", { cause: "other side closed" });
  const d2 = describeError(withStringCause);
  assert(d2.includes("other side closed"), `surfaces a string cause: ${d2}`);

  // "terminated" must not fire on unrelated words that merely contain it.
  const unrelated = describeError(new Error("Unterminated string constant"));
  assert(
    !/closed before the response finished/i.test(unrelated),
    `the drop hint must be word-bounded, got ${unrelated}`,
  );
}

await tick();
console.log(failures === 0 ? "\nFETCH TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
