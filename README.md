# Pi-Cowork

An open-source, web-first clone of [Claude Cowork](https://www.anthropic.com/product/claude-cowork) that uses **[Pi Agent](https://github.com/earendil-works/pi-mono)** (`@earendil-works/pi-coding-agent` + `pi-ai`) as its agentic engine, instead of the Claude Code engine.

Pi-Cowork gives knowledge workers a chat UI where an AI agent plans tasks, calls tools, and produces real deliverables — routed through whichever LLM provider you configure.

## Supported providers (built into Pi Agent)

| Provider | Id | Env var |
|---|---|---|
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Z.ai Coding Plan | `zai` | `ZAI_API_KEY` |
| Minimax Token Plan | `minimax` | `MINIMAX_API_KEY` |
| Opencode Zen | `opencode` | `OPENCODE_API_KEY` |

Keys are managed in the in-app **Settings** view or via environment variables, and stored in Pi Agent's `AuthStorage` (`~/.pi/agent/auth.json`). They never leave the server.

> **Works out of the box, no key required:** Pi-Cowork ships with a keyless **OpenCode Zen** free provider (DeepSeek V4 Flash et al.) as the default model, so chat streams real responses immediately. Add any of the four keyed providers above for stronger models.

## Features (feature-parity with Cowork)

**Agentic core**
- Chat UI with streaming markdown, thinking display, and collapsible tool cards
- Pi Agent embedded in-process: `createAgentSession` → `subscribe()` events → WebSocket → browser
- All four providers configurable; live model catalogs per provider
- Session lifecycle (create / list / abort) with streaming over WebSocket
- **Sandboxed execution layer** (bubblewrap): bash commands run inside a per-session `bwrap` container — read-only host toolchain (/usr, /bin, /lib), private tmpfs `/tmp`, the workspace bind-mounted as the only writable path, user/PID/IPC namespaces unshared (`--unshare-all`), optional network egress. Falls back to plain exec when bwrap is absent. Mirrors Cowork's sandboxed-VM model.
- **Cowork-style safety guardrails** enforced via a `tool_call` hook: a **prohibited-action list** (banking/ID data, system-file/permission mods, trades, destructive commands, secret exfiltration — always blocked) and an **explicit-permission list** (downloads, purchases, OAuth, publishing, sending messages, mass-deletes — surfaced as Approve/Deny cards the user must confirm); prompt errors surfaced to the client

**58 agent tools** (registered per session):
- *Workflow:* `ask_question` (clarifying cards, pauses agent), `todo_write` (task-list widget)
- *Documents:* `create_docx` / `create_xlsx` / `create_pptx` / `create_pdf` / `create_file` + `present_files` (downloadable deliverables)
- *Memory:* `memory_write` / `memory_read` / `memory_search` (persistent, typed: user/feedback/project/reference)
- - *Browser control (19):* navigate, click, type, scrape, screenshot, close, tabs (list/new/switch/close), JS execution, form-fill, wait-for-selector, network inspection, console capture, request interception/blocking, cookie management, PDF export, geolocation override (Playwright)
- - *Computer-use (21):* screenshot, mouse move/click/drag, scroll + scroll-direction, type, key + key-combo chords, modifier+click, clipboard read/write, wait, multi-region capture, window list/focus, OCR text extraction, color pick, file open, system notification, display-resolution query (nut-js)
- *Artifacts:* `create_artifact` (live HTML in sandboxed iframe)
- *Sub-agents:* `dispatch_subagents` (runs independent tasks concurrently in separate in-memory sessions)
- *MCP connectors:* connected MCP-server tools auto-register (dynamic)
- *Built-ins:* `read`, `bash`, `edit`, `write`, `grep`

**Extensibility & automation**
- **MCP connectors** — connect to any MCP server (stdio / HTTP / SSE); its tools become agent tools. Managed via REST.
- **Slash commands** — `/help`, `/todo`, `/doc`, `/research`, `/memory`, `/clear`, `/stop` (extensible registry)
- **Skills** — markdown skill files (with frontmatter), managed via REST, loaded by Pi Agent from `.agents/skills/`. 3 starter skills seeded.
- **Scheduled tasks** — cron expressions or one-shot `fireAt`; run autonomously on a tick
- **Projects** — named, persistent workspaces (outputs / memory / skills / custom instructions scoped per project)

## Quick start

```bash
# from the repo root
npm install

# run both servers (web on :5173, api on :5174) with hot reload
npm run dev
```

Open http://localhost:5173, go to **Settings**, paste a provider key (e.g. `ZAI_API_KEY`), then chat.

You can also seed keys from the environment:

```bash
ZAI_API_KEY=sk-... npm run dev
```

## Architecture

```
Browser (React + Vite + TS)  ──WS──▶  Server (Fastify + ws)
  chat / tasks / questions             │
  deliverables / artifacts             ▼
                                  pi-engine  (wraps createAgentSession)
                                       │
                                       ▼
                                  Pi Agent  (pi-coding-agent + pi-ai)
                                  providers: openrouter / zai / minimax / opencode
                                  31 tools incl. MCP connector tools (dynamic)
```

- One `AgentSession` per user session, held server-side.
- The browser never touches the LLM directly; all inference flows through the backend.
- Pi's `subscribe()` event stream is mapped to a small wire schema and forwarded to the browser over a WebSocket.

## API surface (server)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/providers` | List the 4 providers + key status |
| PUT/DELETE | `/api/providers/:id/key` | Set / clear a provider key |
| GET | `/api/providers/:id/models` | Model catalog for a provider |
| POST | `/api/sessions` | Create a session (optional `projectId`) |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions/:id/messages` | Send a prompt (handles `/` commands too) |
| POST | `/api/sessions/:id/answers` | Answer a pending `ask_question` |
| GET | `/api/commands` | List slash commands |
| POST | `/api/sessions/:id/commands` | Execute a slash command |
| GET | `/api/files/*` | Download a workspace file |
| GET | `/api/skills` | List skills |
| POST | `/api/skills/:file/{enable,disable}` | Enable / disable a skill in the project |
| PUT/DELETE | `/api/skills/:file` | Install / uninstall a global skill |
| GET/POST | `/api/connectors` | List / add MCP connectors |
| POST | `/api/connectors/:id/{connect,disconnect}` | Connect / disconnect a connector |
| DELETE | `/api/connectors/:id` | Remove a connector |
| GET | `/api/artifacts[/:id]` | List / serve HTML artifacts |
| GET/POST | `/api/tasks` | List / create scheduled tasks |
| PATCH/DELETE | `/api/tasks/:id` | Pause / resume / delete a task |
| GET/POST | `/api/projects` | List / create projects |
| GET/PATCH/DELETE | `/api/projects/:id` | Get / rename / delete a project |
| WS | `/ws` | Subscribe `{type:"subscribe",sessionId}` → receive streamed events |

## Testing

```bash
npm test      # server unit tests (vitest) — 112 tests across 15 files
npm run e2e   # playwright e2e — 21 tests (incl. a live LLM streaming test)
npm -w web run build   # type-check + build the frontend
```

Test coverage spans: provider key management, model catalogs, event mapping, the clarifying-question pause/resume round-trip, all document generators (docx/xlsx/pptx/pdf with magic-byte + traversal checks), memory CRUD + persistence, skills management, artifacts, scheduled tasks (including a real one-shot firing), projects, slash-command dispatch, MCP connector tool-adaptation, sub-agent validation, live Chrome automation against example.com, computer-use tool structure, and — crucially — **a live end-to-end test (`live-chat.spec.ts`) asserting real assistant `text_delta` tokens stream from an LLM through the WebSocket**.

## Project layout

```
Pi-Cowork/
  server/          Node + Fastify + ws; embeds Pi Agent
    src/
      pi/            engine, providers, sessions, projects, scheduler, skills,
                      artifacts, mcp-connectors, commands, + cowork/doc/memory/
                      chrome/computer-use/subagent tools
      routes/        providers, sessions, messages, files, skills, artifacts,
                      scheduler, projects, connectors, commands
      safety.ts      bash guardrails
      ws.ts          WebSocket bridge
  web/             Vite + React + TS frontend
    src/
      views/         ChatView, SettingsView
      components/    MessageList, ToolCard, Composer, TaskList, QuestionCard,
                      FileChips, ArtifactPanel, ProviderSettings
      lib/           api.ts, ws.ts, events.ts
  e2e/             Playwright tests
  docs/superpowers/  design spec + Phase 1 implementation plan
```

## Status

Phases 1–4 are implemented and tested, achieving feature parity with Claude Cowork's full headline capability set: agentic loop + streaming, four providers, clarifying questions, task list, document creation, deliverables, memory, browser control (Chrome), computer-use (desktop automation), artifacts, sub-agents, MCP connectors, slash commands, skills, scheduled tasks, and projects. Deliberately not built: a native desktop shell (Electron/Tauri wrapper) and bulk replication of Cowork's ~132 prebuilt skills / ~131 MCP connectors (the loader infrastructure is in place; bulk content is incremental and additive).

## License

MIT.
