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

## Features (feature-parity with Cowork's headline capabilities)

**Agentic core**
- Chat UI with streaming markdown, thinking display, and collapsible tool cards
- Pi Agent embedded in-process: `createAgentSession` → `subscribe()` events → WebSocket → browser
- All four providers configurable; live model catalogs per provider
- Session lifecycle (create / list / abort) with streaming over WebSocket
- Bash destructive-command guardrails; prompt errors surfaced to the client

**Knowledge-worker tools (23 total)**
- `ask_question` — clarifying-question cards that pause the agent until answered
- `todo_write` — task-list widget with live status (pending / in_progress / completed)
- `create_docx` / `create_xlsx` / `create_pptx` / `create_pdf` / `create_file` — document creation
- `present_files` — deliverable file chips (downloadable)
- `memory_write` / `memory_read` / `memory_search` — file-based memory (user / feedback / project / reference), persistent across sessions
- `browser_navigate` / `_click` / `_type` / `_scrape` / `_screenshot` / `_close` — Chrome control via Playwright
- `create_artifact` — live HTML panels rendered in a sandboxed iframe
- Built-ins: `read`, `bash`, `edit`, `write`, `grep`

**Extensibility & automation**
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
                                  23 tools: built-ins + cowork + doc + memory + chrome + artifact
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
| POST | `/api/sessions/:id/messages` | Send a prompt |
| POST | `/api/sessions/:id/answers` | Answer a pending `ask_question` |
| GET | `/api/files/*` | Download a workspace file |
| GET | `/api/skills` | List skills |
| POST | `/api/skills/:file/{enable,disable}` | Enable / disable a skill in the project |
| PUT/DELETE | `/api/skills/:file` | Install / uninstall a global skill |
| GET | `/api/artifacts[/:id]` | List / serve HTML artifacts |
| GET/POST | `/api/tasks` | List / create scheduled tasks |
| PATCH/DELETE | `/api/tasks/:id` | Pause / resume / delete a task |
| GET/POST | `/api/projects` | List / create projects |
| GET/PATCH/DELETE | `/api/projects/:id` | Get / rename / delete a project |
| WS | `/ws` | Subscribe `{type:"subscribe",sessionId}` → receive streamed events |

## Testing

```bash
npm test      # server unit tests (vitest) — 69 tests across 10 files
npm run e2e   # playwright e2e — 9 tests
npm -w web run build   # type-check + build the frontend
```

Test coverage spans: provider key management, model catalogs, event mapping, the clarifying-question pause/resume round-trip, all document generators (docx/xlsx/pptx/pdf with magic-byte + traversal checks), memory CRUD + persistence, skills management, artifacts, scheduled tasks (including a real one-shot firing), projects, and live Chrome automation against example.com.

## Project layout

```
Pi-Cowork/
  server/          Node + Fastify + ws; embeds Pi Agent
    src/
      pi/            engine (event mapping), providers, sessions, projects,
                      scheduler, skills, artifacts, + cowork/doc/memory/chrome tools
      routes/        providers, sessions, messages, files, skills, artifacts,
                      scheduler, projects
      safety.ts      bash guardrails
      ws.ts          WebSocket bridge
  web/             Vite + React + TS frontend
    src/
      views/         ChatView, SettingsView
      components/    MessageList, ToolCard, Composer, TaskList, QuestionCard,
                      FileChips, ArtifactPanel, ProviderSettings
      lib/           api.ts, ws.ts, events.ts
  e2e/             Playwright smoke tests
  docs/superpowers/  design spec + Phase 1 implementation plan
```

## Status

Phases 1–3 (platform, knowledge-worker, advanced) are implemented and tested, achieving feature parity with Claude Cowork's headline capabilities. Not implemented (deliberately scoped out, see the design spec): native computer-use desktop automation, desktop packaging (Electron/Tauri wrapper), and bulk replication of Cowork's 132 prebuilt skills / 131 MCP connectors (the loader + a starter set are in place; bulk content is incremental).

## License

MIT.
