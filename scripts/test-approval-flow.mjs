// End-to-end approval flow for the headless web session.
//
// A delete-class tool call must park the turn until a human answers; denying it
// must leave the filesystem untouched, approving it must run the command.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { SESSION_DIR } from "../dist/config.js";
import { WebSession } from "../dist/web/session.js";
import { hub } from "../dist/web/hub.js";

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log("FAIL " + msg);
};
const assert = (cond, msg) => {
  if (!cond) fail(msg);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  fail(`timed out waiting for ${label}`);
  return false;
}

// One OpenAI-compatible endpoint: a tool call on the first hop, prose once the
// tool result comes back, so the agent loop terminates.
function startLlm() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let hasToolResult = false;
      try {
        const body = JSON.parse(raw);
        hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
      } catch {
        // Ignore: an unparsable request gets the tool call again.
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (hasToolResult) {
        send({ choices: [{ delta: { content: "finished" } }] });
      } else {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({ command: "git clean -fdx __approval_probe__" }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      send({ usage: { prompt_tokens: 4, completion_tokens: 1 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function makeSession(id, llmPort) {
  const model = {
    name: "fake-model",
    url: `http://127.0.0.1:${llmPort}/v1`,
    api_key: "test-key",
    supports_streaming: true,
  };
  const source = {
    id,
    cwd: process.cwd(),
    provider: "openai",
    model: model.name,
    intensity: "Medium",
    messages: [],
    tokens: { prompt: 0, completion: 0 },
  };
  return new WebSession(source, model);
}

async function scenario({ approve, expectFile }) {
  const probe = path.resolve("__approval_probe__");
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, "keep.txt"), "keep", "utf8");

  const id = `2099-01-01T00-00-00-000Z-approval-${approve ? "yes" : "no"}`;
  const llm = await startLlm();
  const session = makeSession(id, llm.address().port);

  try {
    session.start();
    session.liveSend("clean the build output");

    const parked = await waitFor(() => session.liveSnapshot().approval !== null, "pending approval");
    if (!parked) return;

    const pending = session.liveSnapshot().approval;
    assert(pending.level === "extreme", `delete-class is extreme (got ${pending.level})`);
    assert(fs.existsSync(path.join(probe, "keep.txt")), "nothing runs before the decision");

    assert(hub.approve(session.key, approve) === true, "the approval reaches the session");

    await waitFor(() => session.liveSnapshot().approval === null, "approval to clear");
    await waitFor(() => session.liveSnapshot().busy === false, "the turn to finish");

    const exists = fs.existsSync(path.join(probe, "keep.txt"));
    assert(exists === expectFile, `probe survived == ${expectFile} (got ${exists})`);

    const transcript = session
      .liveSnapshot()
      .messages.map((m) => m.result ?? m.content ?? "")
      .join("\n");
    assert(approve || transcript.includes("denied"), "the denial is recorded in the transcript");
  } finally {
    session.dispose?.();
    llm.close();
    fs.rmSync(path.join(SESSION_DIR, `${id}.json`), { force: true });
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

await scenario({ approve: false, expectFile: true });
await scenario({ approve: true, expectFile: false });

console.log(failures === 0 ? "APPROVAL FLOW TESTS PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
