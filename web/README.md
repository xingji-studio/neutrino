# Neutrino Web UI

A small, dependency-free single page app that is served by the Neutrino CLI at
<http://127.0.0.1:8765> whenever the terminal UI runs. It lets you:

- browse every saved conversation grouped by working directory (like Codex),
  with only the five latest transcripts per path shown and the rest collapsed;
- watch a running terminal conversation stream in real time: the work behind every
  finished turn folds into one line that opens on a click, while the reply itself
  stays on screen (the turn being answered is open, and a pause is not a fold);
- read replies as rendered markdown: headings, nested/task lists, tables, block
  quotes, code fences, emphasis, safe links and images; raw HTML is escaped;
- start a new conversation in a working directory you choose, including a folder
  created from the built-in folder picker;
- switch the workspace between every known folder and **All directories**;
- switch the provider, model and intensity for the next turn;
- edit every terminal setting — defaults, interface language, plan-first turns,
  default approval mode, context compression, reviewer, Web password, and LAN
  access;
- switch the interface between English and 简体中文, instantly and persistently;
- open the same plan / token card as the terminal's `ⓘ`, clear a conversation,
  delete a saved transcript, and review or migrate other agents' history;
- drive the running conversation: pause / resume the current turn and send new
  messages (they queue while the agent is busy);
- pick up a saved conversation in the browser and keep chatting, even when no
  terminal is running;
- run the console as a detached background service, so conversations started in
  the browser survive closing the terminal and the CLI process.

Nothing needs to be built — these are plain `.html`, `.css` and `.js` files.

## Running it

The terminal UI starts the website by default:

```sh
neutrino
```

Use `--port` to move it, `--no-web` to skip it for that run, or turn it off
permanently in the terminal's **Settings → Web console**. LAN access can be
switched on and off at any time in the browser's **Settings → Web access**
without restarting anything.

