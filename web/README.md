# Neutrino Web UI

A small, dependency-free single page app that is served by the Neutrino CLI on
a port you choose. It lets you:

- browse every saved conversation grouped by working directory (like Codex),
  with only the five latest transcripts per path shown and the rest collapsed;
- watch a running terminal conversation stream in real time;
- switch the provider, model and intensity for the next turn;
- edit defaults, context compression and approval settings in a Settings dialog;
- drive the running conversation: pause / resume the current turn and send new
  messages (they queue while the agent is busy);
- pick up a saved conversation in the browser and keep chatting, even when no
  terminal is running.

Nothing needs to be built — these are plain `.html`, `.css` and `.js` files.

## Running it

While using the terminal UI, mount the website on a port:

```sh
neutrino --web-port 8765
```

Or serve only the saved history, without a terminal:

```sh
neutrino web --port 8765
# or
npm run web
```

Then open <http://127.0.0.1:8765>.

## Using it from another device

The server binds to loopback by default. To open it from your phone or another
machine, bind an interface others can reach:

```sh
neutrino web --port 8765 --lan               # every interface (0.0.0.0)
neutrino web --port 8765 --host 100.64.0.7   # one specific address
```

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

## Models and settings

Open a conversation to see the **Provider**, **Model** and **Thinking intensity**
selectors. Choose a configured model and press **Apply to conversation**. The
next turn uses that selection, and it is saved with the transcript. The same
controls also update a conversation running in the terminal. Pause an active
turn before applying a change; a running turn returns a clear conflict message.

For saved history, **Continue with model** resumes the transcript with the chosen
selection. Changing the selectors and then using **Continue here** or sending a
message also uses the draft selection, so a transcript whose old model was
removed can still be continued.

The **⚙ Settings** button in the sidebar opens defaults for new conversations,
the context compression threshold, the approval reviewer model, and the
extreme-risk automatic approval option. Save settings explicitly; cancelling
leaves the saved values intact. Conversation model changes are separate from
these defaults. Models come from the same catalog as the terminal, and API keys
stay on the server. Configure missing keys in the terminal model screen first.
Intensity uses the same Low–Ultra sampling settings as the terminal.

## History vs. live sessions

A saved transcript on disk is a finished record: nothing is running, so the
page shows it read-only (dashed `read-only` badge) and there is nothing to
pause.

To continue one, either

- press **✎ Continue here** in the header, or
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
| GET | `/api/settings` | Model catalog and public settings; no credentials |
| POST | `/api/settings` | Save validated `{ selection?, settings? }` defaults |
| GET | `/api/session/:id` | One saved transcript |
| POST | `/api/session/:id/continue` | Resume a transcript with optional `{ selection }`, returns `{ key }` |
| GET | `/api/live/:key` | Snapshot of a live session |
| GET | `/api/live/:key/stream` | SSE stream of a live session |
| POST | `/api/live/:key/pause` | Pause the running turn |
| POST | `/api/live/:key/resume` | Resume a paused conversation |
| POST | `/api/live/:key/message` | Send `{ "text": "…" }` |
| POST | `/api/live/:key/model` | Apply `{ provider, model, intensity }` while idle or paused |
| POST | `/api/live/:key/close` | Dispose a browser-owned session |
| GET | `/api/health` | Liveness probe |
| POST | `/api/auth/login` | Sign in with `{ "password": "…" }` |
| POST | `/api/auth/logout` | Clear the login cookie |
| GET / POST | `/api/settings` | Read settings or update them, including `settings.web_password` |

Conversation and settings routes require the login cookie; see
[Authentication](#authentication). `OPTIONS` is answered unauthenticated so
preflights are not blocked, and it returns no data.

### Approval requests

When a running agent wants to do something risky (a delete-class command, an
install, a path outside the working directory) the browser shows an orange
**Request Approval** banner above the composer, showing the full command (or
formatted tool arguments), working directory and risk reasons, plus two buttons.
Long proposals remain complete and scroll inside the card. Automatic reviews
show the same proposal details while they run.
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
