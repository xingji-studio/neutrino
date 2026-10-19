// A browser must see the complete proposal before answering an approval, both
// for terminal-owned and browser-owned sessions. No proposed command is run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-approval-details-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
const { saveConfig } = await import("../dist/config.js");
const { defaultState } = await import("../dist/state.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { hub } = await import("../dist/web/hub.js");
const originalComplete = LLMClient.prototype.complete;
const active = new Set();
const model = { name: "test", url: "", api_key: "", supports_streaming: true };
const command = `curl -I https://example.invalid\n# ${"long-command-".repeat(500)}\necho "<img src=x onerror=alert(1)>"`;
const args = { command, timeout_ms: 12000, reason: "check that the endpoint still answers" };
const snapshots = [];

try {
  saveConfig({ approval_mode: "request", auto_approve_extreme_risk: false });
  for (const kind of ["tui", "web"]) {
    let agent;
    if (kind === "tui") {
      agent = new ChatScreen();
      agent.app = { width: 80, height: 24, state: defaultState(), render() {}, showToast() {} };
      agent.onActivate();
    } else {
      agent = new WebSession({ id: "web-approval-details", provider: "test", model: model.name, intensity: "High", cwd: process.cwd(), messages: [] }, model);
      agent.start();
    }
    active.add(agent);
    const key = hub.register(agent);
    const waiting = agent.requestApproval("run_command", args);
    const snapshot = JSON.parse(JSON.stringify(hub.snapshot(key)));
    assert.equal(snapshot.approval.tool, "run_command");
    assert.equal(snapshot.approval.arguments.command, command, `${kind}: do not send the shortened risk summary as the command`);
    assert.deepEqual(snapshot.approval.arguments, args);
    assert.equal(snapshot.approval.cwd, process.cwd());
    assert.ok(snapshot.approval.summary);
    assert.ok(snapshot.approval.reasons.length);
    let pushed;
    const unsubscribe = hub.subscribe(key, update => { pushed = update; });
    assert.equal(pushed.approval.arguments.command, command, "stream subscribers receive the same full proposal");
    unsubscribe();
    snapshots.push(snapshot);
    assert.equal(agent.liveApprove(false), true);
    assert.equal((await waiting).approved, false);
    assert.equal(agent.liveMeta().approval, null);

    let finish;
    const barrier = new Promise(resolve => { finish = resolve; });
    LLMClient.prototype.complete = async () => {
      await barrier;
      return '{"approve":false,"reason":"fixture denial"}';
    };
    agent.liveSetApprovalMode("auto");
    const reviewing = agent.requestApproval("run_command", args);
    const progress = hub.snapshot(key).reviewing;
    assert.equal(progress.total, 2);
    assert.equal(progress.request.arguments.command, command, `${kind}: automatic review shows the proposed command too`);
    assert.equal(progress.request.cwd, process.cwd());
    finish();
    await reviewing;
    assert.equal(hub.snapshot(key).reviewing, null);
    console.log(`ok ${kind}: full approval arguments, working directory, risk reasons, live stream and automated-review details`);
  }

  // Run the actual browser renderer with inert DOM elements. Any innerHTML
  // assignment is a failure: commands may contain literal markup or scripts.
  class Element {
    constructor(tag) { this.tag = tag; }
    children = [];
    events = new Map();
    className = "";
    text = "";
    classList = { add: name => { this.className += ` ${name}`; } };
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
    set innerHTML(_value) { throw new Error("approval details must be literal text"); }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.text = ""; }
    addEventListener(name, callback) { this.events.set(name, callback); }
  }
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  const byClass = (root, name) => find(root, node => node.className === name);
  const banner = new Element("div");
  const answers = [];
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag) },
    el: { approval: banner }, decideApproval: answer => answers.push(answer),
  });
  vm.runInContext(source.slice(source.indexOf("function renderApprovalDetails("), source.indexOf("function decideApproval(")), context);
  context.renderApproval(snapshots[0]);
  assert.equal(byClass(banner, "approval-code").textContent, command);
  assert.equal(byClass(banner, "approval-code").children.length, 0, "command markup is not parsed");
  assert.ok(byClass(banner, "approval-location").textContent.includes(process.cwd()));
  assert.equal(
    byClass(banner, "approval-why").textContent,
    "Why: check that the endpoint still answers",
    "the reason the agent gave is shown with the call",
  );
  assert.ok(
    !byClass(banner, "approval-arguments").textContent.includes("check that the endpoint still answers"),
    "the reason is not repeated inside the arguments dump",
  );
  assert.ok(byClass(banner, "approval-reasons").children.length);
  assert.ok(byClass(banner, "approval-arguments").textContent.includes('"timeout_ms": 12000'));
  byClass(banner, "approve-btn").events.get("click")();
  byClass(banner, "deny-btn").events.get("click")();
  assert.deepEqual(answers, [true, false]);

  context.renderApproval({ cwd: "/workspace", approval: {
    tool: "write_file", level: "high", arguments: { path: "/tmp/test.txt", content: "<script>inert</script>\nsecond line" },
    reasons: ["outside working directory"],
  } });
  const parameters = JSON.parse(byClass(banner, "approval-code").textContent);
  assert.equal(parameters.path, "/tmp/test.txt");
  assert.equal(parameters.content, "<script>inert</script>\nsecond line");
  assert.equal(byClass(banner, "approval-why"), undefined, "no reason line when the call states none");
  assert.equal(byClass(banner, "approval-arguments"), undefined);
  assert.equal(byClass(banner, "approval-location").textContent, "Working directory: /workspace");

  context.renderApproval({ approval: null, reviewing: {
    total: 2, round: 2, rounds: 3, request: snapshots[0].approval,
  } });
  assert.equal(byClass(banner, "approval-code").textContent, command);
  assert.match(byClass(banner, "approval-risk").textContent, /round 2 of 3, 2 reviewers/);
  assert.equal(byClass(banner, "approval-actions"), undefined, "automated reviews are informational");
  context.renderApproval({ approval: { tool: "legacy-tool", level: "high" } });
  assert.match(byClass(banner, "approval-code").textContent, /unavailable/);
  context.renderApproval(null);
  assert.ok(banner.className.includes("hidden"));
  assert.equal(banner.children.length, 0);
  console.log("WEB APPROVAL DETAILS TESTS PASSED");
} finally {
  LLMClient.prototype.complete = originalComplete;
  for (const agent of active) {
    if (agent instanceof ChatScreen) agent.onDeactivate(); else agent.dispose();
  }
  os.homedir = originalHomedir;
  fs.rmSync(testHome, { recursive: true, force: true });
}
