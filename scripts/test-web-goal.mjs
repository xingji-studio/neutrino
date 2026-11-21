import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { createGoalUI } from "../web/goal.js";
import { setLanguage, t } from "../web/i18n.js";

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const { document, window } = parseHTML(html);
const element = id => document.getElementById(`goal-${id}`);
const dialog = element("dialog");
dialog.showModal = () => { dialog.open = true; };
dialog.close = () => { dialog.open = false; };
let selection = { kind: "live", key: "L1" };
let source = { key: "L1", busy: false, goal: null };
let commands = [];
let sender = async text => { commands.push(text); return true; };
const input = document.getElementById("input");
const ui = createGoalUI({ document, tr: t, input, getSelection: () => selection, getSource: () => source,
  submitCommand: text => sender(text), onDraftChange() {} });
const isHidden = id => element(id).classList.contains("hidden");
async function waitFor(predicate) {
  const until = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < until, "Timed out waiting for goal UI"); await new Promise(done => setTimeout(done, 2)); }
}
const submit = () => element("form").dispatchEvent(new window.Event("submit", { cancelable: true }));

ui.show(source);
assert.ok(isHidden("card"));
input.value = "/g";
ui.onInput();
assert.ok(!isHidden("command-menu"));
let prevented = false;
ui.onKey({ key: "Tab", preventDefault() { prevented = true; } });
assert.ok(prevented);
assert.equal(dialog.open, true);
assert.equal(element("input").value, "", "choosing a partial slash command does not make it the objective");
assert.ok(isHidden("command-menu"));
element("dialog-cancel").click();

input.value = "/goal";
ui.onInput();
assert.equal(ui.onKey({ key: "Enter", isComposing: true, preventDefault() { assert.fail("IME commit must be preserved"); } }), false);
ui.onKey({ key: "Escape" });
assert.ok(isHidden("command-menu"));
assert.ok(ui.isBareCommand(" /目标 "));
assert.ok(!ui.isBareCommand("/goal status"));
assert.ok(ui.isCommand("/goal pause"));
assert.ok(!ui.isCommand("/goals"));

source = { busy: false, goal: { id: "G1", status: "active", objective: '<img src=x onerror="alert(1)">\nDeliver the result',
  tokensUsed: 25000, tokenBudget: 250000, turns: 3, reason: "Check the final artifact." } };
ui.show(source);
assert.ok(!isHidden("card"));
assert.equal(element("objective").textContent, source.goal.objective);
assert.equal(element("objective").querySelector("img"), null, "goal text never becomes executable HTML");
assert.equal(element("progress").getAttribute("aria-valuenow"), "25000");
assert.equal(element("progress-fill").style.width, "10%");
assert.ok(!isHidden("pause"));
assert.ok(isHidden("resume"));
input.value = "Keep this draft";
element("pause").click();
await waitFor(() => !element("pause").disabled);
assert.deepEqual(commands, ["/goal pause"]);
assert.equal(input.value, "Keep this draft");

setLanguage("zh");
ui.show({ ...source, goal: { ...source.goal, status: "paused" } });
assert.equal(element("status").textContent, "已暂停");
assert.ok(!isHidden("resume"));
assert.equal(element("turns").textContent, "3 轮");
setLanguage("en");
source.goal.status = "paused";
ui.show(source);
element("resume").click();
await waitFor(() => !element("resume").disabled);
assert.equal(commands.at(-1), "/goal resume");
source.goal.status = "budget_exhausted";
source.goal.tokensUsed = 260000;
ui.show(source);
assert.ok(isHidden("resume"));
assert.equal(element("progress-fill").style.width, "100%");
source.goal.tokenBudget = undefined;
ui.show(source);
assert.ok(isHidden("progress"));
assert.match(element("usage").textContent, /tokens used/);

// Form validation, request failures and switching chats retain the draft for repair.
source = { busy: false };
ui.show(source);
input.value = "/goal";
ui.open();
element("input").value = "Deliver the complete result.";
element("budget").value = "1.5";
submit();
assert.match(element("form-feedback").textContent, /positive whole number/);
element("budget").value = "50000";
selection = { kind: "live", key: "L2" };
submit();
assert.match(element("form-feedback").textContent, /conversation changed/);
assert.equal(dialog.open, true);
ui.open();
element("input").value = "Deliver the complete result.";
element("budget").value = "50000";
sender = async () => false;
submit();
await waitFor(() => !element("start").disabled);
assert.equal(dialog.open, true);
assert.match(element("form-feedback").textContent, /Could not start/);
sender = async text => { commands.push(text); return true; };
submit();
await waitFor(() => !dialog.open);
assert.equal(commands.at(-1), "/goal set --tokens 50000 Deliver the complete result.");
assert.equal(input.value, "");

source.busy = true;
ui.show(source);
assert.equal(element("open").disabled, true);
ui.open();
assert.equal(dialog.open, false, "starting a goal cannot supersede an in-flight turn");
source.busy = false;
ui.show(source);

// Exercise the real app submission handler: goal commands on a paused chat must stay paused.
const app = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const handler = app.slice(app.indexOf("async function sendMessage()"), app.indexOf("function autosize()"));
const actions = [];
const state = { selection: { kind: "live", key: "L3" }, snapshot: { key: "L3", paused: true } };
let opens = 0;
const context = vm.createContext({ state, el: { input: { value: "" }, sub: {} }, agentModePending: Promise.resolve(), PRO_MODE: false,
  preferences: { async flush() {} }, currentAgentMode: () => "standard", autosize() {}, tr: t,
  goalUI: { isCommand: ui.isCommand, isBareCommand: ui.isBareCommand, open() { opens++; } },
  postAction: async (key, action, body) => { actions.push({ key, action, body }); return true; } });
vm.runInContext(`${handler}\nthis.submit = sendMessage;`, context);
await context.submit(null, "/goal pause");
assert.deepEqual(actions.map(action => action.action), ["message"]);
actions.length = 0;
await context.submit(null, "/goal status");
assert.deepEqual(actions.map(action => action.action), ["message"]);
actions.length = 0;
await context.submit(null, "/goal");
assert.equal(opens, 1);
assert.equal(actions.length, 0, "bare /goal opens the settings UI without a model call");
await context.submit(null, "Continue with this correction.");
assert.deepEqual(actions.map(action => action.action), ["message", "resume"]);

assert.ok(html.includes('href="goal.css"'));
console.log("ok web goal UI: slash menu, IME, modal, validation, status rail, safe text, token budget, controls, drafts and paused commands");
