# XINGJI Neutrino

A CLI coding agent that lives in your terminal. Neutrino gives you an interactive chat interface backed by LLMs, with built-in tool use (running commands, reading and writing files) so it can help you work on real projects.

## Features

- **Interactive terminal UI** — logo screen, chat, model select, history, and settings screens.
- **Full mouse support** — hover to highlight, click to select/open/position the cursor, wheel to scroll, right-click to go back (like OpenCode).
- **Select & copy** — drag the mouse over any text (agent output, the input box, menus, …) to select it; releasing the button copies the selection to the clipboard (via OSC 52, with a native fallback). Holding the drag against the top or bottom edge of the log scrolls it, so one selection can run for as long as the whole conversation.
- **Paste-friendly input** — like OpenCode, a pasted block has its newlines turned into spaces so it stays one line, and only a manually typed `Enter` submits the message.
- **Faithful log rendering** — text in the chat log keeps its indentation, blank lines and column alignment; when a long tool-output line wraps, continuation lines stay indented instead of snapping back to the left margin.
- **Scrollable context log** — a vertical scrollbar is drawn on the right edge of the chat (and the agent-conversation viewer) whenever the conversation is taller than the view. Scroll with the wheel, `PgUp`/`PgDn` or `↑`/`↓`, or grab the scrollbar with the mouse and drag it like in a GUI.
- **LLM providers** — ships with DeepSeek, OpenAI, and Anthropic presets; works with any OpenAI-compatible endpoint.
- **Tool calling** — the agent can run shell commands, read files, write files, and list directories in your working directory.
- **Streaming responses** — token-by-token output with pause/resume (`ESC ESC`).
- **Intensity control** — tune `temperature`/`top_p` from `Low` to `Ultra`.
- **Session history** — messages are saved before a turn starts, streamed replies are checkpointed every second, and tool calls/results are saved immediately. The history screen lists conversations started in the current working directory. Failed saves are shown in the terminal and browser UI.
- **Auto-folding turns** — once a turn finishes, the work behind the reply (the thinking and the tool calls) folds into one summary line in both the terminal and the browser, while the answer itself always stays on screen. Click the line to read the whole round again; a turn with little to hide, or a long answer on its own, stays open. A turn stopped with `ESC ESC` is paused, not finished, so it stays open. Nothing is dropped: the transcript, the saved session and the model's context keep every message.
- **Complete conversation history** — context compression keeps every original message and tool result on disk. The earlier portion starts collapsed in the terminal and browser; click **Earlier conversation** to expand it, including in reopened history. Model requests use a separate summary plus recent messages.
- **Plan-first turns** — before a request is answered, a planner agent splits it into ordered, independent steps ("model the case from box.png", "animate the camera: push in, orbit, pull back"), and the worker then executes those steps one at a time, top to bottom. Every step is a concrete deliverable, so later work is explicit instead of one vague instruction. See [Plan-first turns](#plan-first-turns).
- **The step card** — click `ⓘ` in the chat header (or press `Ctrl+P`) to open the info card in the top-right corner. It lists the plan as a vertical timeline of nodes: the step being worked on is highlighted, steps still to come are lit, and finished steps are drawn dark with a tick. The same card shows prompt/completion/total token counts when no plan is running.
- **Sub-agents** — independent work can be handed to a sub-agent: a second agent loop with its own context, its own tool calls and the same approval gate. Only its report comes back, so a survey that reads thirty files does not fill the conversation with thirty files. See [Sub-agents](#sub-agents).
- **Agent history browser** — view past sessions from other CLI agents (Claude Code, Codex, OpenCode) directly from the history screen.
- **Approval gate** — risky commands and paths outside the working directory need your sign-off. The header turns orange and reads **Request Approval**; press `Y` or `N`. Delete-class commands always ask, unless you explicitly granted full trust, and there is an opt-in reviewer agent for automatic decisions.
- **Browser UI on by default** — every `neutrino` launch also mounts a local website at <http://127.0.0.1:8765> that lists every saved conversation grouped by working directory, streams the running one in real time, and lets you pause/resume it, send messages, switch provider/model/intensity, and edit settings from the browser. Use `--port`/`--host` to move it, `--lan` to share it, or `--no-web` to keep the terminal only.

## Requirements

- Node.js **>= 18.0.0**
- An interactive terminal (TTY)

## Installation

```sh
npm install -g @xingjisoft/neutrino
```

Or run from source:

```sh
git clone <repo-url> neutrino
cd neutrino
npm install
npm run build
npm link
```

## Usage

```sh
neutrino
```

Type a message on the start screen and press `Enter` to begin a new chat.
The browser UI is mounted at <http://127.0.0.1:8765> at the same time; see
[Web UI](#web-ui) below for `--port`, `--lan` and `--no-web`.

### Keys

| Keys | Action |
| --- | --- |
| `Enter` | Send message / confirm (only a manually typed Enter sends) |
| `←`/`→`, `↑`/`↓` | Move focus / navigate |
| `Ctrl+E` | Open model config |
| `Ctrl+B` | Back to menu (from chat) |
| `Ctrl+L` | Clear conversation (from chat) |
| `Esc Esc` | Pause / resume streaming (a paused turn stays open: only a finished reply folds) |
| `Esc` | Clear an active selection |
| `PgUp` / `PgDn` | Scroll chat history |
| `Ctrl+C` | Do nothing while text is selected; otherwise pause the running conversation or show the exit hint at the top |
| `Ctrl+C` × 3 | Quit after three consecutive presses, no more than 1.5 seconds apart (another key, paste, click or scroll resets the count) |
| `Ctrl+Shift+C` | Quit immediately (requires the terminal to forward the shortcut) |
| `Ctrl+A` | Toggle Request Approval / Auto Approval in a conversation |
| `Ctrl+P` | Toggle the plan / token info card in the top-right corner |
| `Y` | Approve the pending request (while the approval card is up) |
| `N` / `Esc` | Deny the pending request |
| `Ctrl+Q` | Quit |

### Mouse

| Action | Effect |
| --- | --- |
| Hover over an item | Highlight / select it in lists and menus |
| Click an item | Select and confirm (open a screen, load a session, apply a setting…) |
| Click the input box | Focus it and place the cursor at the clicked position |
| Click a folded turn | Expand the complete round, or fold it again |
| Click `⚙ tool` | Expand or collapse a tool call's output |
| Click and drag | Select text under the rectangle; releasing copies it to the clipboard |
| Drag onto the first/last row of the log | Scroll the log a line at a time (faster the longer you hold it) and keep growing the selection past the screen |
| Click the header (left of `ⓘ`) | Open the model selector |
| Click `ⓘ` (chat header) | Toggle the plan / token info card |
| Drag the scrollbar | Grab the thumb on the right edge of the chat/log and drag it to scroll |
| Scroll wheel | Scroll the chat/log, or move through lists |
| Right-click | Go back (like `Esc`) |

The selection highlight is drawn over whatever is on screen, so it works uniformly on the chat log, the input box and every menu. Selected text is copied with trailing whitespace trimmed per line (shell-style), so it can be pasted straight back into a terminal. UI chrome (such as the scrollbar) is skipped when copying and highlighting, so a copy never picks up the bar or the padding in front of it.

A drag that scrolls keeps its starting point anchored to the line it began on,
not to the row it began on: the mark stays on the edge that is scrolling, the
highlight stops at the log's edge instead of spilling into the header or the
input box, and the copy includes the lines that scrolled out of view. Scroll back
and the selection shrinks again; press `Esc` to drop it.

## Plan-first turns

A request is answered in two passes. A **planner agent** first turns the message
into an ordered list of independent steps; a **worker agent** then executes
exactly one step per pass, from the top down. Each step names one deliverable, so
a long request stops being a single vague instruction and becomes a sequence of
concrete, verifiable ones. The plan is written into the conversation as a
message and saved with the session, so the steps of a reopened conversation are
still there.

The steps are also listed in the `ⓘ` card in the top-right corner of the chat —
click it, or press `Ctrl+P`:

- nodes run top to bottom in execution order, joined by a connector,
- the step being worked on is the highlighted row,
- steps still to come are lit, and
- finished steps are drawn dark with a tick; a failed one is marked in red.

The card opens by itself as soon as a plan is written, and closing it loses
nothing: `Ctrl+P` brings it back. On a short terminal the card shows a window
around the running step and counts the steps above and below it.

A step that fails stops the plan: the remaining steps stay pending and the next
message can re-plan them. A turn paused with `Esc Esc` stops the plan and marks
it **stopped**, so no step keeps looking live. When no usable plan comes back —
a single-action request, a provider error, an answer that is not a plan — the
turn runs in one pass exactly as before, so planning is never a new way to fail.

The prompts are files, not code: [`assets/planner.txt`](./assets/planner.txt)
says how steps are written, [`assets/step.txt`](./assets/step.txt) is the
instruction for each step, and [`assets/prompt.txt`](./assets/prompt.txt) is the
worker's base system prompt. Turn planning off for one run with
`NEUTRINO_PLAN=off`, or permanently with `"plan_first": false` in `config.json`.

## Sub-agents

The agent can hand one self-contained sub-task to a **sub-agent**: a second agent
loop with its own transcript, its own tool calls and the same working directory.
Only its final report comes back — the files it read and the commands it ran
never enter the main conversation. That is the point: surveying a large codebase
or probing how a command behaves costs many messages, and the parent needs the
conclusion, not the transcript. The child's tokens still count in the
conversation's usage.

- The parent calls the `delegate` tool with a complete task and, optionally, a
  little context. The sub-agent cannot see the conversation and cannot ask the
  user, so a task that refers to "the file above" fails; the system prompt tells
  the model to write a brief that stands alone.
- Its tool calls go through the **same approval gate**: a risky call parks the
  turn and shows the usual card (the header turns orange, the browser shows its
  banner). Denying it tells the sub-agent not to retry unchanged, and the parent
  receives the refusal in the report.
- Delegation is one level deep — `delegate` is not in a sub-agent's toolset — so
  the work always has one owner and one pause button.
- While it runs, the terminal status line and the browser badge name the current
  phase (`Sub-agent — read_file`), and the `delegate` tool block shows the task
  it was given. The report replaces that marker when it arrives, as the result of
  the tool call.
- The round limit (12) bounds a child that never finishes; the parent then gets
  the partial report, clearly marked as partial. A paused turn aborts the
  sub-agent and says so in the tool result.

The sub-agent's prompt is a file too: [`assets/subagent.txt`](./assets/subagent.txt).

## Configuration

Settings are stored under `~/.neutrino/`:

- `model.json` — provider and model definitions (edit to add your own endpoints).
- `config.json` — app configuration (selected provider/model/intensity, theme,
  language, approval mode, `auto_approve_extreme_risk`, `sound_alerts`,
  `web_console`).
- `session/` — saved conversation sessions, one JSON file per session.

Set your API key in the model select screen or directly in `model.json`.

A few environment variables override flags:

| Variable | Effect |
| --- | --- |
| `NEUTRINO_WEB_PORT` | Web UI port: like `--port` in either mode, and it mounts the UI even when `web_console` is off. |
| `NEUTRINO_WEB_HOST` | Interface to bind, like `--host`; also mounts the UI when `web_console` is off. |
| `NEUTRINO_NETWORK_ATTEMPTS` | Total tries for a model request that keeps dropping (default 7). |
| `NEUTRINO_RETRY_DELAY_MS` | Wait before the first retry in ms; each retry doubles it (default 5000). |
| `NEUTRINO_PLAN` | `off` answers a request in one pass without planning it (overrides `plan_first`); `on` forces planning. |

### Approvals

Every tool call is classified before it runs.

| Class | Examples | Default behaviour |
| --- | --- | --- |
| Routine | `npm run build`, `git status`, reading or writing inside the project | Runs without asking |
| High | `sudo`, `chmod`, package installs, `git push`, `curl`, inline `python -c`, any path outside the working directory | Asks the user |
| Extreme | Delete-class: `rm`, `del`, `shred`, `mkfs`, `git clean -f`, `git reset --hard`, `find -delete`, `DROP TABLE`, … | Always asks the user |

While a call waits for an answer the top bar turns orange and reads
**Request Approval**, and an orange card floats above the input box with the
command, **why the agent says it needs it**, why it was flagged, and
`[ Y ] Approve` / `[ N ] Deny`. Approving runs the call; denying returns a note
to the model so it can pick another route instead of retrying.

Every tool call carries a `reason` argument, and a call that needs approval but
states none does not run: the gate refuses it before you are interrupted or a
reviewer is paid for, and the model is told to resend the same call with a
reason. The reason is the agent's own claim, shown apart from the arguments.
A vague, imperfect or seemingly unrelated reason is not itself a safety hazard;
reviewers judge the actual call's consequences and explicit user restrictions.

Two phrases in your message change the policy for that conversation:

| Phrase in the prompt | Effect |
| --- | --- |
| `无需审批` | High-risk calls run without asking. Delete-class calls still ask. |
| `我已知悉风险，同意给予完整权限，无需任何审批` | Nothing asks, including delete-class calls. |

The one-row **Request Approval / Auto Approval** button above the main menu's
version label sets and remembers the default for new conversations. Each terminal
conversation has its own button above the input (or **Ctrl+A**), and each browser
conversation has a switch in its controls. The conversation's choice is saved
with its history and synced between terminal and browser. Writing `自动审批` or
`自动批准` in a prompt no longer enables automatic review.

With **Auto Approval** enabled, each pending tool call receives **two independent
safety reviews**. A review round passes when its average safety score is at least
60/100 and no concrete safety hazard or failed review blocks it. Task relevance
has zero weight and no ordinary minimum: even a score of 0 does not by itself
prevent a safe call from running, and doubts about purpose must not lower safety.

Only an extreme, obvious task mismatch can veto on relevance: both reviewers
must independently mark it, give a relevance score of at most 5/100, and provide
specific evidence comparing the task and proposed action. One suspicion, weak
justification, or uncertainty about the task is insufficient.

The policy favors ordinary implementation and verification steps, including
scoped edits, dependency installation, public network checks and temporary test
files. Concrete serious hazards and explicit user prohibitions block approval;
a failed, timed-out or malformed review also prevents automatic execution.
Every assessment and the safety result are included in the decision, per round
for delete-class calls.

Each turn captures its literal user request and earlier user messages separately
from summaries and tool output, so short follow-ups keep their task context.
Queued messages take effect on the next turn. Denied tool results include the
reviewed user request and recent user requests for diagnosis.

Automatic approval of delete-class commands is behind a switch in **Settings →
Extreme-risk auto-approval**, which is **off by default**: while it is off,
delete-class calls always go to a human even in **Auto Approval** mode.

With the switch on, a delete-class call is reviewed **three separate times**.
Each round is the usual pair of independent reviewers; the rounds run one after
another and no round is told what an earlier one concluded. Every round is
judged on its own scores and the call only runs if **all three** approve, so the
first round that denies or fails ends the sequence: a deletion never gets a
second chance to pass. The switches are layered, so turning **Auto Approval**
off still sends every delete-class request to you. The reviewer model defaults
to the chat model and can be changed in **Settings → Approval reviewer model**.

### Sound alerts

A short cue plays when a turn finishes and when an approval request appears, in
both the terminal and the web UI, so a long task or a blocking approval is
noticeable from another window. Approval requests ring twice; finished turns
ring once. Toggle it in **Settings → Sound alerts** (TUI or web), or set
`"sound_alerts": false` in `config.json`.

Browsers refuse to start audio before a user gesture, so the web UI stays silent
until the page has been clicked or a key has been pressed at least once.

### Browsing other agents' history

From the history screen, select **Open other Agent's history** to view past sessions recorded by other CLI agents installed on your machine:

- **Claude Code** — reads `~/.claude/projects/**/*.jsonl`.
- **Codex** — reads `~/.codex/sessions` and `~/.codex/archived_sessions`.
- **OpenCode** — reads the local SQLite database (`opencode.db`) via `node:sqlite` (requires Node.js **22.13+**; silently unavailable on older versions).

Only sessions that were started in the current working directory are listed, so the history stays focused on the project you are in. These sessions are read-only; you can open them for review but not edit or delete.

## Web UI

Neutrino mounts a small website at <http://127.0.0.1:8765> whenever the
terminal UI starts. It groups every saved conversation by working directory
(showing the five newest per path with the rest collapsed), folds the work of
every finished turn into one summary line that opens on a click while the reply
stays on screen, streams a running conversation live, and lets you pause or
resume it and send new messages from the browser.

A saved transcript opens read-only, because nothing is running for it. Press
**Continue here** (or simply type in the composer) and the server resumes it
in-process — same model, working directory and token counters — so you can keep
chatting from the browser with no terminal attached. Turns are written back to
the same session file.

Use the selectors above a conversation to change its provider, model or
intensity, then press **Apply to conversation** (pause an active turn first).
The **Settings** (gear) button in the sidebar edits defaults for new conversations,
context compression and approval settings. Conversation choices are saved with
the transcript and do not overwrite the defaults. Configured models and keys
are shared with the terminal; keys stay on the server.

Context auto-compression starts at 80% of the current model's context window.
Models default to 1,000,000 tokens (compression at 800,000). Adjust the model
context window in terminal Settings or select the provider/model in Web Settings
and enter its capacity in tokens. This is saved per provider/model and applies
to future turns in active conversations. The legacy fixed
`context_compress_threshold` setting is no longer used.

```sh
# The terminal UI now brings the web UI up with it
neutrino

# Pick a different port or interface
neutrino --port 9000
neutrino --host 100.64.0.7

# Or serve only the saved history, with no terminal
neutrino web --port 8765
```

Then open <http://127.0.0.1:8765>. The site itself lives in [`web/`](./web) and
needs no build step; see [`web/README.md`](./web/README.md) for the API.

The console is on by default; turn it off for one run with `--no-web`, or
permanently in the terminal's **Settings → Web console**. The `--web-port` flag
is still accepted as an alias for `--port`. If the default port is already taken
(usually by another Neutrino instance), the terminal UI starts anyway and prints
how to choose another port.

### Reaching it from another device

The server binds to loopback, so only this machine can open it. To use it from a
phone, a tablet or another box on your LAN or VPN, bind an interface others can
see:

```sh
neutrino --lan                          # TUI + web UI on every interface (0.0.0.0)
neutrino --host 100.64.0.7              # TUI + web UI on one specific address
neutrino web --port 8765 --lan          # headless web UI on every interface
```

`--lan` is shorthand for `--host 0.0.0.0`; the two cannot be combined.

Startup prints every address that works, so you can copy the one matching the
device you are on:

```
Neutrino web UI listening on 0.0.0.0:8765
Open the address that matches your device:
  http://100.105.130.25:8765/
  http://192.168.1.211:8765/
  http://127.0.0.1:8765/
```

Open the address and sign in with your permanent Web password. The initial
password is **`114514`**. Change it in the browser's **Settings → Web access**
or in the terminal's **Settings → Web password**. It is saved as a salted hash
in `~/.neutrino/config.json` and survives restarts. While the site is running,
its address is also shown in the terminal header and in the terminal's
**Settings → Web console** row, which can start or stop it without a restart.

For automatic login, open `http://<host>:8765/?pwd=114514`. The page checks the
password, remembers the login, and removes `pwd` from the address bar. If it is
incorrect, the password login dialog lets you try again. URL-encode special
characters in your password.

The browser remembers your login in an HttpOnly cookie for up to one year,
including across server restarts. Changing the password signs out other
browsers; the browser that saves the new password stays signed in. Addresses
and startup output never contain your password or session credentials.

- **`--no-auth`** explicitly disables password login.
- Static files and the login endpoint remain public; all conversation and
  settings APIs require a login, including when accessed through localhost.
- **Firewall:** the first bind to `0.0.0.0` triggers an allow prompt on Windows
  and macOS. Allow it for private networks, and check that your WLAN is not
  marked "public", where incoming connections are blocked anyway.
- **`127.0.0.1` is still the default interface.** The console starts with the
  terminal UI, but it is not a network service until you pass `--host`/`--lan`.

## Built-in tools

The agent can call the following tools during a conversation:

- `run_command` — execute a shell command (120s timeout, output capped).
- `read_file` — read a text file (capped at 200KB).
- `write_file` — write content to a file.
- `list_files` — list directory contents.
- `delegate` — hand one self-contained sub-task to a sub-agent and return its report.

Every tool takes an additional `reason` argument: one sentence saying what the
call is for and why it is needed now. It is what the approval card shows and what
reviewers check the arguments against, so it is required even for calls that
usually run without asking.

## Development

```sh
npm run build    # compile TypeScript to dist/
npm test         # build, then run every test below
```

Individual tests:

```sh
node scripts/test-paste.mjs      # verify pasted newlines are flattened to spaces
node scripts/test-mouse.mjs      # verify mouse escape-sequence parsing
node scripts/test-cursor.mjs     # verify click-to-position-cursor math
node scripts/test-selection.mjs  # verify selection highlighting & text extraction
node scripts/test-drag-scroll.mjs # verify drag-select auto-scroll: edge scrolling, cross-screen copy
node scripts/test-copy.mjs       # verify a copy never includes the scrollbar or trailing padding
node scripts/test-scrollbar.mjs  # verify the conversation scrollbar size/position and drag maths
node scripts/test-markdown.mjs   # verify markdown/table rendering (incl. ragged rows)
node scripts/test-wrap.mjs       # verify indentation & spacing are preserved when wrapping
node scripts/test-render.mjs     # fuzz the diff renderer + render the chat screen,
                                 # asserting no stale/residual cells are left behind
node scripts/test-sanitize.mjs   # verify ANSI/control codes never reach the screen
node scripts/test-drift.mjs      # verify the input area self-heals after terminal drift
node scripts/test-fetch.mjs      # verify streamed requests release aborts, retry drops and the 7-attempt backoff
node scripts/test-compact.mjs    # verify context-compression planning
node scripts/test-history-fold.mjs # verify full-history retention, folding and resume
node scripts/test-web-history.mjs  # verify browser history disclosures and streaming state
node scripts/test-web-default.mjs  # verify the web console starts and toggles by default
node scripts/test-turn-fold.mjs    # verify folded turns keep their reply and every message
node scripts/test-plan.mjs         # verify plan-first turns, step order, the step card and the fallback
node scripts/test-subagent.mjs     # verify delegation: isolation, approvals, abort, round limits
node scripts/test-tools.mjs      # verify tool-output folding
node scripts/test-web.mjs        # verify the web server, API, SSE stream and path-traversal guards
node scripts/test-web-settings.mjs # verify model switching, persistence, browser controls and defaults
node scripts/test-web-settings-http.mjs # verify authenticated settings and model changes over HTTP
```

### Rendering model

The screen is drawn into a `Buffer` of cells which is diffed against the previous frame, so only changed rows are emitted. Rows are erased to the end of the line before being repainted, and the buffer keeps double-width glyphs consistent (writing over one half of a wide character blanks the other half). Together these guarantee that a repainted row can never leave a stale cell behind.

Because only *changed* rows are emitted, a row whose contents happen to be identical from one frame to the next is never rewritten — so if the terminal shifts its own contents behind our back (ConPTY reflowing the buffer mid-resize, a size-race repaint, a stray scroll) that row would stay stale. Two defences cover this: the persistent chrome (input box, tabs, key hints) is repainted on every frame via `Screen.alwaysRepaintRows()`, and the app periodically re-emits the whole cached frame (`Renderer.repaint()`) as a safety net. Both are no-ops when nothing drifted.

### Text hygiene

A cell's glyph is copied straight into the output stream, so a cell holding a *control* character becomes a command the terminal executes — an ESC sequence can move the cursor, clear the screen or leave the alternate buffer, and a TAB shifts the rest of the row. Tool output (ANSI colours from `ls --color`, `git`, `npm`, progress bars, …), file contents and pasted text all carry such bytes, so they are neutralised in three places:

1. `src/sanitize.ts` — `sanitizeText()` removes whole escape sequences (not just the ESC byte, which would leave `[31m` behind as literal text), expands tabs so measured widths match what the terminal draws, and drops any remaining control code. It is applied where untrusted text enters the display (chat messages, tool results, pasted input).
2. `Buffer` — writing a control character stores a space instead, preserving the column width the caller measured, so no cell can ever hold one.
3. `Renderer` — a last-resort check when emitting a row, so the byte stream cannot carry a control code even if a cell were populated another way.

### Network resilience

Model responses arrive over a streamed connection that can drop at any point. A single blip must not end the session — a turn is minutes of work, and a proxy that resets an idle socket says nothing about the user's task — so a failed request is retried before anything is given up:

| Attempt | Wait before it |
| --- | --- |
| 1 | — |
| 2 | 5s |
| 3 | 10s |
| 4 | 20s |
| 5 | 40s |
| 6 | 80s |
| 7 | 2m 40s |

That is seven tries and roughly five minutes in total, doubling every time: a link that is merely flaky recovers long before the budget is spent, while a link that is genuinely down is not hammered. `NEUTRINO_NETWORK_ATTEMPTS` and `NEUTRINO_RETRY_DELAY_MS` tune both numbers. The policy lives in `src/llm/retry.ts`.

What counts as worth retrying:

- **Connection failures** — a reset (`ECONNRESET`), a refused or unreachable socket, `EPIPE`, DNS (`EAI_AGAIN`), a connect timeout, and undici's `UND_ERR_*` codes.
- **A stream that dies before the first byte** — the server or a proxy closed the connection mid-flight (`TypeError: terminated`, `other side closed`, `socket hang up`, …). Nothing has reached the user, so the request is simply re-issued.
- **A transient HTTP status** — 408/425, 429 and 5xx (502/503/504 from a load balancer, 529 "overloaded"). A bad request is different: 400/401/403/404/422 surface on the first answer, because re-sending them only delays the real message.
- **A stream that dies after output has started** is *not* retried: replaying it would duplicate the reply, so the error is surfaced with the real reason expanded out of the `error.cause` chain (`fetch failed` alone says nothing useful) and the partial text is kept.

A retry can leave the stream silent for up to 160s, so it is never silent *about* being silent: the terminal status line and the web badge name the attempt and the delay ("Network hiccup — retrying in 40s (attempt 4/7)"). The wait is also polled, so pausing the turn, sending a newer message or quitting drops it immediately instead of sitting out the backoff.

Any stream the consumer walks away from (pause, or a newer turn taking over) always has its body cancelled, so sockets are not leaked.

### Crash safety

The TUI takes over the terminal: raw mode, the alternate screen and mouse
reporting. If the process ever dies without undoing those, the shell inherits a
terminal that types `[<b>;<x>;<y>M` mouse reports at every cursor move.

So the teardown sequence is registered three ways — normal quit, a
`process.on("exit")` hook that writes synchronously to fd 1, and
`uncaughtException` / `unhandledRejection` handlers. Normal quit uses the same
synchronous teardown, so pending frame output cannot swallow the cleanup.
Catchable exits also flush the latest conversation snapshot, including a partial
reply. Uncaught errors are appended to `~/.neutrino/crash.log` and exit with
status 1. SIGHUP and Windows Ctrl+Break also restore and checkpoint before exit.

Session snapshots are written to a temporary file in the session directory,
synced, then atomically renamed over the previous snapshot. A failed write
preserves the previous history, reports an error in the UI and crash log, and
is retried at the next checkpoint. Partial replies are replaced by the completed
reply in the saved snapshot, so reopening history does not duplicate them.

Key handlers and the render loop are also wrapped: they run inside `stdin`
callbacks and timers, where a throw is an uncaught exception that used to end
the session. A failed frame is now retried, and only a screen that cannot be
drawn at all stops the app.

An uncatchable kill (SIGKILL, TerminateProcess or a runtime/OS failure) cannot
run cleanup. Already-written snapshots survive; with a writable disk, streamed
output since the last one-second checkpoint may be lost. If a shell is stuck
in mouse mode, run this in Bash:

```sh
printf '\033[?2004l\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1015l\033[?25h\033[0m\033[?1049l'
stty sane
```

In PowerShell:

```powershell
$esc = [char]27
[Console]::Write("${esc}[?2004l${esc}[?1000l${esc}[?1002l${esc}[?1003l${esc}[?1006l${esc}[?1015l${esc}[?25h${esc}[0m${esc}[?1049l")
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
