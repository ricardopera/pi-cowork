# Pi-Cowork — Design Spec

**Date:** 2026-07-09
**Status:** Draft (pending user review)
**One-liner:** An open-source, web-first clone of Anthropic's **Claude Cowork** that uses **Pi Agent** (`@earendil-works/pi-coding-agent` + `pi-ai`) as its agentic engine and routes through four LLM providers (Z.ai coding plan, OpenRouter, Minimax Token Plan, Opencode Zen).

---

## 1. Background & goal

### What Claude Cowork is
Claude Cowork is Anthropic's desktop agentic AI workspace for **non-developer knowledge workers** (marketing, sales, HR, finance, legal, ops). It is the Claude Code agentic engine repackaged as a GUI: a chat where the model plans tasks, calls tools, and produces real deliverables (documents, analysis, automations). Headline features: sandboxed Linux VM, ~27 computer-use tools, ~19 Chrome-control tools, 132 prebuilt skills, 131 MCP connectors, plugins (skills + connectors + commands + sub-agents), scheduled tasks, projects, artifacts (live HTML), file-based memory, and heavy safety guardrails.

### What Pi Agent is
`@earendil-works/pi-coding-agent` (MIT, v0.80.x) + `@earendil-works/pi-ai` is an agentic coding toolkit exposing:
- `createAgentSession({ cwd, model, authStorage, modelRegistry, tools, customTools })` → `{ session }`
- `session.prompt()`, `session.subscribe(listener)`, `session.setModel()`, `session.dispose()`
- Event stream: `message_update` (streaming tokens + thinking), `tool_execution_start/update/end`, `turn_end`, `agent_end`, `compaction_*`, `auto_retry_*`
- Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
- `defineTool()` for custom tools; extension/hooks system via `pi.on(event, handler)`
- `SessionManager` (new/open/inMemory/list/fork), `AgentSessionRuntime` (new/resume/fork)
- `AuthStorage` for provider keys; `ModelRegistry` for available models
- **35 built-in providers**, including the four we care about: `openrouter` (`OPENROUTER_API_KEY`), `zai` (`ZAI_API_KEY`), `minimax` (`MINIMAX_API_KEY`), `opencode` (`OPENCODE_API_KEY`)

### The goal
Build Pi-Cowork to feature parity with Cowork across three phases. Because Pi Agent already provides the agentic loop, tools, sessions, and provider routing, Pi-Cowork is primarily a **GUI + productization + safety layer** over Pi Agent — we add value through custom tools, rendering, plugins, and guardrails, not by reimplementing the engine.

