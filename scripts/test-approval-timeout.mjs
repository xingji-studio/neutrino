// A reviewer that never answers must not freeze the turn.
//
// The reviewer sits on the critical path of a tool call, so a wedged provider
// has to degrade to "denied" quickly instead of leaving the app looking frozen
// with no card, no output and no way to cancel.
import http from "node:http";

import { ApprovalGate } from "../dist/llm/approval.js";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures++;
    console.log("FAIL " + msg);
  } else {
    console.log("  ok  " + msg);
  }
};

/** Accepts connections and never answers: the worst kind of provider. */
function startBlackHole() {
  const sockets = new Set();
  const server = http.createServer(() => {
    // Deliberately no response.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    );
  });
}

const blackHole = await startBlackHole();
const seen = [];
let asked = 0;

const gate = new ApprovalGate({
  askHuman: async () => {
    asked++;
    return false;
  },
  reviewer: () => ({
    model: {
      name: "black-hole",
      url: `http://127.0.0.1:${blackHole.port}/v1`,
      api_key: "test-key",
      supports_streaming: true,
    },
    provider: "openai",
    intensity: "Medium",
  }),
  extremeAutoApprovalEnabled: () => true,
  autoApprovalEnabled: () => true,
  reviewTimeoutMs: () => 150,
  onReview: (info) => seen.push(info ? info.total : null),
});

const request = {
  tool: "run_command",
  args: { command: "rm -rf build", reason: "remove the stale build directory before rebuilding" },
  cwd: process.cwd(),
  prompt: "\u81ea\u52a8\u5ba1\u6279\uff0c\u6e05\u7406\u6784\u5efa\u4ea7\u7269",
  risk: { level: "extreme", reasons: ["delete-class command"] },
};

const startedAt = Date.now();
const decision = await gate.decide(request);
const elapsed = Date.now() - startedAt;

assert(elapsed < 3000, `the decision returns promptly (${elapsed} ms)`);
assert(decision.approved === false, "an unanswered review fails closed");
assert(decision.source === "ai", `the decision is attributed to review (got ${decision.source})`);
assert(asked === 0, `the human is not left holding a hung review (asked ${asked}x)`);
assert(
  seen[0] === 2 && seen[seen.length - 1] === null,
  `the UI is told about both reviews (got ${JSON.stringify(seen)})`,
);

blackHole.close();
console.log(failures === 0 ? "APPROVAL TIMEOUT TESTS PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