To keep the console alive after the terminal exits, turn on **Settings →
Background residency** in either workspace, or use `neutrino background` — see
[Background residency](#background-residency).

Or serve only the saved history, without a terminal:

```sh
neutrino web --port 8765
# or
npm run web
```

Then open <http://127.0.0.1:8765>.

## Background residency

Background residency is off by default. It is a property of the process, so the
regular and Pro workspaces share it; changing it in either page (or in the
terminal's **Settings → Background residency**) applies immediately, including
to browser tasks already in progress.

With it on, closing the terminal or exiting the CLI does not interrupt browser
conversations. With it off, the console follows its attached terminals and lets
current browser tasks finish before it shuts down. The terminal's own
conversations remain local to the terminal. Terminal and standalone launches
share one Web console; a standalone launch reports a conflict if its requested
port, interface or password setting differs from the running console. A ready
service can be managed without a terminal:

```sh
neutrino background start     # detach the web console
neutrino background status    # show its pid and address
neutrino background open      # open it in the default browser
neutrino background stop      # stop it
```

On Windows the service adds a notification-area icon using the same orbit badge
as the regular console's top-left logo. Click it to open the console; its menu
opens or stops the service. `--no-tray` suppresses it, and `NEUTRINO_NO_TRAY=1`
does the same for automation. The service records its pid, address and a random
management token in `~/.neutrino/background.json` (mode `0600`) and appends
startup/stop diagnostics to `~/.neutrino/background.log`. The token protects
`/api/background/ping` and `/api/background/stop`; it is never sent to a
browser.

When a console is mounted by the terminal and the setting is off, the first
browser to open it is offered **建议开启后台常驻，避免误触中断任务** with a
highlighted **开启** and **取消**. Either answer consumes the invitation for
that CLI run — a reload does not ask again. **开启** applies immediately to the
current browser tasks. The invitation is never shown when residency is already
on or by a bare `neutrino web` server.

## Using it from another device

The server binds to loopback by default. To open it from your phone or another
machine, bind an interface others can reach:

```sh
neutrino --lan                               # TUI + web UI, every interface (0.0.0.0)
neutrino --host 100.64.0.7                   # TUI + web UI, one specific address
neutrino web --port 8765 --lan               # headless web UI, every interface
```

You can also switch this at runtime from the browser: **Settings → Web access →
Allow access from other devices (LAN, 0.0.0.0)**. The server re-binds the same
port to `0.0.0.0` immediately — no restart, and the tab you are using keeps its
open connections — and saves the choice in `config.json`, so the next launch
starts on the LAN too. Turning the switch off returns the console to
`127.0.0.1`. An explicit `--host`/`--lan` decides the interface at startup; the
in-page switch takes over from there for the running process.

The console can read every transcript and drive an agent with shell access, so
keep the Web password on: anyone who can reach the port can use it.

On a narrow screen the console shows one pane at a time: the conversation list,
and then the open conversation. The back arrow in the header and the browser's
own Back button both return to the list, and Forward reopens the conversation
that was open.

Startup prints the addresses to open:

```
Neutrino web UI listening on 0.0.0.0:8765
Open the address that matches your device:
  http://192.168.1.211:8765/
  http://127.0.0.1:8765/
```

Hypervisor and container host-only adapters (`vEthernet`, VMware, VirtualBox,
Docker), link-local `169.254/16` and loopback addresses other than `127.0.0.1`
are left out of that list on purpose: they cannot be reached from another
device. CGNAT ranges such as Tailscale's `100.64/10` are kept, since a VPN is a
common way to reach a machine.

## Authentication

The Web UI uses a permanent password, initially **`114514`**, on both localhost
and network interfaces. Change it in **Settings → Web access** in the browser
or **Settings → Web password** in the terminal. In the browser, enter the new
password twice and save; leaving both fields blank preserves the current one.
In the terminal, select the password row, press Enter, type or paste a new
password, and press Enter to save (Escape cancels).

Only a salted scrypt hash is stored in `~/.neutrino/config.json`. The password
does not expire and is not reset when the server restarts. Settings never send
back the password or its hash.

A modal login form stays above the conversation UI. Successful login sets an
HttpOnly, SameSite=Strict cookie, remembered for up to one year and shared by
HTTP requests and the SSE stream. Session credentials are never put into URLs
or browser localStorage. A password change invalidates existing login cookies; the browser
that saves the password receives a replacement cookie and stays signed in.

To sign in directly from a link, open `http://<host>:8765/?pwd=114514`.
The browser automatically checks the supplied password through the login endpoint
before loading conversations, remembers the login cookie, and removes `pwd`
from the address bar while keeping other query parameters and the URL fragment.
An incorrect password or a failed request shows the normal login dialog with
an error, so you can enter the password manually. URL-encode passwords that
contain special characters (for example, `+` becomes `%2B` and `&` becomes `%26`).

For scripts, POST `{"password":"114514"}` to `/api/auth/login` and retain the
returned cookie for subsequent requests. POST `/api/auth/logout` clears the
browser cookie. Missing or invalid login cookies receive HTTP 401. Legacy token
headers, token URLs, `--token` and `NEUTRINO_WEB_TOKEN` are no longer used.

Static files and the login/logout routes stay public. `--no-auth` explicitly
disables password login.

## Pro workspace

The composer has a preset card at its bottom-right. Open it and drag the slider
to select a team. There are eight roles: main, reasoning, frontend, backend,
approval, planning, modeling and reserved image generation. Presets are copied
unchanged from the supplied example into `~/.neutrino/pro/model.json` on first
use. Edit role assignments there; **Settings** controls the default preset and
maximum delegation depth (10 by default).

Every task checks all active models with a small completion request. Unavailable
roles recurse down to lower presets independently, and a popup shows the
replacements. These changes are task-local. The planner then writes the plan
before main execution; nested specialist calls and commands use the same
approval gate, with the approval role providing automated reviews.

Pro API additions: settings return `pro.presets`, `pro.preset` and
`pro.max_recursion_depth`; settings patches accept `pro_preset` and
`pro_max_recursion_depth`. New and resumed conversations accept `pro_preset`.
`POST /pro/api/live/:key/pro-preset` with `{"preset":"medium"}` changes an idle
or paused conversation. Snapshots include `pro.checking`, effective `pro.models`,
`pro.fallbacks`, `pro.checkId` and any `pro.error`.

The console has two workspaces. The regular one lives at `/`; the isolated **Pro** workspace lives at `/pro`. Both use the same page, the
same login cookie and the same model catalog, but nothing else is shared:

- **Conversations** — Pro transcripts are saved under
  `~/.neutrino/pro/session/`, so neither sidebar ever lists the other
  workspace's history. Live sessions are separated too: a Pro tab cannot read,
  stream, drive or close a regular session, and vice versa.
- **Settings** — Pro has its own `~/.neutrino/pro/config.json` with its own
  language, sound alerts, default preset, delegation depth and recent folders.
  `~/.neutrino/pro/model.json` records role models, effort and context capacities;
  provider credentials stay in the shared ordinary model catalog.
- **Shared on purpose** — the Web password, the approval policy (default
  approval mode, extreme-risk auto-approval) and the console's LAN access. They
  protect or configure the whole machine, so both workspaces, the terminal and
  every browser read and write the same values.

In the regular console, click the orbit badge to the left of the **Neutrino**
title (or the blue hint pointing at it). A `#151515` curtain fades in and plays
the `neutrino-pro.gif` wordmark in the centre; after three seconds it fades out
onto `/pro`. The X on the blue hint dismisses it permanently for this browser.
In the terminal, the **启用Pro模式** box below the status bar starts the Web
console if necessary and opens `/pro` in the default browser. Pro mode uses the
static `web/neutrino.png` wordmark as its top-left logo, renames the sidebar
brand to **Neutrino Pro**, and puts an **Exit Pro mode / 返回普通模式** button
at the top-right of the workspace, which returns to the regular console at
`/`. The rest of the workspace is identical to the regular one. The interface
is available in English and 简体中文 in both workspaces (each remembers its own
choice).

Every API route below has an isolated twin under `/pro/api/` — for example,
`/pro/api/overview`, `/pro/api/settings` and `/pro/api/live/:key/stream`. The
login/logout routes are shared and stay unprefixed.

## Models and settings

Open the model card at the lower right of the composer to choose a **Provider**
and **Model**, and adjust **Thinking intensity** with the slider. Changes to an
idle or paused conversation apply immediately to its next turn and are saved
with the transcript. The same controls update a conversation running in the
terminal. Pause an active turn before changing its model.

For saved history or a new workspace conversation, the card keeps the selection
as a draft. **Continue here** or sending a message starts the conversation with
that selection, so a transcript whose old model was removed can still continue.

The **Settings** (gear) button in the sidebar opens the interface language,
plan-first turns, the default approval mode, defaults for new conversations, the
context compression threshold, the approval reviewer model, sound alerts, the
extreme-risk automatic approval option, background residency, LAN access, and
the Web password. Save settings explicitly; cancelling leaves the saved values
intact. Conversation model changes are separate from these defaults. Models come
from the same catalog as the terminal, and API keys stay on the server. Configure
missing keys in the terminal model screen first. Intensity uses the same
Low–Ultra sampling settings as the terminal, and both only offer the levels the
selected model declares in `model.json`. The regular and [Pro](#pro-workspace)
workspaces keep their own copy of every setting here except the approval policy,
the Web password, LAN access and background residency, which belong to the whole
process.

## New conversations and working directories

**New conversation** starts a chat that has no transcript yet. The dialog takes a
working directory plus provider, model, thinking level and approval mode. The
conversation is browser-owned from that moment: it appears in the sidebar under
its folder and is written to its own session file once the first message exists.

**Browse…** opens the server-side folder picker. It lists folders only, offers
the existing drive roots (on Windows) or `/`, moves up through the directory
tree, and can create a folder in place. **Use this folder** fills the working
directory of the new conversation.

**Working directories** (the folder button under New conversation) shows every
folder the console has opened or that already holds conversations. Choosing one
scopes the sidebar to that folder and shows a landing page where typing starts a
conversation there. **All directories** returns to the grouped view. Opened
folders are stored in `config.json` under `web_workspaces`, so an empty folder
that has no conversations yet is still listed after a restart.

## Interface language

The sidebar footer and **Settings → Interface** both offer English and 简体中文.
The change is applied to the already-open page (labels, messages, status line,
plan card and dialogs) without a reload, is stored in the workspace's
`config.json`, and is shared by every browser showing that workspace. The
regular and Pro workspaces remember their own choice. The terminal UI stays in
English. New conversation content, of course, remains in the language the model
writes.

## Sidebar status marks

Every row in the sidebar carries one mark. A **blue dot** means the conversation
finished and has not been opened since, a **turning ring** means a turn is
running, and an **amber dot** means a tool call is waiting for your answer. The
amber mark only appears while the conversation really asks for approval — with
automatic review the reviewers answer for you, so the row keeps showing the
running ring.

The blue dot asks once: opening the row answers it, and the next turn that
finishes asks again. The console remembers those answers in a file of its own,
`~/.neutrino/web.json` (the regular and Pro workspaces each keep their own
record), so the terminal UI never carries data it does not read, and a reload, a
restart of the console or a change of port does not bring every dot back.

## History vs. live sessions

A saved transcript on disk is a finished record: nothing is running, so the
page shows it read-only (a neutral `read-only` badge) and there is nothing to
pause.

To continue one, either

- press **Continue here** in the header, or
- just start typing in the composer and press Enter.

Both create a *browser-owned session*: the server resumes the transcript from
disk, registers it with the live hub, and runs the agent loop headlessly with
the model, provider, intensity, working directory and token counters recorded in
the file. From that moment the page behaves exactly like a live terminal
conversation — streaming output, tool calls, pause/resume, queued messages — and
every turn is written back to the same transcript file.

If the same transcript is already live (a terminal attached, or another tab
resumed it), the page attaches to that session instead of starting a second one.
Browser-owned sessions are dropped after 30 idle minutes, or immediately through
`POST /api/live/:key/close`. Sessions owned by the terminal cannot be closed from
the web.

**Clear** empties the running conversation in place (the previous transcript is
checkpointed first and stays on disk), mirroring `Ctrl+L` in the terminal. A
read-only transcript gets **Delete** instead, which removes the saved JSON file
after confirmation; a conversation that is currently live cannot be deleted.
Sessions from the terminal's `Ctrl+L` also appear as fresh live conversations in
the sidebar.

## Other agents' history

**Other agents** in the sidebar lists read-only sessions recorded by Claude Code,
Codex and OpenCode for the current working directory (the scoped workspace, the
open conversation's folder, or the server's launch directory). Clicking one shows
the complete transcript in the conversation pane with a `read-only` badge. The
sources are the same as the terminal's history browser; OpenCode requires Node.js
22.13+ because it reads its SQLite database through `node:sqlite`.

Click **Migrate session** at the bottom right of an opened transcript to convert
its readable user/assistant text into a new, saved Neutrino conversation. The
copy opens immediately in the same working directory, using the current
Neutrino model (or the current Pro preset on `/pro`). The source is unchanged.
Foreign system prompts, tool records and non-text attachments are not imported.
The button is disabled while copying; a failed migration leaves the source open
with an error so you can retry.

## Plan-first turns

A browser-owned turn is planned before it runs, exactly like a turn in the
terminal: the planner agent writes the ordered steps, then each step is executed
one at a time. The plan is written into the transcript as an assistant message,
so it shows up in the conversation with everything else, and it is saved with the
session (`plan` in the session file) so a resumed transcript still knows its
steps.

The plan travels in every live snapshot as a structured field — no text parsing
needed by a client:

```json
"plan": {
  "goal": "build and animate the scene",
  "steps": [
    { "title": "Model the case from box.png", "detail": "match the reference", "status": "done" },
    { "title": "Model the monitor from vision.jpg", "status": "active" },
    { "title": "Animate the camera", "status": "pending" }
  ]
}
```

`status` is `pending`, `active`, `done` or `failed`; `stopped: true` marks a plan
whose turn was paused before the last step. The terminal draws this in its `ⓘ`
card, and the web console renders the same timeline in its `ⓘ` plan card: the
active step is highlighted, finished steps are ticked, failed steps are red, and
the footer counts the steps completed. The card also shows token usage when no
plan is running.

Planning is the default for both loops. It can be turned off with
`"plan_first": false` in `~/.neutrino/config.json` or `NEUTRINO_PLAN=off`; a
request that produces no usable plan then runs in one pass.

## How real-time works

A `ChatScreen` registers itself with the in-process hub when it is opened. Every
time it changes (a streamed token, a tool call, a pause, a save) it notifies the
hub, which coalesces updates and pushes a snapshot over
`GET /api/live/:key/stream` (SSE). The page keeps the open conversation in sync
and re-renders it; the sidebar polls `/api/overview` for new sessions.

Browser-owned sessions publish to the same hub, so the page code does not need
to know whether a conversation is driven by the terminal or by the server.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/overview` | Sessions grouped by cwd + live sessions |
| GET | `/api/sessions` | Flat list of saved sessions |
| GET | `/api/workspaces` | Recent working directories, launch cwd and home |
| POST | `/api/workspaces` | Validate and remember `{ "path": "…" }` |
| GET | `/api/fs?path=…` | Folder listing for the picker (folders only, roots, parent) |
| POST | `/api/fs/mkdir` | Create `{ "path": "…" }` and return the new path |
| POST | `/api/conversations` | Start `{ cwd, selection?, approval_mode? }`, returns `{ key, snapshot }` |
| GET | `/api/settings` | Model catalog (each model lists its supported intensities), languages, public settings, the live bind address (`web_host`, `web_urls`) and the background state (`background`, `background_running`, `background_url`, one-time `background_prompt`); no credentials |
| POST | `/api/settings` | Save validated `{ selection?, settings? }`, including `language`, `plan_first`, `approval_mode`, `web_lan`, `background` and `web_password` |
| POST | `/api/background/dismiss` | Consume the one-time background-residency invitation for this console run |
| GET | `/api/background/ping` | Management probe of a detached service; requires `Authorization: Bearer <background.json token>` |
| POST | `/api/background/stop` | Ask a detached service to shut down; same bearer token |
| GET | `/api/session/:id` | One saved transcript |
| POST | `/api/session/:id/continue` | Resume a transcript with optional `{ selection }`, returns `{ key }` |
| POST | `/api/session/:id/delete` | Delete a saved, non-running transcript |
| GET | `/api/agents/:agent/sessions?cwd=…` | Read-only sessions from Claude Code / Codex / OpenCode |
| GET | `/api/agents/:agent/sessions/:id` | Read-only messages of one other-agent session |
| POST | `/api/agents/:agent/sessions/:id/migrate` | Copy a source in `cwd` into a saved native conversation and return its live key; accepts optional `selection` or Pro `pro_preset` |
| GET | `/api/live/:key` | Snapshot of a live session |
| GET | `/api/live/:key/stream` | SSE stream of a live session |
| POST | `/api/live/:key/pause` | Pause the running turn |
| POST | `/api/live/:key/resume` | Resume a paused conversation |
| POST | `/api/live/:key/message` | Send `{ "text": "…" }` |
| POST | `/api/live/:key/model` | Apply `{ provider, model, intensity }` while idle or paused |
| POST | `/api/live/:key/clear` | Empty the conversation in place; keeps the old transcript |
| POST | `/api/live/:key/approve` | Answer `{ "approved": true|false }` |
| POST | `/api/live/:key/approval-mode` | Set `{ "mode": "request"|"auto" }` |
| POST | `/api/live/:key/close` | Dispose a browser-owned session |
| GET | `/api/health` | Liveness probe |
| POST | `/api/auth/login` | Sign in with `{ "password": "…" }` |
| POST | `/api/auth/logout` | Clear the login cookie |

Conversation and settings routes require the login cookie; see
[Authentication](#authentication). `OPTIONS` is answered unauthenticated so
preflights are not blocked, and it returns no data. The `/api/background/*`
management routes are the exception: they exist only in a detached service and
authenticate with the bearer token from `background.json`, because the CLI and
the tray icon have no browser cookie.

### Approval requests

When a running agent wants to do something risky (a delete-class command, an
install, a path outside the working directory) the browser shows an orange
**Request Approval** banner above the composer, showing the full command (or
formatted tool arguments), working directory and risk reasons, plus two buttons.
The banner only appears when a human decision is actually waiting. Long proposals
remain complete and scroll inside the card.
Automatic reviews are reported in the conversation's status badge instead
(`reviewing round 2/3`), so auto approval never looks like a request for approval.
`Approve` runs the call, `Deny` returns a note to the agent.
The reviewer uses the current turn's captured user request and earlier user
messages; queued input belongs to the next turn. Expand a denied tool result
to inspect the user requests that were reviewed.

Use the **Request Approval / Auto Approval** switch in each conversation's
controls to choose human approval or independent AI review. The choice is saved
with the conversation and synced with the terminal. `自动审批` / `自动批准` in
prompt text no longer changes this mode. Delete-class automatic review still
requires **Settings → Extreme-risk auto-approval**. Each pending call receives two
independent safety assessments. A round passes at an average safety score of
60/100; task relevance has no weight or ordinary minimum. Only an extreme,
obvious task mismatch independently confirmed with evidence by both reviewers
(relevance at most 5/100 each) can veto on intent. Concrete serious hazards,
explicit user prohibitions and failed reviews still prevent execution.

It is the same gate the terminal uses: the prompt opt-outs `无需审批` and
`我已知悉风险，同意给予完整权限，无需任何审批` still work, and
`POST /api/live/:key/approve` with `{"approved": true|false}` answers the request
programmatically (409 when nothing is pending).

`POST /api/live/:key/approval-mode` with `{"mode":"request"|"auto"}` changes
the conversation mode and returns its current snapshot (400 for invalid modes).