### Parity, defined on two axes
- **Platform parity** (engine + UX + tools + extensibility): the tractable core built in code.
- **Content parity** (Cowork's ~132 skills + ~131 connectors): we build the *loader* and seed a useful starter set; bulk parity is incremental and out of scope for the initial milestone. The capability to load arbitrary skills/connectors is in scope.

---

## 2. Scope & decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Deployment target | **Web-first**, desktop wrapper (Electron/Tauri) as a later phase | Fastest iteration; works everywhere; Cowork's chat/task-list/artifacts UX maps to browser |
| Frontend | Vite + React + TypeScript | Standard, fast, large ecosystem |
| Backend | Node.js (Bun-compatible), TypeScript, Fastify + ws | In-process Pi embedding; lightweight HTTP/WS |
| Engine | `@earendil-works/pi-coding-agent` + `pi-ai` (embedded in-process) | Native agentic loop + all 4 providers built-in |
| Providers | Z.ai (`zai`), OpenRouter (`openrouter`), Minimax (`minimax`), Opencode Zen (`opencode`) | Per user; all configurable in settings |
| Automation | **Chrome control** via Playwright (Phase 2.5); computer-use deferred | Useful for research/scraping; feasible cross-platform |
| Styling | Modern minimal, clean light/dark | Polished but generic; revisit later |
| Workspace model | **Both**: server-managed default dirs + user-chosen folder option | Flexibility now, native FS later in desktop app |
| Scope sequencing | Phased: platform → knowledge-worker → advanced | Each phase is independently shippable |

### Explicitly out of scope (for now)
- Desktop native shell (Electron/Tauri) — later phase
- Computer-use / native GUI automation — deferred
- Hand-writing all 132 skills / 131 connectors — we build the loader + a starter set
- Mobile UI
- Multi-tenant auth / cloud hosting (single-user, localhost-first initially)

---

## 3. Architecture

Standard three-tier web architecture. Pi engine embedded in-process in the backend; browser communicates over WebSocket for streaming events and HTTP/WS for commands.

```
┌────────────────────────────────────────────────────────────────┐
│  Browser (React + Vite + TS)                                   │
│  Chat UI · streaming markdown · tool cards · task-list widget  │
│  clarifying-question cards · sessions sidebar · settings       │
│  artifacts panel (sandboxed iframe) · scheduler · projects     │
└───────────────▲──────────────────────────────────┬─────────────┘
                │ WebSocket: events ↓               │ commands ↑
┌───────────────┴──────────────────────────────────▼─────────────┐
│  Backend (Node/Bun + Fastify + ws)                             │
│  HTTP/WS server ── Session manager (1 AgentSession / session)  │
│                   │                                            │
│   ┌───────────────▼──────────────────────────────────────┐     │
│   │ pi-engine  (wraps createAgentSession; maps events)    │     │
│   │   ↳ tools: read/bash/edit/write/grep/find/ls          │     │
│   │   ↳ custom tools: todo_*, ask_question, present_files,│     │
│   │     memory_*, docx/xlsx/pptx/pdf, chrome_*, artifact  │     │
│   │   ↳ hooks: bash gate, injection defense, safety list  │     │
│   │   ↳ providers: openrouter/zai/minimax/opencode (+31)  │     │
│   └───────────────────────────────────────────────────────┘     │
│  plugins loader (skills + slash cmds + MCP connectors)          │
│  workspaces (per-session scratch + persistent workspace)        │
│  scheduler (node-cron) · artifacts server · memory store        │
└────────────────────────────────────────────────────────────────┘
```

### Key invariants
1. **One `AgentSession` per user session**, held server-side; one WebSocket bridges Pi's `subscribe()` events to the browser.
2. **The browser never touches the LLM.** All inference flows through the backend Pi session, keeping API keys server-side and centralizing safety hooks.
3. **Pi's extension/hooks system is the integration point.** Cowork features are added as custom tools + tool hooks, not engine forks.
4. **Path sandboxing.** File/bash tools operate within a per-session workspace directory (cwd); the persistent workspace folder is the only thing that survives a session reset.

---

## 4. Components

Each component has one purpose, a clear interface, and minimal dependencies so it can be built and tested independently.

| Component | Responsibility | Key interface | Deps |
|---|---|---|---|
| `web/` | React UI: chat, events, sessions, settings, artifacts, scheduler, projects | Subscribes to WS events; sends commands | ws client |
| `server/` | Fastify HTTP/WS endpoints; owns sessions; bridges browser↔Pi | `POST /sessions`, `WS /sessions/:id`, `POST /sessions/:id/messages`, `GET /sessions` | pi-engine |
| `pi-engine/` | Wraps `createAgentSession`; maps Pi events → our event schema; registers custom tools + hooks; provider/model resolution | `createPiSession(opts)`, `.prompt()`, `.steer()`, `.subscribe()`, `.dispose()`, `.setModel()` | pi-coding-agent, pi-ai |
| `providers/` | Provider config UI + key management via `AuthStorage`; model listing via `ModelRegistry` | `listProviders()`, `setApiKey()`, `listModels()`, `resolveModel()` | pi-ai, AuthStorage |
| `plugins/` | Loads skills (markdown), slash commands, MCP connectors; maps them to Pi custom tools + extensions | `loadPlugins(dir)`, `getToolDefs()`, `getCommands()` | pi-engine, mcp-sdk |
| `tools/` | Cowork-specific custom tools via `defineTool`: `todo_*`, `ask_question`, `present_files`, `memory_*`, `docx/xlsx/pptx/pdf`, `chrome_*`, `create_artifact` | Each: `defineTool({...})` | pi-engine, doc libs |
| `workspaces/` | Per-session ephemeral scratch dir + persistent workspace folder + path translation | `createWorkspace()`, `resolvePath()`, `mountUserFolder()` | fs |
| `scheduler/` | Cron + one-shot scheduled tasks; runs an in-process Pi session on each tick | `createTask()`, `listTasks()`, `updateTask()`, `deleteTask()` | pi-engine, node-cron |
| `artifacts/` | Persists + serves self-contained HTML artifacts; sandboxed iframe + restricted `window.cowork`-style API | `saveArtifact()`, `getArtifact()`, `listArtifacts()` | fs, server |
| `memory/` | File-based memory store: `memory/MEMORY.md` index + typed entries (user/feedback/project/reference) with YAML frontmatter + `[[links]]` | `read()`, `write()`, `query()`, `append()` | fs |
| `safety/` | Centralized guardrails: bash allow/deny, prohibited-action list, explicit-permission gating, injection-defense heuristics | `checkBash()`, `isProhibited()`, `needsConfirmation()`, `scanInjection()` | — |

### Why these boundaries
Every component is independently testable (`pi-engine` without server, `tools/` without UI, `scheduler` with a faux provider). Each maps to a single Pi Agent capability, so we extend rather than fight the engine. The `safety/` module is standalone so rules can be unit-tested and audited without running the agent.

---

## 5. Data flow — a typical request

1. User types *"Make a one-page sales deck for our Q3 launch"*.
2. Browser sends `POST /sessions/:id/messages { text }`.
3. Server calls `piSession.prompt(text)`. Pi's loop begins:
   - **Clarify:** model calls `ask_question` → server emits `clarify` event → browser renders question card → user picks → server resumes tool with answer.
   - **Plan:** model calls `todo_write` → `todo_update` events stream → browser renders task list with live state.
   - **Execute:** model calls `read`/`bash`/`pptx` tools; `tool_execution_*` events stream → browser shows collapsible tool cards. The `pptx` tool generates the file in the workspace scratch dir.
   - **Deliver:** model calls `present_files` → file copied to persistent workspace → `present_files` event → browser shows a clickable file chip.
4. `agent_end` fires → browser marks the turn complete.

Throughout, Pi's existing events (`compaction_*`, `auto_retry_*`) are translated into UI status states (compacting, retrying, failed-with-retry).

---

## 6. Feature → implementation mapping

| Cowork feature | Pi-Cowork implementation | Phase |
|---|---|---|
| Agentic loop + streaming | `AgentSession` + `subscribe()` (native) | 1 |
| Multi-provider (4 named + more) | `pi-ai` built-in providers + `AuthStorage` | 1 |
| Model selection | `ModelRegistry.getAvailable()` → settings dropdown | 1 |
| read/bash/edit/write/grep/find/ls | Pi built-in tools (native) | 1 |
| Sessions: new/resume/list/fork | `SessionManager` + `AgentSessionRuntime` (native) | 1 |
| Basic safety (bash gate, rules) | `pi.on("tool_call")` hook + system prompt | 1 |
| Task-list widget | Custom `todo_write`/`todo_update` tools → events | 2 |
| Clarifying-question cards | Custom `ask_question` tool (`defineTool`) | 2 |
| Document creation (.docx/.xlsx/.pptx/.pdf) | Custom tools wrapping `docx`/`exceljs`/`pptxgenjs`/`pdfkit` | 2 |
| `present_files` deliverable chips | Custom `present_files` tool | 2 |
| File-based memory | Custom `memory_*` tools + `memory/` dir | 2 |
| Skills (markdown) | Loader → injects into system prompt / as tools | 2 |
| Slash commands | Pi extension `registerCommand` | 2 |
| MCP connectors | MCP client in backend; connectors → Pi custom tools | 2 |
| Chrome control | Playwright-based `chrome_*` tools | 2.5 |
| Artifacts (live HTML) | Custom `create_artifact` tool → sandboxed iframe | 3 |
| Scheduled tasks | `node-cron` + per-tick in-memory Pi session | 3 |
| Projects (persistent workspace + memory) | Workspace selection + persistent settings/memory | 3 |
| Safety guardrails (prohibited/explicit-permission/injection) | `safety/` module + `pi.on("tool_call")` gate + prompt rules | 1+ongoing |
| Sub-agents / parallel | Multiple in-memory `AgentSession`s driven concurrently; or Pi subagent extension | 1/2 |

---

## 7. Phases & success criteria

### Phase 1 — Core platform
- Web app: chat UI with streaming markdown, code blocks, collapsible tool cards, thinking display
- Backend: `createPiSession`, WS event bridge, session lifecycle (create/dispose)
- All 4 providers configurable in settings; keys in `AuthStorage`; model picker from `ModelRegistry`
- Built-in tools (read/bash/edit/write/grep) active and rendered
- Sessions: new / resume / list / fork via `SessionManager` + `AgentSessionRuntime`
- Basic safety: bash command allow/deny hook; system-prompt rules; path sandbox to workspace
- **Done when:** a user can send a prompt, watch streaming + tool execution live in the browser, switch between the 4 providers, pick a model, and create/resume/fork a session. Verified by an E2E Playwright test against a faux provider.

### Phase 2 — Knowledge-worker layer
- `ask_question` clarifying cards
- `todo_write` / `todo_update` task-list widget
- Document tools: `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.md`
- `present_files` file chips
- File-based memory tools
- Plugin loader: markdown skills, slash commands, MCP connectors
- **Done when:** a knowledge worker can describe a deliverable, answer clarifying questions, watch the task list update, and receive finished documents saved to their workspace. Verified by an E2E doc-creation test.

### Phase 2.5 — Chrome control
- Playwright-based `chrome_*` tools (navigate, click, type, scrape, screenshot, form fill)
- Approval gating for sensitive actions (logins, purchases)
- **Done when:** the agent can research a webpage and extract structured data end-to-end in an E2E test.

### Phase 3 — Advanced
- Artifacts: live HTML in sandboxed iframe with restricted `window.cowork`-style API
- Scheduled tasks: cron + one-shot, run autonomously on tick
- Projects: persistent workspaces + per-project memory/settings; user-chosen folder option
- **Done when:** artifacts render live, scheduled tasks fire on schedule, projects persist across server restarts. Each verified by an integration test.

---

## 8. Safety, error handling, testing

### Safety (non-negotiable)
- **Bash gate:** `pi.on("tool_call")` inspects `bash`; deny patterns (`rm -rf /`, `sudo`, network-exfil signatures) require explicit UI confirmation.
- **Path sandboxing:** file tools constrained to the session workspace via Pi tool `cwd`.
- **Provider keys:** stored only in `AuthStorage` (`~/.pi/agent/auth.json`, 0600); never sent to browser.
- **Injection defense:** tool results containing injection signatures ("ignore previous instructions", "system:") trigger a confirmation, mirroring Cowork.
- **Prohibited-action list:** banking/ID data, irreversible deletes, permission changes, trades, publishing, account creation — enforced in `safety/` and the tool layer.
- **Explicit-permission actions:** downloads, purchases, financial data, account settings, sharing, OAuth, sending messages — surfaced as UI confirmations.

### Error handling
- Pi events (`error`, `auto_retry_*`, `compaction_*`) → UI status states (retrying, compacting, failed-with-retry-button).
- WebSocket auto-reconnect with session-id resume.
- Provider auth failures → "set your API key" nudge in settings.

### Testing strategy
- **Unit** (`vitest`): `pi-engine` event mapping, each custom tool, plugin loader, scheduler, memory, `safety/` rules.
- **Integration:** full agent loop using Pi's `registerFauxProvider` so CI runs without real API keys.
- **E2E** (Playwright): Phase-1 chat flow; Phase-2 doc-creation flow; Phase-2.5 Chrome research flow.
- **Gate:** a green test suite is required before each phase is declared done. No phase is "done" on assertion alone — each success criterion above must be demonstrated by a passing test or live verification.

---

## 9. Repository layout (proposed)

```
Pi-Cowork/
  web/                      # Vite + React + TS frontend
    src/
      components/           # chat, tool cards, task list, question cards, ...
      views/                # chat, sessions, settings, artifacts, scheduler, projects
      lib/                  # ws client, event types, api client
  server/                   # Fastify + ws backend
    src/
      routes/               # sessions, messages, providers, settings
      pi-engine/            # createAgentSession wrapper, event mapping
      tools/                # custom Cowork tools
      plugins/              # skill/command/connector loader
      workspaces/           # workspace + path translation
      scheduler/            # cron + one-shot
      artifacts/            # HTML artifact store + serve
      memory/               # file-based memory
      safety/               # guardrails
  docs/
  package.json              # workspace root (npm/bun workspaces)
  tsconfig.json
```

---

## 10. Open questions / risks

- **Pi Agent API drift:** it's at v0.80.x (pre-1.0). Mitigation: pin exact versions; wrap Pi behind `pi-engine/` so API changes are localized.
- **Chrome control in a server process:** Playwright needs a browser installed; we'll bundle/manage a Chromium. Works headless on the server.
- **Session persistence across server restarts:** `SessionManager.create(cwd)` persists JSONL; resuming a session that references tools not currently registered needs graceful handling.
- **Skill content licensing:** we write our own starter skills; we do not copy Anthropic's skill text.

---

## Next step

Upon approval, invoke the **writing-plans** skill to produce a detailed, phased implementation plan starting with Phase 1.
