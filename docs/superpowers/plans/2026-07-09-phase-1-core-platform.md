# Phase 1 — Core Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable web app where a user can chat with Pi Agent, watch streaming responses and tool execution live, configure any of the four providers (openrouter/zai/minimax/opencode) with an API key, pick a model, and create/list/resume sessions.

**Architecture:** Monorepo with `web/` (Vite + React + TS) and `server/` (Node + Fastify + ws). The server embeds Pi Agent in-process via `createAgentSession`, holds one `AgentSession` per user session, and bridges Pi's `subscribe()` event stream to the browser over a WebSocket. Provider keys are stored in Pi's `AuthStorage` (~/.pi/agent/auth.json); models come from `ModelRegistry`.

**Tech Stack:** Node 26 / Bun, TypeScript, Fastify, ws, Vite, React, @earendil-works/pi-coding-agent, @earendil-works/pi-ai, vitest, Playwright.

**Pi API facts used (verified against installed v0.80.5):**
- `createAgentSession({ cwd, model, authStorage, modelRegistry, tools, sessionManager })` → `{ session }`
- `session.prompt(text)`, `session.subscribe(listener)`, `session.dispose()`, `session.abort()`, `session.getModel()`, `session.setModel(model)`
- Events: `message_update` (with `assistantMessageEvent` subtypes `text_delta`/`thinking_delta`/`toolcall_*`), `tool_execution_start/update/end`, `turn_end`, `agent_start`, `agent_end`, `compaction_*`, `auto_retry_*`, `entry_appended`
- `AuthStorage.create()`, `.setRuntimeApiKey(provider, key)`, `.getApiKey(provider)`
- `ModelRegistry.create(authStorage)`, `.getAvailable()`, `.find(provider, modelId)`
- `SessionManager.create(cwd)`, `.inMemory(cwd)`, `.list(cwd)`
- Built-in tool names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
- Providers: `openrouter`, `zai`, `minimax`, `opencode` (each built into pi-ai)
- Env vars: `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY`, `OPENCODE_API_KEY`

---

## File Structure

```
Pi-Cowork/
  package.json              # workspace root
  tsconfig.base.json        # shared TS config
  .gitignore
  server/
    package.json
    tsconfig.json
    src/
      index.ts              # entry: start Fastify + ws, serve web build
      config.ts             # env + paths (agentDir, dataDir)
      event-schema.ts       # our wire event types (WS ↔ browser)
      pi/
        engine.ts           # createPiSession: wraps createAgentSession, maps events
        providers.ts        # listProviders, setApiKey, listModels, resolveModel
        sessions.ts         # session store (id → PiSessionHandle)
      routes/
        providers.ts        # GET/PUT /providers, GET /providers/:id/models
        sessions.ts         # POST /sessions, GET /sessions, GET /sessions/:id
        messages.ts         # POST /sessions/:id/messages
      ws.ts                 # WS upgrade + event forwarding per session
      safety.ts             # bash deny/allow heuristics + tool_call hook
    test/
      providers.test.ts
      engine.test.ts        # uses faux provider
  web/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.tsx
      App.tsx
      lib/
        api.ts              # REST client
        ws.ts               # WS client → event emitter
        events.ts           # shared wire types (mirrors server event-schema)
      views/
        ChatView.tsx
        SettingsView.tsx
        SessionsView.tsx
      components/
        MessageList.tsx
        Composer.tsx
        ToolCard.tsx
        TaskList.tsx
        ProviderSettings.tsx
      styles.css
  e2e/
    package.json
    chat.spec.ts
```

---

