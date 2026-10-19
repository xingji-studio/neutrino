# XINGJI Neutrino

A CLI coding agent that lives in your terminal. Neutrino gives you an interactive chat interface backed by LLMs, with built-in tool use (running commands, reading and writing files) so it can help you work on real projects.

## Features

- **Interactive terminal UI** — logo screen, chat, model select, history, and settings screens.
- **Full mouse support** — hover to highlight, click to select/open/position the cursor, wheel to scroll, right-click to go back (like OpenCode).
- **Select & copy** — drag the mouse over any text (agent output, the input box, menus, …) to select it; releasing the button copies the selection to the clipboard (via OSC 52, with a native fallback).
- **Paste-friendly input** — like OpenCode, a pasted block has its newlines turned into spaces so it stays one line, and only a manually typed `Enter` submits the message.
- **Faithful log rendering** — text in the chat log keeps its indentation, blank lines and column alignment; when a long tool-output line wraps, continuation lines stay indented instead of snapping back to the left margin.
- **Scrollable context log** — a vertical scrollbar is drawn on the right edge of the chat (and the agent-conversation viewer) whenever the conversation is taller than the view. Scroll with the wheel, `PgUp`/`PgDn` or `↑`/`↓`, or grab the scrollbar with the mouse and drag it like in a GUI.
- **LLM providers** — ships with DeepSeek, OpenAI, and Anthropic presets; works with any OpenAI-compatible endpoint.
- **Tool calling** — the agent can run shell commands, read files, write files, and list directories in your working directory.
- **Streaming responses** — token-by-token output with pause/resume (`ESC ESC`).
- **Intensity control** — tune `temperature`/`top_p` from `Low` to `Ultra`.
- **Session history** — messages are saved before a turn starts, streamed replies are checkpointed every second, and tool calls/results are saved immediately. The history screen lists conversations started in the current working directory. Failed saves are shown in the terminal and browser UI.
- **Token usage stats** — click the `ⓘ` in the chat header to see prompt/completion/total token counts for the current session.
- **Agent history browser** — view past sessions from other CLI agents (Claude Code, Codex, OpenCode) directly from the history screen.
- **Approval gate** — risky commands and paths outside the working directory need your sign-off. The header turns orange and reads **Request Approval**; press `Y` or `N`. Delete-class commands always ask, unless you explicitly granted full trust, and there is an opt-in reviewer agent for automatic decisions.
- **Browser UI on any port** — mount a local website that lists every saved conversation grouped by working directory, streams the running one in real time, and lets you pause/resume it or send new messages from the browser.

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

### Keys

| Keys | Action |
| --- | --- |
| `Enter` | Send message / confirm (only a manually typed Enter sends) |
| `←`/`→`, `↑`/`↓` | Move focus / navigate |
| `Ctrl+E` | Open model config |
| `Ctrl+B` | Back to menu (from chat) |
| `Ctrl+L` | Clear conversation (from chat) |
| `Esc Esc` | Pause / resume streaming |
| `Esc` | Clear an active selection |
| `PgUp` / `PgDn` | Scroll chat history |
| `Ctrl+C` | Copy the selection, or quit if nothing is selected |
| `Y` | Approve the pending request (while the approval card is up) |
| `N` / `Esc` | Deny the pending request |
| `Ctrl+Q` | Quit |

### Mouse

| Action | Effect |
| --- | --- |
| Hover over an item | Highlight / select it in lists and menus |
| Click an item | Select and confirm (open a screen, load a session, apply a setting…) |
| Click the input box | Focus it and place the cursor at the clicked position |
| Click and drag | Select text under the rectangle; releasing copies it to the clipboard |
| Click the header (left of `ⓘ`) | Open the model selector |
| Click `ⓘ` (chat header) | Toggle token usage stats |
| Drag the scrollbar | Grab the thumb on the right edge of the chat/log and drag it to scroll |
| Scroll wheel | Scroll the chat/log, or move through lists |
| Right-click | Go back (like `Esc`) |

