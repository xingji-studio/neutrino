// Regression tests for the approval gate:
//   * what counts as high / extreme risk,
//   * which prompt phrases opt out of approval,
//   * how the gate routes a decision (prompt / human / reviewer).
import { assessToolCall, assessCommand } from "../dist/llm/risk.js";
import { ApprovalGate, parsePromptDirectives } from "../dist/llm/approval.js";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) fail(`${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const cwd = process.cwd();

// ---- risk classification -------------------------------------------------
eq(assessCommand("npm run build", cwd).reasons.length, 0, "npm run build is routine");
eq(assessCommand("git status", cwd).reasons.length, 0, "git status is routine");
eq(assessCommand("node scripts/test.mjs", cwd).reasons.length, 0, "running a script is routine");

eq(assessToolCall("run_command", { command: "rm -rf build" }, cwd)?.level, "extreme", "rm is extreme");
eq(assessToolCall("run_command", { command: "git clean -fdx" }, cwd)?.level, "extreme", "git clean -fdx is extreme");
eq(assessToolCall("run_command", { command: "git reset --hard HEAD~1" }, cwd)?.level, "extreme", "reset --hard is extreme");
eq(assessToolCall("run_command", { command: "sudo rm -rf /var" }, cwd)?.level, "extreme", "sudo rm is extreme");
eq(
  assessToolCall("run_command", { command: 'rg "rm -rf" src' }, cwd),
  null,
  "a quoted pattern is not a deletion",
);

eq(assessToolCall("run_command", { command: "npm install left-pad" }, cwd)?.level, "high", "npm install is high");
eq(assessToolCall("run_command", { command: "sudo systemctl restart nginx" }, cwd)?.level, "high", "systemctl is high");
eq(assessToolCall("run_command", { command: "curl https://example.com" }, cwd)?.level, "high", "curl is high");
eq(assessToolCall("run_command", { command: "python -c 'print(1)'" }, cwd)?.level, "high", "inline program is high");

const outside = assessToolCall("read_file", { path: "/etc/passwd" }, cwd);
eq(outside?.level, "high", "reading outside the working directory is high");
assert(outside?.reasons.some((r) => r.includes("outside")), "reason mentions the working directory");
eq(assessToolCall("read_file", { path: "src/config.ts" }, cwd), null, "reading inside the project is routine");
eq(assessToolCall("write_file", { path: "notes.md" }, cwd), null, "writing inside the project is routine");

// ---- prompt directives ---------------------------------------------------
const plain = parsePromptDirectives("refactor the parser");
assert(!plain.noApproval && !plain.fullTrust && !plain.autoApprove, "plain prompt grants nothing");

const noApproval = parsePromptDirectives("这个对话无需审批，直接改吧");
assert(noApproval.noApproval, "无需审批 is detected");
assert(!noApproval.fullTrust, "无需审批 alone does not grant full trust");

const fullTrust = parsePromptDirectives("我已知悉风险，同意给予完整权限，无需任何审批。");
assert(fullTrust.fullTrust, "full-trust sentence is detected");
assert(fullTrust.noApproval === false, "full trust is its own switch");

const auto = parsePromptDirectives("自动审批，全部交给你");
assert(auto.autoApprove, "自动审批 is detected");

const negated = parsePromptDirectives("不要自动审批，先问我");
assert(!negated.autoApprove, "negated 自动审批 is ignored");

// ---- gate routing --------------------------------------------------------

function requestFor(prompt, level = "high") {
  return {
    tool: "run_command",
    args: { command: "rm -rf build" },
    cwd,
    prompt,
    risk: { level, tool: "run_command", summary: "rm -rf build", reasons: ["deletes files"] },
  };
}

async function run() {
  // human path (default)
  {
    let asked = 0;
    const g = new ApprovalGate({
      askHuman: async () => {
        asked++;
        return true;
      },
      reviewer: () => {
        throw new Error("reviewer must not run for the human path");
      },
      extremeAutoApprovalEnabled: () => false,
    });
    const decision = await g.decide(requestFor("update the docs"));
    eq(decision.source, "human", "default path asks a human");
    assert(decision.approved, "human approval is honoured");
    eq(asked, 1, "human was asked exactly once");
  }

  // prompt opt-out for the high class
  {
    const g = new ApprovalGate({
      askHuman: async () => fail("human must not be asked"),
      reviewer: () => {
        throw new Error("reviewer must not run");
      },
      extremeAutoApprovalEnabled: () => false,
    });
    const decision = await g.decide(requestFor("这个对话无需审批"));
    eq(decision.source, "prompt", "无需审批 clears the high class");
    assert(decision.approved, "prompt opt-out approves");
  }

  // 无需审批 must not clear a deletion
  {
    let asked = 0;
    const g = new ApprovalGate({
      askHuman: async () => {
        asked++;
        return false;
      },
      reviewer: () => {
        throw new Error("reviewer must not run");
      },
      extremeAutoApprovalEnabled: () => true,
    });
    const decision = await g.decide(requestFor("无需审批", "extreme"));
    eq(decision.source, "human", "delete-class needs a human even with 无需审批");
    assert(!decision.approved, "denial is honoured");
    eq(asked, 1, "human was asked");
  }

  // full trust clears a deletion
  {
    const g = new ApprovalGate({
      askHuman: async () => fail("human must not be asked"),
      reviewer: () => {
        throw new Error("reviewer must not run");
      },
      extremeAutoApprovalEnabled: () => false,
    });
    const decision = await g.decide(
      requestFor("我已知悉风险，同意给予完整权限，无需任何审批", "extreme"),
    );
    assert(decision.approved, "full trust clears delete-class commands");
    eq(decision.source, "prompt", "full trust is a prompt decision");
  }

  // 自动审批 but the extreme switch is off => human
  {
    let asked = 0;
    const g = new ApprovalGate({
      askHuman: async () => {
        asked++;
        return true;
      },
      reviewer: () => {
        throw new Error("reviewer must not run while the switch is off");
      },
      extremeAutoApprovalEnabled: () => false,
    });
    const decision = await g.decide(requestFor("自动审批", "extreme"));
    eq(decision.source, "human", "switch off forces a human for delete-class");
    eq(asked, 1, "human was asked once");
  }

  console.log(failures === 0 ? "APPROVAL TESTS PASSED" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

await run();