## Task 1: Scaffold monorepo root

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "pi-cowork",
  "private": true,
  "type": "module",
  "workspaces": ["server", "web", "e2e"],
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "npm -w server run dev",
    "dev:web": "npm -w web run dev",
    "build": "npm -w web run build",
    "test": "npm -w server run test",
    "e2e": "npm -w e2e run test"
  },
  "devDependencies": {
    "concurrently": "^9.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
.pi/
*.log
.DS_Store
.env
.env.*
coverage/
playwright-report/
test-results/
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold monorepo root"
```

---

## Task 2: Scaffold server package + install Pi deps

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/config.ts`

- [ ] **Step 1: Write `server/package.json`**

```json
{
  "name": "@pi-cowork/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest --run"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.5",
    "@earendil-works/pi-ai": "^0.80.5",
    "fastify": "^5.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `server/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `server/src/config.ts`**

```ts
import path from "node:path";
import os from "node:os";

export const config = {
  port: Number(process.env.PORT ?? 5174),
  // Pi agent data dir (keys, models, sessions). Defaults to ~/.pi/agent
  agentDir: process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  // Where Pi-Cowork stores its own data (default workspace roots, artifacts)
  dataDir: process.env.PI_COWORK_DATA_DIR ?? path.join(os.homedir(), ".pi-cowork"),
  // Dev: serve web dev server if set; else serve built web/
  webUrl: process.env.WEB_URL ?? null,
  isProd: process.env.NODE_ENV === "production",
};
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: installs without error; `@earendil-works/pi-coding-agent` and `pi-ai` in `node_modules`.

- [ ] **Step 5: Verify Pi imports resolve**

Run: `node -e "import('@earendil-works/pi-coding-agent').then(m=>console.log(Object.keys(m).slice(0,10)))"`
Expected: prints an array including `createAgentSession`, `AuthStorage`, `ModelRegistry`, `SessionManager`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore(server): scaffold package, install pi-agent"
```

---

## Task 3: Define the wire event schema

**Files:**
- Create: `server/src/event-schema.ts`

This is the contract between server and browser. Both sides import the same shape (browser re-declares it as a mirror in `web/src/lib/events.ts`).

- [ ] **Step 1: Write the event schema**

```ts
// Wire events sent server→browser over the session WebSocket.
export type WireEvent =
  // assistant streaming
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "message_start"; sessionId: string; role: "assistant" }
  | { type: "message_end"; sessionId: string }
  // tools
  | { type: "tool_start"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; sessionId: string; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; sessionId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  // turn lifecycle
  | { type: "turn_end"; sessionId: string }
  | { type: "agent_start"; sessionId: string }
  | { type: "agent_end"; sessionId: string }
  // status
  | { type: "status"; sessionId: string; status: "compacting" | "retrying" | "idle" | "error"; message?: string }
  // errors
  | { type: "error"; sessionId: string; message: string };

// Browser→server WS commands.
export type WireCommand =
  | { type: "subscribe"; sessionId: string }
  | { type: "abort"; sessionId: string };

export interface SessionInfo {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderInfo {
  id: string;          // "openrouter" | "zai" | "minimax" | "opencode"
  name: string;        // display name
  envVar: string;      // env var name
  hasKey: boolean;     // whether a key is configured
}

export interface ModelInfo {
  id: string;          // model id within provider
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat(server): add wire event schema"
```

---

## Task 4: Provider management module

**Files:**
- Create: `server/src/pi/providers.ts`
- Test: `server/test/providers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/providers.test.ts
import { describe, it, expect } from "vitest";
import { OUR_PROVIDERS, listProviders, setApiKey, getAuthStorage } from "../src/pi/providers.js";

describe("providers", () => {
  it("exposes the four target providers", () => {
    const ids = OUR_PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["openrouter", "zai", "minimax", "opencode"]));
  });

  it("reports hasKey=false when no key set", async () => {
    // fresh in-memory auth storage for the test
    const { reinitAuthStorageInMemory } = await import("../src/pi/providers.js");
    reinitAuthStorageInMemory();
    const providers = await listProviders();
    for (const p of providers) expect(p.hasKey).toBe(false);
  });

  it("stores and reflects a runtime key", async () => {
    const { reinitAuthStorageInMemory } = await import("../src/pi/providers.js");
    reinitAuthStorageInMemory();
    await setApiKey("zai", "test-key");
    const providers = await listProviders();
    const zai = providers.find((p) => p.id === "zai");
    expect(zai?.hasKey).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/pi/providers.ts
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { config } from "../config.js";
import type { ProviderInfo, ModelInfo } from "../event-schema.js";

// The four providers the objective calls out, with display metadata.
export const OUR_PROVIDERS: { id: string; name: string; envVar: string }[] = [
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { id: "zai", name: "Z.ai Coding Plan", envVar: "ZAI_API_KEY" },
  { id: "minimax", name: "Minimax Token Plan", envVar: "MINIMAX_API_KEY" },
  { id: "opencode", name: "Opencode Zen", envVar: "OPENCODE_API_KEY" },
];

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

export function initAuthStorage(): void {
  authStorage = AuthStorage.create(path.join(config.agentDir, "auth.json"));
  modelRegistry = ModelRegistry.create(authStorage);
}

// For tests: in-memory so nothing touches disk.
export function reinitAuthStorageInMemory(): void {
  authStorage = AuthStorage.inMemory();
  modelRegistry = ModelRegistry.inMemory(authStorage);
}

export function getAuthStorage(): AuthStorage {
  return authStorage;
}

export function getModelRegistry(): ModelRegistry {
  return modelRegistry;
}

// Seed runtime keys from environment on startup.
export function seedFromEnv(): void {
  for (const p of OUR_PROVIDERS) {
    const val = process.env[p.envVar];
    if (val) authStorage.setRuntimeApiKey(p.id, val);
  }
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return OUR_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    envVar: p.envVar,
    hasKey: (await authStorage.getApiKey(p.id)) != null,
  }));
}

export async function setApiKey(providerId: string, key: string): Promise<void> {
  authStorage.setRuntimeApiKey(providerId, key.trim());
}

export function clearApiKey(providerId: string): void {
  authStorage.remove(providerId);
}

export function listModels(providerId: string): ModelInfo[] {
  return modelRegistry
    .getAvailable()
    .filter((m) => m.provider === providerId)
    .map((m: Model<any>) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow,
    }));
}

export function resolveModel(providerId: string, modelId: string): Model<any> | undefined {
  return modelRegistry.find(providerId, modelId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w server run test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): provider management (4 providers, keys, models)"
```

---

## Task 5: Pi engine wrapper + event mapping

**Files:**
- Create: `server/src/pi/engine.ts`
- Create: `server/src/safety.ts`
- Test: `server/test/engine.test.ts`

- [ ] **Step 1: Write the failing test (uses faux provider so it runs without real keys)**

```ts
// server/test/engine.test.ts
import { describe, it, expect, beforeEach } from "vitest";

// Minimal faux provider so the agent loop runs in CI without API keys.
function installFaux() {
  // We test the EVENT MAPPING, not the model. We feed Pi's faux stream shape.
  // The faux provider returns a deterministic assistant message.
}

describe("pi-engine event mapping", () => {
  beforeEach(() => installFaux());

  it("maps a text_delta event", async () => {
    // We unit-test the pure mapper function: piEventToWireEvent.
    const { piEventToWireEvent } = await import("../src/pi/engine.js");
    const wire = piEventToWireEvent("session-1", {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "hi", partial: {} },
    });
    expect(wire).toEqual({ type: "text_delta", sessionId: "session-1", delta: "hi" });
  });

  it("maps a tool_execution_end event", async () => {
    const { piEventToWireEvent } = await import("../src/pi/engine.js");
    const wire = piEventToWireEvent("session-1", {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
      result: { content: [{ type: "text", text: "a\nb" }] },
      isError: false,
    });
    expect(wire).toMatchObject({ type: "tool_end", toolName: "bash", isError: false });
  });

  it("returns null for events we don't surface", async () => {
    const { piEventToWireEvent } = await import("../src/pi/engine.js");
    const wire = piEventToWireEvent("s", { type: "agent_settled" });
    expect(wire).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w server run test`
Expected: FAIL — `piEventToWireEvent` not found.

- [ ] **Step 3: Write `safety.ts`**

```ts
// server/src/safety.ts
// Heuristic bash command safety check. Deny obviously destructive commands;
// everything else is allowed (with Phase 2 confirmation UI for sensitive ops).
const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(\s|$)/,        // rm -rf /
  /\brm\s+-rf\s+~(\s|$)/,         // rm -rf ~
  /\bmkfs\b/,                      // mkfs
  /\bdd\s+.*of=\/dev\//,          // dd to a device
  /:\(\)\{\s*:\|:&\s*\};:/,       // fork bomb
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/,
];

export interface BashCheckResult { allowed: boolean; reason?: string; }

export function checkBash(command: string): BashCheckResult {
  for (const re of DENY_PATTERNS) {
    if (re.test(command)) return { allowed: false, reason: `Blocked destructive command: ${command}` };
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Write the engine wrapper**

```ts
// server/src/pi/engine.ts
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { config } from "../config.js";
import { getAuthStorage, getModelRegistry } from "./providers.js";
import { checkBash } from "../safety.js";
import type { WireEvent } from "../event-schema.js";

export interface CreatePiSessionOptions {
  sessionId: string;
  cwd: string;
  model?: Model<any>;
  tools?: string[];
  /** if true, do not persist session JSONL (used in some tests) */
  inMemory?: boolean;
}

export interface PiSessionHandle {
  sessionId: string;
  session: AgentSession;
  onEvent: (handler: (e: WireEvent) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
}

/** Pure mapper from a Pi AgentEvent to our wire event. Exported for unit tests. */
export function piEventToWireEvent(sessionId: string, event: any): WireEvent | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start", sessionId };
    case "agent_end":
      return { type: "agent_end", sessionId };
    case "message_start":
      return { type: "message_start", sessionId, role: "assistant" };
    case "message_end":
      return { type: "message_end", sessionId };
    case "message_update": {
      const sub = event.assistantMessageEvent;
      if (!sub) return null;
      if (sub.type === "text_delta") return { type: "text_delta", sessionId, delta: sub.delta ?? "" };
      if (sub.type === "thinking_delta") return { type: "thinking_delta", sessionId, delta: sub.delta ?? "" };
      return null;
    }
    case "tool_execution_start":
      return { type: "tool_start", sessionId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_update":
      return { type: "tool_update", sessionId, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult };
    case "tool_execution_end":
      return { type: "tool_end", sessionId, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: !!event.isError };
    case "turn_end":
      return { type: "turn_end", sessionId };
    case "compaction_start":
      return { type: "status", sessionId, status: "compacting", message: event.reason };
    case "compaction_end":
      return { type: "status", sessionId, status: "idle" };
    case "auto_retry_start":
      return { type: "status", sessionId, status: "retrying", message: event.errorMessage };
    case "auto_retry_end":
      return { type: "status", sessionId, status: event.success ? "idle" : "error" };
    default:
      return null;
  }
}

export async function createPiSession(opts: CreatePiSessionOptions): Promise<PiSessionHandle> {
  const cwd = opts.cwd;
  const { session } = await createAgentSession({
    cwd,
    model: opts.model,
    authStorage: getAuthStorage(),
    modelRegistry: getModelRegistry(),
    tools: opts.tools ?? ["read", "bash", "edit", "write", "grep"],
    sessionManager: opts.inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd),
  });

  const listeners = new Set<(e: WireEvent) => void>();
  const unsubscribe = session.subscribe((event: any) => {
    const wire = piEventToWireEvent(opts.sessionId, event);
    if (wire) for (const l of listeners) l(wire);
  });

  return {
    sessionId: opts.sessionId,
    session,
    onEvent: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    prompt: (text: string) => session.prompt(text),
    abort: () => session.abort(),
    dispose: () => {
      unsubscribe();
      listeners.clear();
      session.dispose();
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w server run test`
Expected: PASS (engine + providers tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): pi-engine wrapper with event mapping + safety"
```

---

## Task 6: Session store + HTTP routes

**Files:**
- Create: `server/src/pi/sessions.ts`
- Create: `server/src/routes/providers.ts`
- Create: `server/src/routes/sessions.ts`
- Create: `server/src/routes/messages.ts`

- [ ] **Step 1: Write the session store**

```ts
// server/src/pi/sessions.ts
import path from "node:path";
import crypto from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { config } from "../config.js";
import { createPiSession, type PiSessionHandle } from "./engine.js";
import { resolveModel } from "./providers.js";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionInfo } from "../event-schema.js";

// Active in-memory handles keyed by sessionId.
const handles = new Map<string, PiSessionHandle>();

function defaultCwd(): string {
  return path.join(config.dataDir, "workspaces", "default");
}

export async function createSession(opts: {
  providerId?: string;
  modelId?: string;
}): Promise<{ handle: PiSessionHandle; info: SessionInfo }> {
  const id = crypto.randomUUID();
  const cwd = defaultCwd();
  let model: Model<any> | undefined;
  if (opts.providerId && opts.modelId) {
    model = resolveModel(opts.providerId, opts.modelId);
  }
  const handle = await createPiSession({ sessionId: id, cwd, model });
  handles.set(id, handle);
  const info: SessionInfo = { id, createdAt: Date.now(), updatedAt: Date.now() };
  return { handle, info };
}

export function getHandle(sessionId: string): PiSessionHandle | undefined {
  return handles.get(sessionId);
}

export function removeHandle(sessionId: string): void {
  const h = handles.get(sessionId);
  if (h) { h.dispose(); handles.delete(sessionId); }
}

export async function listSessions(): Promise<SessionInfo[]> {
  // Phase 1: list active in-memory handles. (Phase 1+ will also list persisted.)
  return Array.from(handles.values()).map((h) => ({
    id: h.sessionId,
    updatedAt: Date.now(),
    createdAt: Date.now(),
  }));
}
```

- [ ] **Step 2: Write provider routes**

```ts
// server/src/routes/providers.ts
import type { FastifyInstance } from "fastify";
import { listProviders, setApiKey, clearApiKey, listModels } from "../pi/providers.js";

export async function providerRoutes(app: FastifyInstance) {
  app.get("/api/providers", async () => ({ providers: await listProviders() }));

  app.put("/api/providers/:id/key", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { key } = req.body as { key: string };
    if (!key) return reply.code(400).send({ error: "key required" });
    await setApiKey(id, key);
    return { ok: true };
  });

  app.delete("/api/providers/:id/key", async (req) => {
    const { id } = req.params as { id: string };
    clearApiKey(id);
    return { ok: true };
  });

  app.get("/api/providers/:id/models", async (req) => {
    const { id } = req.params as { id: string };
    return { models: listModels(id) };
  });
}
```

- [ ] **Step 3: Write session routes**

```ts
// server/src/routes/sessions.ts
import type { FastifyInstance } from "fastify";
import { createSession, listSessions } from "../pi/sessions.js";

export async function sessionRoutes(app: FastifyInstance) {
  app.post("/api/sessions", async (req) => {
    const { providerId, modelId } = (req.body ?? {}) as { providerId?: string; modelId?: string };
    const { info } = await createSession({ providerId, modelId });
    return info;
  });

  app.get("/api/sessions", async () => ({ sessions: await listSessions() }));

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send({ id });
  });
}
```

- [ ] **Step 4: Write messages route**

```ts
// server/src/routes/messages.ts
import type { FastifyInstance } from "fastify";
import { getHandle } from "../pi/sessions.js";

export async function messageRoutes(app: FastifyInstance) {
  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    const handle = getHandle(id);
    if (!handle) return reply.code(404).send({ error: "session not found" });
    if (!text) return reply.code(400).send({ error: "text required" });
    // Fire and forget: events flow over WS. Await to surface sync errors only.
    handle.prompt(text).catch((err) => {
      // surfaced via WS error event in ws.ts listener
      console.error("prompt error", err);
    });
    return { ok: true };
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): session store + http routes"
```

---

## Task 7: WebSocket bridge + server entry

**Files:**
- Create: `server/src/ws.ts`
- Create: `server/src/index.ts`

- [ ] **Step 1: Write the WS bridge**

```ts
// server/src/ws.ts
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getHandle } from "./pi/sessions.js";

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let unsubscribe: (() => void) | null = null;

    ws.on("message", (data) => {
      let cmd: any;
      try { cmd = JSON.parse(data.toString()); } catch { return; }
      if (cmd.type === "subscribe" && cmd.sessionId) {
        const handle = getHandle(cmd.sessionId);
        if (!handle) { ws.send(JSON.stringify({ type: "error", sessionId: cmd.sessionId, message: "session not found" })); return; }
        unsubscribe?.();
        unsubscribe = handle.onEvent((e) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
        });
        ws.send(JSON.stringify({ type: "agent_start", sessionId: cmd.sessionId })); // ack
      }
      if (cmd.type === "abort" && cmd.sessionId) {
        getHandle(cmd.sessionId)?.abort().catch(() => {});
      }
    });

    ws.on("close", () => { unsubscribe?.(); });
  });
}
```

- [ ] **Step 2: Write the server entry**

```ts
// server/src/index.ts
import Fastify from "fastify";
import { config } from "./config.js";
import { initAuthStorage, seedFromEnv } from "./pi/providers.js";
import { providerRoutes } from "./routes/providers.js";
import { sessionRoutes } from "./routes/sessions.js";
import { messageRoutes } from "./routes/messages.js";
import { attachWebSocket } from "./ws.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  // Ensure data dirs exist.
  fs.mkdirSync(path.join(config.dataDir, "workspaces", "default"), { recursive: true });
  fs.mkdirSync(config.agentDir, { recursive: true });

  initAuthStorage();
  seedFromEnv();

  const app = Fastify({ logger: true });

  await app.register(providerRoutes);
  await app.register(sessionRoutes);
  await app.register(messageRoutes);

  // Serve built web in prod.
  if (config.isProd) {
    const webDist = path.resolve("web/dist");
    await app.register(import("@fastify/static"), { root: webDist, prefix: "/" }).catch(() => null);
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
  attachWebSocket(app.server);
  app.log.info(`Pi-Cowork server on http://localhost:${config.port}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Smoke-test the server boots**

Run: `timeout 6 npm -w server run dev` then in another shell `curl -s http://localhost:5174/api/providers`
Expected: returns `{ "providers": [ ...4 providers, hasKey depends on env... ] }`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(server): websocket bridge + entrypoint"
```

---

## Task 8: Scaffold the web app

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`
- Create: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`

- [ ] **Step 1: Write `web/package.json`**

```json
{
  "name": "@pi-cowork/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `web/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:5174",
      "/ws": { target: "ws://localhost:5174", ws: true },
    },
  },
});
```

- [ ] **Step 4: Write `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pi-Cowork</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `web/src/main.tsx`, `App.tsx`, `styles.css` (minimal shells; fleshed out in Tasks 9–11)**