The selection highlight is drawn over whatever is on screen, so it works uniformly on the chat log, the input box and every menu. Selected text is copied with trailing whitespace trimmed per line (shell-style), so it can be pasted straight back into a terminal. UI chrome (such as the scrollbar) is skipped when copying and highlighting, so a copy never picks up the bar or the padding in front of it.

## Configuration

Settings are stored under `~/.neutrino/`:

- `model.json` — provider and model definitions (edit to add your own endpoints).
- `config.json` — app configuration (selected provider/model/intensity, theme, language).
- `session/` — saved conversation sessions, one JSON file per session.

Set your API key in the model select screen or directly in `model.json`.

A few environment variables override flags:

| Variable | Effect |
| --- | --- |
| `NEUTRINO_WEB_PORT` | Web UI port: like `--web-port` in TUI mode, and the port in `neutrino web`. |
| `NEUTRINO_WEB_HOST` | Interface to bind, like `--host`. |
| `NEUTRINO_WEB_TOKEN` | Access token for `/api/*`, like `--token`. Set it to keep remote links stable across restarts. |

### Approvals

Every tool call is classified before it runs.

| Class | Examples | Default behaviour |
| --- | --- | --- |
| Routine | `npm run build`, `git status`, reading or writing inside the project | Runs without asking |
| High | `sudo`, `chmod`, package installs, `git push`, `curl`, inline `python -c`, any path outside the working directory | Asks the user |
| Extreme | Delete-class: `rm`, `del`, `shred`, `mkfs`, `git clean -f`, `git reset --hard`, `find -delete`, `DROP TABLE`, … | Always asks the user |

While a call waits for an answer the top bar turns orange and reads
**Request Approval**, and an orange card floats above the input box with the
command, why it was flagged, and `[ Y ] Approve` / `[ N ] Deny`. Approving runs
the call; denying returns a note to the model so it can pick another route
instead of retrying.

Two phrases in your message change the policy for that conversation:

| Phrase in the prompt | Effect |
| --- | --- |
| `无需审批` | High-risk calls run without asking. Delete-class calls still ask. |
| `我已知悉风险，同意给予完整权限，无需任何审批` | Nothing asks, including delete-class calls. |
| `自动审批` | Approvals go to a reviewer agent instead of you. |

With `自动审批`, a separate reviewer agent (its own system prompt, no tools, no
shared context) judges each pending call and answers with a JSON verdict. For
delete-class commands it spawns **three** independent reviewers, each looking at
the proposal from a different angle (data loss, blast radius, intent), and the
call only goes through when all three agree. A reviewer that fails, times out or
answers in the wrong shape counts as a denial.

Automatic approval of delete-class commands is behind a switch in **Settings →
Extreme-risk auto-approval**, which is **off by default**: while it is off,
delete-class calls always go to a human even if you wrote `自动审批`. The reviewer
model defaults to the chat model and can be changed in **Settings → Approval
reviewer model**.

### Browsing other agents' history

From the history screen, select **Open other Agent's history** to view past sessions recorded by other CLI agents installed on your machine:

- **Claude Code** — reads `~/.claude/projects/**/*.jsonl`.
- **Codex** — reads `~/.codex/sessions` and `~/.codex/archived_sessions`.
- **OpenCode** — reads the local SQLite database (`opencode.db`) via `node:sqlite` (requires Node.js **22.13+**; silently unavailable on older versions).

Only sessions that were started in the current working directory are listed, so the history stays focused on the project you are in. These sessions are read-only; you can open them for review but not edit or delete.

## Web UI

Neutrino can mount a small website on a port of your choice. It groups every
saved conversation by working directory (showing the five newest per path with
the rest collapsed), streams a running conversation live, and lets you pause or
resume it and send new messages from the browser.

A saved transcript opens read-only, because nothing is running for it. Press
**Continue here** (or simply type in the composer) and the server resumes it
in-process — same model, working directory and token counters — so you can keep
chatting from the browser with no terminal attached. Turns are written back to
the same session file.

```sh
# Mount the web UI while the terminal UI runs
neutrino --web-port 8765

# Or serve only the saved history, with no terminal
neutrino web --port 8765
```

