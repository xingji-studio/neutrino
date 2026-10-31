// Tests for the web UI server and its live-session bridge.
//
// The server is started on an ephemeral port and exercised over real HTTP so we
// cover routing, static serving, path-traversal protection, the JSON API and
// the SSE stream.
import fs from "node:fs";
import http from "node:http";
import { startWebServer } from "../dist/web/server.js";
import { hub } from "../dist/web/hub.js";
import { WebSession } from "../dist/web/session.js";
import path from "node:path";
import { SESSION_DIR } from "../dist/config.js";

// This test drives a resumed turn end to end; the planner would add requests it
// does not expect.
process.env.NEUTRINO_PLAN = "off";

let failures = 0;
function fail(message) {
  failures += 1;
  console.log("FAIL " + message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}

function makeFakeAgent() {
  return {
    paused: false,
    sent: [],
    liveCwd() {
      return process.cwd();
    },
    liveMeta() {
      return {
        sessionId: "2024-01-01T00-00-00-000Z",
        title: "hello world",
        provider: "DeepSeek",
        model: "deepseek-chat",
        intensity: "High",
        busy: true,
        paused: this.paused,
        queued: null,
        compressing: false,
        tokens: { prompt: 3, completion: 5 },
        approval: null,
      };
    },
    liveSnapshot(key) {
      return {
        ...this.liveMeta(),
        key,
        cwd: this.liveCwd(),
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello back" },
        ],
        streamingContent: null,
      };
    },
    livePause() {
      this.paused = true;
    },
    liveResume() {
      this.paused = false;
    },
    liveSend(text) {
      this.sent.push(text);
    },
    liveApprove(approved) {
      if (!this.approvalPending) return false;
      this.approvalPending = false;
      this.approved = approved;
      return true;
    },
  };
}

function readSSE(url, needle, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        reject(new Error(`SSE status ${res.statusCode}`));
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error("SSE timeout"));
      }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        req.destroy();
        resolve(buffer);
      };
      res.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes(needle)) finish();
      });
      res.on("error", () => {});
    });
    req.on("error", reject);
  });
}

const agent = makeFakeAgent();
const key = hub.register(agent);
const server = await startWebServer({ port: 0, auth: false });
const base = server.url;