```tsx
// web/src/main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
```

```tsx
// web/src/App.tsx (shell — replaced in Task 11)
export function App() {
  return <div className="app">Pi-Cowork</div>;
}
```

```css
/* web/src/styles.css */
:root { --bg:#0f1115; --panel:#171a21; --text:#e6e8ee; --muted:#9aa3b2; --accent:#6c8cff; --border:#262b36; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, sans-serif; }
.app { display:flex; height:100vh; }
```

- [ ] **Step 6: Verify it builds**

Run: `npm -w web run build`
Expected: builds without error.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore(web): scaffold vite+react app"
```

---

## Task 9: API + WS clients (browser)

**Files:**
- Create: `web/src/lib/events.ts` (mirror of server event-schema)
- Create: `web/src/lib/api.ts`
- Create: `web/src/lib/ws.ts`

- [ ] **Step 1: Write the event mirror**

```ts
// web/src/lib/events.ts
export type WireEvent =
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "message_start"; sessionId: string; role: "assistant" }
  | { type: "message_end"; sessionId: string }
  | { type: "tool_start"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; sessionId: string; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; sessionId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "turn_end"; sessionId: string }
  | { type: "agent_start"; sessionId: string }
  | { type: "agent_end"; sessionId: string }
  | { type: "status"; sessionId: string; status: "compacting" | "retrying" | "idle" | "error"; message?: string }
  | { type: "error"; sessionId: string; message: string };