Then open <http://127.0.0.1:8765>. The site itself lives in [`web/`](./web) and
needs no build step; see [`web/README.md`](./web/README.md) for the API.

### Reaching it from another device

The server binds to loopback, so only this machine can open it. To use it from a
phone, a tablet or another box on your LAN or VPN, bind an interface others can
see:

```sh
neutrino web --port 8765 --lan          # every interface (0.0.0.0)
neutrino --web-port 8765 --lan          # same, while the TUI runs
neutrino web --port 8765 --host 100.64.0.7   # one specific address
```

Startup prints every address that works, so you can copy the one matching the
device you are on:

```
Neutrino web UI listening on 0.0.0.0:8765
Open the address that matches your device:
  http://100.105.130.25:8765/?t=b2yzzvZyypcbmoDFdpT470qowAOE9Ca4
  http://192.168.1.211:8765/?t=b2yzzvZyypcbmoDFdpT470qowAOE9Ca4
  http://127.0.0.1:8765/?t=b2yzzvZyypcbmoDFdpT470qowAOE9Ca4
```

**The `?t=…` is an access token, and it is not optional.** This API can read
every saved conversation and drive an agent that runs shell commands, so exposing
it unauthenticated would hand anyone on the network a remote shell as your user.
Binding beyond loopback therefore generates a random token and requires it on
every `/api/*` request. The browser picks it up from the URL once, stores it, and
strips it from the address bar; if you open the bare address without it, the page
asks for the token instead of failing silently.

Some notes that matter in practice:

- **Treat the printed link as a password.** Whoever holds it has your agent.
- **The token changes on restart** unless you pin it, so the phone forgets it
  every time. Fix one with `NEUTRINO_WEB_TOKEN=<secret>` (or `--token <secret>`)
  to keep the link stable across restarts.
- **`--no-auth` disables the token** for a network you fully trust, such as a
  WireGuard/Tailscale range only your own devices can join.
- **Only static files are public** (`/`, `/app.js`, `/style.css`) — that is what
  makes the token prompt loadable. Everything under `/api/` is guarded.
- **Firewall:** the first bind to `0.0.0.0` triggers an allow prompt on Windows
  and macOS. Allow it for private networks, and check that your WLAN is not
  marked "public", where incoming connections are blocked anyway.
- **`127.0.0.1` remains the default** because the zero-config case should not be
  a network service.

## Built-in tools

The agent can call the following tools during a conversation:

- `run_command` — execute a shell command (120s timeout, output capped).
- `read_file` — read a text file (capped at 200KB).
- `write_file` — write content to a file.
- `list_files` — list directory contents.

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
node scripts/test-copy.mjs       # verify a copy never includes the scrollbar or trailing padding
node scripts/test-scrollbar.mjs  # verify the conversation scrollbar size/position and drag maths
node scripts/test-markdown.mjs   # verify markdown/table rendering (incl. ragged rows)
node scripts/test-wrap.mjs       # verify indentation & spacing are preserved when wrapping
node scripts/test-render.mjs     # fuzz the diff renderer + render the chat screen,
                                 # asserting no stale/residual cells are left behind
node scripts/test-sanitize.mjs   # verify ANSI/control codes never reach the screen
node scripts/test-drift.mjs      # verify the input area self-heals after terminal drift
node scripts/test-fetch.mjs      # verify streamed requests release aborts and retry drops
node scripts/test-compact.mjs    # verify context-compression planning
node scripts/test-tools.mjs      # verify tool-output folding
node scripts/test-web.mjs        # verify the web server, API, SSE stream and path-traversal guards
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

Model responses arrive over a streamed connection that can drop at any point. A single blip should not end the session, so three cases are handled:

- **The request never goes out** (`fetch` rejects) — retried a couple of times with a short backoff, bounded by a connect timeout.
- **The stream dies before the first byte** — the server or a proxy closed the connection mid-flight (`TypeError: terminated`, `other side closed`, …). Nothing has reached the user, so the request is simply re-issued.
- **The stream dies after output has started** — retrying would duplicate text, so the error is surfaced instead, with the real reason expanded out of the `error.cause` chain (`fetch failed` alone says nothing useful).

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
