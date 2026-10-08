# XINGJI Neutrino

A CLI coding agent that lives in your terminal. Neutrino gives you an interactive chat interface backed by LLMs, with built-in tool use (running commands, reading and writing files) so it can help you work on real projects.

## Features

- **Interactive terminal UI** — logo screen, chat, model select, history, and settings screens.
- **Full mouse support** — hover to highlight, click to select/open/position the cursor, wheel to scroll, right-click to go back (like OpenCode).
- **LLM providers** — ships with DeepSeek, OpenAI, and Anthropic presets; works with any OpenAI-compatible endpoint.
- **Tool calling** — the agent can run shell commands, read files, write files, and list directories in your working directory.
- **Streaming responses** — token-by-token output with pause/resume (`ESC ESC`).
- **Intensity control** — tune `temperature`/`top_p` from `Low` to `Ultra`.
- **Session history** — conversations are saved automatically and can be resumed or deleted.
- **Token usage stats** — click the `ⓘ` in the chat header to see prompt/completion/total token counts for the current session.
- **Agent history browser** — view past sessions from other CLI agents (Claude Code, Codex, OpenCode) directly from the history screen.

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
| `Enter` | Send message / confirm |
| `←`/`→`, `↑`/`↓` | Move focus / navigate |
| `Ctrl+E` | Open model config |
| `Ctrl+B` | Back to menu (from chat) |
| `Ctrl+L` | Clear conversation (from chat) |
| `Esc Esc` | Pause / resume streaming |
| `PgUp` / `PgDn` | Scroll chat history |
| `Ctrl+C` / `Ctrl+Q` | Quit |

### Mouse

| Action | Effect |
| --- | --- |
| Hover over an item | Highlight / select it in lists and menus |
| Click an item | Select and confirm (open a screen, load a session, apply a setting…) |
| Click the input box | Focus it and place the cursor at the clicked position |
| Click the header (left of `ⓘ`) | Open the model selector |
| Click `ⓘ` (chat header) | Toggle token usage stats |
| Scroll wheel | Scroll the chat/log, or move through lists |
| Right-click | Go back (like `Esc`) |

## Configuration

Settings are stored under `~/.neutrino/`:

- `model.json` — provider and model definitions (edit to add your own endpoints).
- `config.json` — app configuration (selected provider/model/intensity, theme, language).
- `session/` — saved conversation sessions, one JSON file per session.

Set your API key in the model select screen or directly in `model.json`.

### Browsing other agents' history

From the history screen, select **Open other Agent's history** to view past sessions recorded by other CLI agents installed on your machine:

- **Claude Code** — reads `~/.claude/projects/**/*.jsonl`.
- **Codex** — reads `~/.codex/sessions` and `~/.codex/archived_sessions`.
- **OpenCode** — reads the local SQLite database (`opencode.db`) via `node:sqlite` (requires Node.js **22.13+**; silently unavailable on older versions).

These sessions are read-only; you can open them for review but not edit or delete.

## Built-in tools

The agent can call the following tools during a conversation:

- `run_command` — execute a shell command (120s timeout, output capped).
- `read_file` — read a text file (capped at 200KB).
- `write_file` — write content to a file.
- `list_files` — list directory contents.

## Development

```sh
npm run build    # compile TypeScript to dist/
node scripts/test-mouse.mjs    # verify mouse escape-sequence parsing
node scripts/test-cursor.mjs   # verify click-to-position-cursor math
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
