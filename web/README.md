# Neutrino Web UI

A small, dependency-free single page app that is served by the Neutrino CLI on
a port you choose. It lets you:

- browse every saved conversation grouped by working directory (like Codex),
  with only the five latest transcripts per path shown and the rest collapsed;
- watch a running terminal conversation stream in real time;
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

Startup prints each address that works, token included:

```
Neutrino web UI listening on 0.0.0.0:8765
Open the address that matches your device:
  http://192.168.1.211:8765/?t=b2yzzvZyypcbmoDFdpT470qowAOE9Ca4
  http://127.0.0.1:8765/?t=b2yzzvZyypcbmoDFdpT470qowAOE9Ca4
```

Hypervisor and container host-only adapters (`vEthernet`, VMware, VirtualBox,
Docker), link-local `169.254/16` and loopback addresses other than `127.0.0.1`
are left out of that list on purpose: they cannot be reached from another
device. CGNAT ranges such as Tailscale's `100.64/10` are kept, since a VPN is a
common way to reach a machine.

## Authentication

`/api/*` can read every saved conversation and drive an agent with shell access,
so a server that other machines can reach requires a token on every request.
Nothing needs configuring: binding beyond loopback generates a random one and
prints it inside the advertised URLs. Pin it to keep your links stable across
restarts:

```sh
export NEUTRINO_WEB_TOKEN="$(openssl rand -base64 24)"
neutrino web --port 8765 --lan        # or --token "$secret"
```

A client proves it holds the token in any of these ways:

| Where | Value |
| --- | --- |
| `X-Neutrino-Token` header | the token |
| `Authorization` header | `Bearer <token>` |
| Query string | `?t=<token>` or `?token=<token>` |

The query form exists because `EventSource` — used for the SSE stream — cannot
set headers. Prefer a header everywhere else so the secret stays out of access
logs.

The browser reads the token from the URL once, saves it in `localStorage`, and
strips it from the address bar. If a page is opened without one it shows an
unlock prompt instead of a blank screen. A wrong or missing token answers
`401` with a `WWW-Authenticate: Bearer` header.

Static files (`/`, `/app.js`, `/style.css`) stay public — the token prompt has to
load before any token exists. They contain no conversation data.

`--no-auth` turns the check off completely. Only do that on a network where
every device is yours, because the API is a remote shell as your user.

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
| GET | `/api/session/:id` | One saved transcript |
| POST | `/api/session/:id/continue` | Resume a transcript in the browser, returns `{ key }` |
| GET | `/api/live/:key` | Snapshot of a live session |
| GET | `/api/live/:key/stream` | SSE stream of a live session |
| POST | `/api/live/:key/pause` | Pause the running turn |
| POST | `/api/live/:key/resume` | Resume a paused conversation |
| POST | `/api/live/:key/message` | Send `{ "text": "…" }` |
| POST | `/api/live/:key/close` | Dispose a browser-owned session |
| GET | `/api/health` | Liveness probe |

Every `/api/*` route needs the access token when one is configured; see
[Authentication](#authentication). `OPTIONS` is answered unauthenticated so
preflights are not blocked, and it returns no data.

### Approval requests

When a running agent wants to do something risky (a delete-class command, an
install, a path outside the working directory) the browser shows an orange
**Request Approval** banner above the composer, with the tool and two buttons.
`Approve` runs the call, `Deny` returns a note to the agent.

It is the same gate the terminal uses: the prompt phrases `无需审批`,
`我已知悉风险，同意给予完整权限，无需任何审批` and `自动审批` work identically, and
`POST /api/live/:key/approve` with `{"approved": true|false}` answers the request
programmatically (409 when nothing is pending).
