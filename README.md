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

## Status — Phase 1 (Core Platform) ✅

Working now:
- Chat UI with streaming markdown, thinking display, and collapsible tool cards
- All four providers configurable in Settings; live model catalogs per provider
- Pi Agent embedded in-process: `createAgentSession` → `subscribe()` events → WebSocket → browser
- Built-in tools: `read`, `bash`, `edit`, `write`, `grep`
- Session creation; events (text/thinking/tool calls/status/errors) streamed live
- Bash destructive-command guardrails; error events surfaced to the client

Planned (see `docs/superpowers/specs/2026-07-09-pi-cowork-design.md`):
- **Phase 2** — knowledge-worker layer: clarifying-question cards, task-list widget, document creation (.docx/.xlsx/.pptx/.pdf), `present_files`, file-based memory, plugin/skill/command/MCP-connector loader, Chrome control (Playwright)
- **Phase 3** — artifacts (live HTML), scheduled tasks, projects

## Quick start

```bash
# from the repo root
npm install

# run both servers (web on :5173, api on :5174) with hot reload
npm run dev
```

Open http://localhost:5173, go to **Settings**, paste a provider key (e.g. `ZAI_API_KEY`), then chat.

You can also seed keys from the environment before starting:

```bash
ZAI_API_KEY=sk-... npm run dev
```

## Architecture

```
Browser (React + Vite + TS)  ──WS──▶  Server (Fastify + ws)
  chat UI / settings / tools            │
                                        ▼
                                   pi-engine  (wraps createAgentSession)
                                        │
                                        ▼
                                   Pi Agent  (pi-coding-agent + pi-ai)
                                   providers: openrouter / zai / minimax / opencode
                                   tools: read / bash / edit / write / grep
```

- One `AgentSession` per user session, held server-side.
- The browser never touches the LLM directly; all inference flows through the backend.
- Pi's `subscribe()` event stream is mapped to a small wire schema and forwarded to the browser over a WebSocket.

## Project layout

```
Pi-Cowork/
  server/          Node + Fastify + ws; embeds Pi Agent
    src/
      pi/            engine.ts (event mapping), providers.ts, sessions.ts
      routes/        providers, sessions, messages
      safety.ts      bash guardrails
      ws.ts          WebSocket bridge
  web/             Vite + React + TS frontend
    src/
      views/         ChatView, SettingsView
      components/    MessageList, ToolCard, Composer, ProviderSettings
      lib/           api.ts, ws.ts, events.ts
  e2e/             Playwright smoke tests
  docs/superpowers/  design spec + implementation plan
```

## API surface (server)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/providers` | List the 4 providers + key status |
| PUT | `/api/providers/:id/key` | Set a provider key |
| DELETE | `/api/providers/:id/key` | Clear a provider key |
| GET | `/api/providers/:id/models` | Model catalog for a provider |
| POST | `/api/sessions` | Create a session |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions/:id/messages` | Send a prompt |
| WS | `/ws` | Subscribe `{type:"subscribe",sessionId}` → receive streamed events |

## Testing

```bash
npm test      # server unit tests (vitest) — 13 tests
npm run e2e   # playwright e2e — 5 tests
npm -w web run build   # type-check + build the frontend
```

## License

MIT.