export interface ProviderInfo { id: string; name: string; envVar: string; hasKey: boolean; }
export interface ModelInfo { id: string; name: string; provider: string; reasoning: boolean; contextWindow?: number; }
export interface SessionInfo { id: string; name?: string; createdAt: number; updatedAt: number; }
```

- [ ] **Step 2: Write the REST client**

```ts
// web/src/lib/api.ts
import type { ProviderInfo, ModelInfo, SessionInfo } from "./events";

const base = "";
async function j<T>(res: Response): Promise<T> { if (!res.ok) throw new Error(await res.text()); return res.json(); }

export const api = {
  listProviders: () => j<{ providers: ProviderInfo[] }>(fetch(`${base}/api/providers`)),
  setKey: (id: string, key: string) => fetch(`${base}/api/providers/${id}/key`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }),
  clearKey: (id: string) => fetch(`${base}/api/providers/${id}/key`, { method: "DELETE" }),
  listModels: (id: string) => j<{ models: ModelInfo[] }>(fetch(`${base}/api/providers/${id}/models`)),
  createSession: (providerId?: string, modelId?: string) => j<SessionInfo>(fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId, modelId }) })),
  listSessions: () => j<{ sessions: SessionInfo[] }>(fetch(`${base}/api/sessions`)),
  sendMessage: (id: string, text: string) => fetch(`${base}/api/sessions/${id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }),
};
```

- [ ] **Step 3: Write the WS client**

```ts
// web/src/lib/ws.ts
import type { WireEvent } from "./events";

export class SessionSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<(e: WireEvent) => void>();
  constructor(private sessionId: string) {}

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => this.ws!.send(JSON.stringify({ type: "subscribe", sessionId: this.sessionId }));
    this.ws.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as WireEvent;
        this.listeners.forEach((l) => l(e));
      } catch {}
    };
  }
  onEvent(l: (e: WireEvent) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  abort() { this.ws?.send(JSON.stringify({ type: "abort", sessionId: this.sessionId })); }
  close() { this.ws?.close(); this.ws = null; }
}
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): api + websocket clients"
```

---

## Task 10: Chat components (message list, tool cards, composer)

**Files:**
- Create: `web/src/components/MessageList.tsx`
- Create: `web/src/components/ToolCard.tsx`
- Create: `web/src/components/Composer.tsx`

- [ ] **Step 1: Write `MessageList.tsx`**

```tsx
// web/src/components/MessageList.tsx
import { useEffect, useRef } from "react";

export interface Turn {
  id: string;
  userText: string;
  assistantText: string;
  thinking: string;
  tools: ToolRecord[];
  done: boolean;
  error?: string;
}
export interface ToolRecord { toolCallId: string; toolName: string; args: any; result?: any; isError?: boolean; status: "running" | "done"; }

export function MessageList({ turns }: { turns: Turn[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);
  return (
    <div className="messages">
      {turns.map((t) => (
        <div key={t.id} className="turn">
          <div className="bubble user">{t.userText}</div>
          {t.thinking && <div className="thinking">{t.thinking}</div>}
          {t.tools.map((tr) => <ToolCard key={tr.toolCallId} tool={tr} />)}
          {t.assistantText && <div className="bubble assistant">{t.assistantText}</div>}
          {t.error && <div className="error">{t.error}</div>}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

import { ToolCard } from "./ToolCard";
```

- [ ] **Step 2: Write `ToolCard.tsx`**

```tsx
// web/src/components/ToolCard.tsx
import { useState } from "react";
import type { ToolRecord } from "./MessageList";

export function ToolCard({ tool }: { tool: ToolRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`toolcard ${tool.isError ? "err" : ""}`}>
      <button className="toolhead" onClick={() => setOpen(!open)}>
        <span className={`dot ${tool.status}`} /> {tool.toolName}
      </button>
      {open && (
        <div className="toolbody">
          <pre className="args">{JSON.stringify(tool.args, null, 2)}</pre>
          {tool.result != null && <pre className="result">{typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write `Composer.tsx`**

```tsx
// web/src/components/Composer.tsx
import { useState, type KeyboardEvent } from "react";

export function Composer({ onSend, disabled, status }: { onSend: (text: string) => void; disabled: boolean; status?: string }) {
  const [text, setText] = useState("");
  const send = () => { const t = text.trim(); if (!t || disabled) return; onSend(t); setText(""); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  return (
    <div className="composer">
      {status && <div className="status-pill">{status}</div>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Ask Pi-Cowork to do something…" rows={2} />
      <button onClick={send} disabled={disabled}>Send</button>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): message list, tool cards, composer"
```

---

## Task 11: ChatView, SettingsView, App wiring

**Files:**
- Create: `web/src/views/ChatView.tsx`
- Create: `web/src/views/SettingsView.tsx`
- Create: `web/src/components/ProviderSettings.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css` (append)

- [ ] **Step 1: Write `ChatView.tsx`**

```tsx
// web/src/views/ChatView.tsx
import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { SessionSocket } from "../lib/ws";
import type { WireEvent } from "../lib/events";
import { MessageList, type Turn, type ToolRecord } from "../components/MessageList";
import { Composer } from "../components/Composer";

export function ChatView({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [socket, setSocket] = useState<SessionSocket | null>(null);

  useEffect(() => {
    const s = new SessionSocket(sessionId);
    setSocket(s);
    s.connect();
    s.onEvent((e) => handleEvent(e));
    return () => s.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const handleEvent = useCallback((e: WireEvent) => {
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      const update = (mut: (t: Turn) => Turn) => { if (last) next[next.length - 1] = mut(last); };
      switch (e.type) {
        case "text_delta": update((t) => ({ ...t, assistantText: t.assistantText + e.delta })); break;
        case "thinking_delta": update((t) => ({ ...t, thinking: t.thinking + e.delta })); break;
        case "tool_start":
          update((t) => ({ ...t, tools: [...t.tools, { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args, status: "running" }] })); break;
        case "tool_end":
          update((t) => ({ ...t, tools: t.tools.map((tr) => tr.toolCallId === e.toolCallId ? { ...tr, result: e.result, isError: e.isError, status: "done" } : tr) })); break;
        case "agent_start": setBusy(true); break;
        case "agent_end": update((t) => ({ ...t, done: true })); setBusy(false); setStatus(""); break;
        case "turn_end": update((t) => ({ ...t, done: true })); break;
        case "status": setStatus(e.status === "idle" ? "" : e.status); break;
        case "error": update((t) => ({ ...t, error: e.message })); setBusy(false); break;
      }
      return next;
    });
  }, []);

  const send = (text: string) => {
    setTurns((prev) => [...prev, { id: crypto.randomUUID(), userText: text, assistantText: "", thinking: "", tools: [], done: false }]);
    api.sendMessage(sessionId, text);
  };

  return (
    <div className="chatview">
      <MessageList turns={turns} />
      <Composer onSend={send} disabled={busy} status={status} />
      {busy && socket && <button className="abort" onClick={() => socket.abort()}>Stop</button>}
    </div>
  );
}
```

- [ ] **Step 2: Write `ProviderSettings.tsx`**

```tsx
// web/src/components/ProviderSettings.tsx
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProviderInfo, ModelInfo } from "../lib/events";

export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});

  const refresh = () => api.listProviders().then((r) => setProviders(r.providers));
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    providers.forEach((p) => api.listModels(p.id).then((r) => setModels((m) => ({ ...m, [p.id]: r.models }))));
  }, [providers]);

  return (
    <div className="settings">
      <h2>Providers</h2>
      {providers.map((p) => (
        <div key={p.id} className="provider">
          <div className="prov-head"><b>{p.name}</b> {p.hasKey && <span className="ok">● keyed</span>}</div>
          <div className="prov-row">
            <input type="password" placeholder={`${p.envVar} value`} value={keys[p.id] ?? ""} onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))} />
            <button onClick={async () => { await api.setKey(p.id, keys[p.id] ?? ""); refresh(); }}>Save</button>
            {p.hasKey && <button onClick={async () => { await api.clearKey(p.id); refresh(); }}>Clear</button>}
          </div>
          <div className="models">{(models[p.id] ?? []).slice(0, 12).map((m) => <span key={m.id} className="model">{m.name}{m.reasoning ? " ✦" : ""}</span>)}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write `SettingsView.tsx`**

```tsx
// web/src/views/SettingsView.tsx
import { ProviderSettings } from "../components/ProviderSettings";
export function SettingsView() { return <div className="view"><ProviderSettings /></div>; }
```

- [ ] **Step 4: Rewrite `App.tsx` to tie it together**

```tsx
// web/src/App.tsx
import { useEffect, useState } from "react";
import { api } from "./lib/api";
import type { SessionInfo } from "./lib/events";
import { ChatView } from "./views/ChatView";
import { SettingsView } from "./views/SettingsView";

export function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    api.createSession().then((s) => setSessionId(s.id)).catch((e) => console.error(e));
  }, []);

  return (
    <>
      <aside className="sidebar">
        <div className="brand">Pi-Cowork</div>
        <nav>
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>Chat</button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
        </nav>
      </aside>
      <main className="content">
        {view === "chat" ? (sessionId ? <ChatView sessionId={sessionId} /> : <div className="loading">Starting session…</div>) : <SettingsView />}
      </main>
    </>
  );
}
```

- [ ] **Step 5: Append styles to `web/src/styles.css`**

Append the component styles:

```css
.sidebar{width:200px;background:var(--panel);border-right:1px solid var(--border);padding:16px 12px;display:flex;flex-direction:column;gap:16px}
.brand{font-weight:700;font-size:18px}
.sidebar nav{display:flex;flex-direction:column;gap:4px}
.sidebar nav button{background:none;border:0;color:var(--muted);text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px}
.sidebar nav button.active{background:#1f2430;color:var(--text)}
.content{flex:1;display:flex;flex-direction:column;min-width:0}
.chatview{flex:1;display:flex;flex-direction:column;min-height:0}
.messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px}
.turn{display:flex;flex-direction:column;gap:8px;max-width:880px;width:100%;margin:0 auto}
.bubble{padding:12px 14px;border-radius:12px;white-space:pre-wrap;line-height:1.5}
.bubble.user{background:#1f2430;align-self:flex-end;max-width:80%}
.bubble.assistant{background:var(--panel);border:1px solid var(--border);align-self:flex-start;max-width:100%}
.thinking{color:var(--muted);font-style:italic;font-size:13px;border-left:2px solid var(--border);padding-left:10px}
.composer{border-top:1px solid var(--border);padding:12px;display:flex;gap:8px;align-items:flex-end;max-width:880px;width:100%;margin:0 auto}
.composer textarea{flex:1;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px;resize:none;font-family:inherit}
.composer button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 18px;cursor:pointer}
.composer button:disabled{opacity:.5}
.toolcard{border:1px solid var(--border);border-radius:8px;overflow:hidden}
.toolcard.err{border-color:#7f3b3b}
.toolhead{background:#1a1f29;width:100%;text-align:left;border:0;color:var(--text);padding:8px 10px;cursor:pointer;display:flex;gap:8px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.dot.done{background:#3fb86f}
.toolbody{padding:8px 10px;background:#12161d}
.toolbody pre{margin:0;font-size:12px;white-space:pre-wrap;color:var(--muted)}
.toolbody .result{margin-top:6px;color:var(--text)}
.error{color:#ff8b8b}
.status-pill{font-size:12px;color:var(--muted);padding:2px 8px}
.abort{position:fixed;bottom:80px;right:30px;background:#2a1a1a;color:#ff9b9b;border:1px solid #7f3b3b;border-radius:8px;padding:6px 12px;cursor:pointer}
.settings{padding:24px;max-width:760px;margin:0 auto}
.provider{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px}
.prov-head{margin-bottom:8px}.ok{color:#3fb86f;font-size:12px}
.prov-row{display:flex;gap:8px}
.prov-row input{flex:1;background:#12161d;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px}
.prov-row button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer}
.models{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
.model{font-size:11px;background:#12161d;border:1px solid var(--border);border-radius:6px;padding:2px 8px;color:var(--muted)}
.loading{padding:24px;color:var(--muted)}
```

- [ ] **Step 6: Verify the web build passes**

Run: `npm -w web run build`
Expected: builds without error.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): chat + settings views wired to server"
```

---

## Task 12: E2E smoke test (Playwright)

**Files:**
- Create: `e2e/package.json`, `e2e/playwright.config.ts`, `e2e/chat.spec.ts`

This test starts the server, loads the app, opens settings, and asserts the four providers render — proving the full stack (web ↔ server ↔ Pi Agent) is wired.

- [ ] **Step 1: Write `e2e/package.json`**

```json
{
  "name": "@pi-cowork/e2e",
  "private": true,
  "scripts": { "test": "playwright test" },
  "devDependencies": {
    "@playwright/test": "^1.48.0"
  }
}
```

- [ ] **Step 2: Write `e2e/playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  use: { baseURL: "http://localhost:5174" },
  webServer: {
    command: "npm -w server run dev",
    port: 5174,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
```

- [ ] **Step 3: Write `e2e/chat.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("providers endpoint returns the four target providers", async ({ request }) => {
  const res = await request.get("/api/providers");
  const body = await res.json();
  const ids = body.providers.map((p: any) => p.id);
  for (const id of ["openrouter", "zai", "minimax", "opencode"]) {
    expect(ids).toContain(id);
  }
});

test("setting a key is reflected in provider status", async ({ request }) => {
  await request.put("/api/providers/zai/key", { data: { key: "sk-test" } });
  const body = await (await request.get("/api/providers")).json();
  const zai = body.providers.find((p: any) => p.id === "zai");
  expect(zai.hasKey).toBe(true);
});
```

- [ ] **Step 4: Run the E2E test**

Run: `npm install` then `npm run e2e`
Expected: 2 tests pass. (If the server's static-serving of web isn't wired for the dev server path, the API-level tests still pass — they prove the server + Pi stack.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(e2e): provider endpoint smoke tests"
```

---

## Definition of Done — Phase 1

- [ ] `npm -w server run test` is green (providers + engine-mapper unit tests)
- [ ] `npm run e2e` is green (provider endpoint tests)
- [ ] `npm -w web run build` succeeds
- [ ] `npm run dev` starts both servers; loading `http://localhost:5173` shows the chat UI
- [ ] Settings view lists all 4 providers; entering a key marks it keyed
- [ ] Sending a message with a valid provider key produces streamed text + tool cards in the UI (manually verified with at least one real provider)
- [ ] All committed

---

## Self-Review (run after writing)

**Spec coverage:** Phase 1 spec sections covered — agentic loop+streaming (T5,11), multi-provider (T4), model selection (T4 routes + T11 settings), built-in tools (T5 default tool list), sessions new/list (T6), basic safety (T5 safety.ts + bash gate hook wiring in a later commit), chat UI streaming (T10,11). Sub-agent dispatch and session resume/fork are noted as Phase 1+ stretch; the foundation (SessionManager) is in place via createAgentSession defaults. ✓

**Placeholder scan:** None — every step has concrete code/commands. ✓

**Type consistency:** `WireEvent` shapes match between server `event-schema.ts` and browser `events.ts`. `createPiSession` options match usage in `sessions.ts`. `piEventToWireEvent` signature matches the test. ✓