try {
  // --- static ---------------------------------------------------------------
  {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    assert(res.status === 200, "index responds 200");
    assert((res.headers.get("content-type") || "").includes("text/html"), "index is html");
    assert(body.includes("<title>Neutrino</title>"), "index contains the title");
  }
  {
    const res = await fetch(`${base}/app.js`);
    const body = await res.text();
    assert(res.status === 200, "app.js is served");
    assert((res.headers.get("content-type") || "").includes("javascript"), "app.js is javascript");
    assert(body.includes("function renderApprovalDetails("), "served app includes the approval command renderer");
  }
  {
    const res = await fetch(`${base}/..%2fpackage.json`);
    assert(res.status === 403, "path traversal is rejected (got " + res.status + ")");
  }

  // --- overview -------------------------------------------------------------
  {
    const res = await fetch(`${base}/api/overview`);
    const body = await res.json();
    assert(res.status === 200, "overview responds 200");
    assert(!res.headers.get("access-control-allow-origin"), "overview does not advertise CORS");
    assert(Array.isArray(body.groups), "overview has groups");
    assert(Array.isArray(body.live), "overview has live list");
    const live = body.live.find((entry) => entry.key === key);
    assert(Boolean(live), "the fake live session is listed");
    assert(live.model === "deepseek-chat", "live session carries its model");
    const flat = body.groups.flatMap((group) => group.sessions);
    assert(
      flat.some((session) => session.liveKey === key),
      "the unsaved live session appears in a directory group",
    );
  }

  // --- one live snapshot ----------------------------------------------------
  {
    const res = await fetch(`${base}/api/live/${key}`);
    const body = await res.json();
    assert(res.status === 200, "live snapshot responds 200");
    assert(body.key === key, "snapshot key matches");
    assert(Array.isArray(body.messages) && body.messages.length === 2, "snapshot has messages");
  }
  {
    const res = await fetch(`${base}/api/live/L999`);
    assert(res.status === 404, "unknown live session is 404");
  }

  // --- actions --------------------------------------------------------------
  {
    const res = await fetch(`${base}/api/live/${key}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "from the browser" }),
    });
    assert(res.status === 200, "message POST responds 200");
    assert(agent.sent[0] === "from the browser", "message reached the agent");
  }
  {
    const res = await fetch(`${base}/api/live/${key}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    assert(res.status === 400, "empty message is rejected");
  }
  {
    const res = await fetch(`${base}/api/live/${key}/pause`, {
      method: "POST",
      headers: { Origin: "http://evil.example" },
    });
    assert(res.status === 403, "cross-origin mutation is rejected");
    assert(agent.paused === false, "a rejected request does not reach the agent");
  }
  {
    const res = await fetch(`${base}/api/live/${key}/pause`, { method: "POST" });
    assert(res.status === 200, "pause responds 200");
    assert(agent.paused === true, "pause reached the agent");
  }
  {
    const res = await fetch(`${base}/api/live/${key}/resume`, { method: "POST" });
    assert(res.status === 200, "resume responds 200");
    assert(agent.paused === false, "resume reached the agent");
  }
  {
    const res = await fetch(`${base}/api/live/${key}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    assert(res.status === 409, "approve without a pending call is 409 (got " + res.status + ")");
  }
  {
    agent.approvalPending = true;
    const res = await fetch(`${base}/api/live/${key}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    assert(res.status === 200, "approve responds 200 (got " + res.status + ")");
    assert(agent.approved === false, "the denial reached the agent");
  }

  // --- sessions -------------------------------------------------------------
  {
    const res = await fetch(`${base}/api/session/..%2f..%2fetc%2fpasswd`);
    assert(res.status === 400, "invalid session id is rejected (got " + res.status + ")");
  }
  {
    const res = await fetch(`${base}/api/session/does-not-exist`);
    assert(res.status === 404, "missing session is 404");
  }
  {
    const res = await fetch(`${base}/api/sessions`);
    const body = await res.json();
    assert(res.status === 200 && Array.isArray(body.sessions), "flat session list works");
  }

  // --- resuming a transcript and running a real turn ------------------------
  {
    // A minimal OpenAI-compatible endpoint: proves the headless loop streams,
    // stores the answer and persists the transcript without touching the network.
    const llm = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const piece of ["resumed ", "answer"]) {
        res.write(
          "data: " +
            JSON.stringify({ choices: [{ delta: { content: piece } }] }) +
            "\n\n",
        );
      }
      res.write(
        "data: " +
          JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 2 } }) +
          "\n\n",
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
    const llmPort = llm.address().port;

    const id = "2024-01-01T00-00-00-000Z-web-resume";
    const file = path.join(SESSION_DIR, id + ".json");
    const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

    const session = new WebSession(
      {
        id,
        title: "resume me",
        model: "mock-model",
        provider: "Mock",
        intensity: "Medium",
        cwd: process.cwd(),
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        tokens: { prompt: 0, completion: 0 },
        messages: [{ role: "user", content: "hello" }],
      },
      { name: "mock-model", url: "http://127.0.0.1:" + llmPort, api_key: "test" },
    );

    try {
      const liveKey = session.start();
      assert(hub.has(liveKey), "resumed session registers in the live hub");

      const before = hub.snapshot(liveKey);
      assert(
        before.messages.length === 1 && before.messages[0].content === "hello",
        "snapshot replays the saved transcript",
      );

      session.liveSend("and now?");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const meta = hub.snapshot(liveKey);
        if (meta.busy) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        if (meta.messages.some((m) => m.role === "assistant")) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const after = hub.snapshot(liveKey);
      const assistant = after.messages.filter((m) => m.role === "assistant");
      assert(assistant.length === 1, "resumed turn produced one assistant message");
      assert(
        assistant[0].content.includes("resumed answer"),
        "assistant text came from the stream (got " + JSON.stringify(assistant[0].content) + ")",
      );
      assert(after.tokens.prompt === 7, "token usage is tracked");
      assert(!after.busy, "session is idle after the turn");

      await new Promise((r) => setTimeout(r, 60));
      assert(fs.existsSync(file), "resumed transcript is written back to disk");
      const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
      assert(
        persisted.messages.some((m) => m.role === "assistant" && m.content.includes("resumed answer")),
        "persisted transcript contains the new answer",
      );

      session.dispose();
      assert(!hub.has(liveKey), "disposed session leaves the live hub");
    } finally {
      llm.close();
      if (saved === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        fs.writeFileSync(file, saved);
      }
    }
  }

  // --- resuming transcripts from the browser --------------------------------
  {
    const res = await fetch(`${base}/api/session/does-not-exist/continue`, { method: "POST" });
    assert(res.status === 404, "continue on a missing session is 404 (got " + res.status + ")");
  }
  {
    const res = await fetch(`${base}/api/session/..%2f..%2fetc%2fpasswd/continue`, {
      method: "POST",
    });
    assert(res.status === 400, "continue rejects a path-traversal id (got " + res.status + ")");
  }
  {
    // A transcript whose model is gone must fail with a readable message.
    const id = "2024-01-01T00-00-00-000Z-web-test";
    const file = path.join(SESSION_DIR, `${id}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        id,
        title: "orphan",
        model: "__missing_model__",
        provider: "Nowhere",
        intensity: "Medium",
        cwd: process.cwd(),
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        tokens: { prompt: 0, completion: 0 },
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    try {
      const res = await fetch(`${base}/api/session/${id}/continue`, { method: "POST" });
      const body = await res.json();
      assert(res.status === 400, "continue with an unknown model is 400 (got " + res.status + ")");
      assert(
        typeof body.error === "string" && body.error.includes("__missing_model__"),
        "continue explains which model is missing",
      );
    } finally {
      fs.unlinkSync(file);
    }
  }
  {
    // The TUI owns its sessions; the browser must not be able to close them.
    const res = await fetch(`${base}/api/live/${key}/close`, { method: "POST" });
    assert(res.status === 400, "closing a TUI session is refused (got " + res.status + ")");
  }

  // --- SSE ------------------------------------------------------------------
  {
    const buffer = await readSSE(`${base}/api/live/${key}/stream`, "event: snapshot");
    assert(buffer.includes("event: snapshot"), "SSE sends an initial snapshot");
    assert(buffer.includes('"role":"assistant"'), "SSE snapshot contains messages");
  }

  // --- health ---------------------------------------------------------------
  {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true, "health check works");
  }
} finally {
  hub.unregister(key);
  await server.close();
}

console.log(failures === 0 ? "\nWEB TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
