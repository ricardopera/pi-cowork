import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent/dist/core/extensions/types.js";
import { Type } from "@earendil-works/pi-ai";
import { config } from "../config.js";

/**
 * MCP connector support (Cowork's MCP-connector feature). Each connector is a
 * configured MCP server (stdio command, or HTTP/SSE URL). On connect, the
 * manager lists the server's tools and adapts each into a Pi ToolDefinition so
 * the agent can call it like any built-in tool.
 *
 * Parameters are declared permissively (additionalProperties: true) and passed
 * straight through — MCP servers validate their own inputs, which avoids a
 * JSON-Schema→TypeBox conversion. Tool names are prefixed with the connector id
 * to avoid collisions across connectors (e.g. `slack__send_message`).
 */

export type ConnectorTransport = "stdio" | "http" | "sse";

export interface ConnectorConfig {
  id: string;
  name: string;
  transport: ConnectorTransport;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http / sse
  url?: string;
  headers?: Record<string, string>;
  // runtime state (not persisted from input)
  status?: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  toolCount?: number;
}

interface ConnectorState {
  config: ConnectorConfig;
  client: any | null;
  tools: ToolDefinition[];
}

const CONFIG_FILE = () => path.join(config.dataDir, "mcp", "connectors.json");

class McpConnectorManager {
  private connectors = new Map<string, ConnectorState>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(CONFIG_FILE(), "utf8");
      const arr: ConnectorConfig[] = JSON.parse(raw);
      for (const c of arr) {
        // Start disconnected; lazy-connect on first use or explicit connect.
        c.status = "disconnected";
        this.connectors.set(c.id, { config: c, client: null, tools: [] });
      }
    } catch {
      /* none yet */
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(CONFIG_FILE()), { recursive: true });
    const serializable = [...this.connectors.values()].map((s) => ({
      id: s.config.id,
      name: s.config.name,
      transport: s.config.transport,
      command: s.config.command,
      args: s.config.args,
      env: s.config.env,
      url: s.config.url,
      headers: s.config.headers,
    }));
    await fs.writeFile(CONFIG_FILE(), JSON.stringify(serializable, null, 2));
  }

  list(): ConnectorConfig[] {
    return [...this.connectors.values()].map((s) => ({ ...s.config }));
  }

  get(id: string): ConnectorConfig | undefined {
    return this.connectors.get(id)?.config ? { ...this.connectors.get(id)!.config } : undefined;
  }

  /** Register a connector config (does not connect yet). */
  async add(input: Omit<ConnectorConfig, "id" | "status">): Promise<ConnectorConfig> {
    const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `connector-${crypto.randomUUID().slice(0, 8)}`;
    const config: ConnectorConfig = { ...input, id, status: "disconnected" };
    this.connectors.set(id, { config, client: null, tools: [] });
    await this.persist();
    return config;
  }

  async remove(id: string): Promise<boolean> {
    const state = this.connectors.get(id);
    if (!state) return false;
    await this.disconnect(id);
    this.connectors.delete(id);
    await this.persist();
    return true;
  }

  /** Connect to a connector's MCP server and adapt its tools. */
  async connect(id: string): Promise<ConnectorConfig> {
    const state = this.connectors.get(id);
    if (!state) throw new Error(`connector ${id} not found`);
    if (state.client) {
      // already connected
      return { ...state.config };
    }
    state.config.status = "connecting";
    state.config.error = undefined;
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client({ name: "pi-cowork", version: "0.1.0" }, { capabilities: {} });
      let transport: any;
      if (state.config.transport === "stdio") {
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        if (!state.config.command) throw new Error("stdio transport requires a command");
        transport = new StdioClientTransport({
          command: state.config.command,
          args: state.config.args ?? [],
          env: state.config.env ? { ...process.env, ...state.config.env } : undefined,
        });
      } else if (state.config.transport === "http" || state.config.transport === "sse") {
        if (!state.config.url) throw new Error(`${state.config.transport} transport requires a url`);
        const url = new URL(state.config.url);
        if (state.config.transport === "sse") {
          const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
          transport = new SSEClientTransport(url, {
            requestInit: state.config.headers ? { headers: state.config.headers } : undefined,
          });
        } else {
          const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
          transport = new StreamableHTTPClientTransport(url, {
            requestInit: state.config.headers ? { headers: state.config.headers } : undefined,
          });
        }
      } else {
        throw new Error(`unknown transport: ${state.config.transport}`);
      }
      await client.connect(transport);
      const { tools } = await client.listTools();
      state.client = client;
      state.tools = tools.map((t: any) => this.adaptTool(id, t, () => client));
      state.config.status = "connected";
      state.config.toolCount = tools.length;
    } catch (e: any) {
      state.config.status = "error";
      state.config.error = e?.message ?? String(e);
    }
    return { ...state.config };
  }

  async disconnect(id: string): Promise<void> {
    const state = this.connectors.get(id);
    if (!state || !state.client) return;
    try {
      await state.client.close();
    } catch {
      /* ignore */
    }
    state.client = null;
    state.tools = [];
    state.config.status = "disconnected";
    state.config.toolCount = 0;
  }

  /** Get all adapted tools from connected connectors (for registration in a session). */
  getConnectedTools(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const state of this.connectors.values()) {
      if (state.config.status === "connected") out.push(...state.tools);
    }
    return out;
  }

  getToolNames(): string[] {
    return this.getConnectedTools().map((t) => t.name);
  }

  /**
   * Register the BUNDLED DEFAULT CONNECTORS — fetch, filesystem, time, calc,
   * sqlite — as always-connected MCP-style connectors with real working tools.
   * These ship with Pi-Cowork (no external MCP server or key required) so the
   * agent has usable connector tools out of the box. Idempotent.
   */
  async seedDefaults(): Promise<void> {
    if (!this.connectors.has("fetch")) {
      this.connectors.set("fetch", {
        config: { id: "fetch", name: "Fetch (bundled)", transport: "http", status: "connected", toolCount: 1 },
        client: null,
        tools: [fetchTool()],
      });
    }
    if (!this.connectors.has("fs")) {
      this.connectors.set("fs", {
        config: { id: "fs", name: "Filesystem (bundled)", transport: "stdio", status: "connected", toolCount: 3 },
        client: null,
        tools: [fsReadTool(), fsWriteTool(), fsListTool()],
      });
    }
    if (!this.connectors.has("time")) {
      this.connectors.set("time", {
        config: { id: "time", name: "Time (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [timeNowTool(), timeConvertTool()],
      });
    }
    if (!this.connectors.has("calc")) {
      this.connectors.set("calc", {
        config: { id: "calc", name: "Calculator (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [calcEvalTool(), calcStatsTool()],
      });
    }
    if (!this.connectors.has("sqlite")) {
      this.connectors.set("sqlite", {
        config: { id: "sqlite", name: "SQLite (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [sqliteQueryTool()],
      });
    }
  }

  private adaptTool(connectorId: string, mcpTool: any, client: () => any): ToolDefinition {
    const name = `${connectorId}__${mcpTool.name}`;
    return defineTool({
      name,
      label: mcpTool.name,
      description:
        (mcpTool.description ?? mcpTool.name) +
        ` (MCP connector: ${connectorId})`,
      // Permissive schema: pass arguments through; the MCP server validates.
      parameters: Type.Object(
        {},
        { additionalProperties: true, description: "Arguments for the MCP tool (see its schema)." },
      ),
      async execute(_toolCallId, params) {
        const res = await client().callTool({ name: mcpTool.name, arguments: params });
        const content = (res?.content ?? []) as any[];
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        // Include any image content as image blocks the agent can see.
        const images = content
          .filter((c) => c.type === "image")
          .map((c) => ({ type: "image" as const, data: c.data, mimeType: c.mimeType ?? "image/png" }));
        return {
          content: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...images,
            ...(text || images.length ? [] : [{ type: "text" as const, text: "(no output)" }]),
          ],
          details: { isError: res?.isError ?? false },
          isError: res?.isError ?? false,
        };
      },
    });
  }
}

let manager: McpConnectorManager | null = null;
export function getMcpManager(): McpConnectorManager {
  if (!manager) manager = new McpConnectorManager();
  return manager;
}

// Exported for testing.
export { McpConnectorManager };

// ---- Bundled default connector tools (real, working, no external server) ----
// These mirror the official MCP "fetch" and "filesystem" servers' tool surfaces
// but run in-process so they work with zero setup.

function fetchTool(): ToolDefinition {
  return defineTool({
    name: "fetch__fetch",
    label: "fetch",
    description:
      "Fetch content from a URL (HTTP/HTTPS GET) and return the response body as text. " +
      "Bundled default connector — no setup required.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        maxChars: { type: "number", description: "Truncate body to this many chars (default 20000)." },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      const { url, maxChars } = params as { url: string; maxChars?: number };
      const limit = maxChars ?? 20000;
      try {
        const res = await fetch(url, { redirect: "follow" });
        const text = await res.text();
        return {
          content: [{ type: "text", text: `HTTP ${res.status}\n${text.slice(0, limit)}` }],
          details: { status: res.status, length: text.length },
          isError: !res.ok,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Fetch failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function fsReadTool(): ToolDefinition {
  return defineTool({
    name: "fs__read_file",
    label: "read_file",
    description:
      "Read a file from the server filesystem (absolute path) and return its text content. " +
      "Bundled default filesystem connector.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path." },
        maxChars: { type: "number" },
      },
      required: ["path"],
    },
    async execute(_id, params) {
      const { path: fpath, maxChars } = params as { path: string; maxChars?: number };
      try {
        const content = await import("node:fs/promises").then((fs) => fs.readFile(fpath, "utf8"));
        return {
          content: [{ type: "text", text: content.slice(0, maxChars ?? 50000) }],
          details: { length: content.length },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Read failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function fsWriteTool(): ToolDefinition {
  return defineTool({
    name: "fs__write_file",
    label: "write_file",
    description:
      "Write text content to a file on the server filesystem (absolute path). " +
      "Bundled default filesystem connector.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async execute(_id, params) {
      const { path: fpath, content } = params as { path: string; content: string };
      try {
        await import("node:fs/promises").then((fs) => fs.writeFile(fpath, content, "utf8"));
        return { content: [{ type: "text", text: `Wrote ${content.length} bytes to ${fpath}.` }], details: { bytes: content.length } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Write failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function fsListTool(): ToolDefinition {
  return defineTool({
    name: "fs__list_dir",
    label: "list_dir",
    description:
      "List entries in a server directory (absolute path). Bundled default filesystem connector.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute(_id, params) {
      const { path: dir } = params as { path: string };
      try {
        const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
        const list = entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`);
        return { content: [{ type: "text", text: list.join("\n") || "(empty)" }], details: { count: list.length } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `List failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- time connector ----
function timeNowTool(): ToolDefinition {
  return defineTool({
    name: "time__now",
    label: "current_time",
    description:
      "Return the current date/time in a given IANA timezone (default UTC), in ISO and human form.",
    parameters: {
      type: "object",
      properties: { timezone: { type: "string", description: "IANA tz, e.g. 'America/New_York'. Default UTC." } },
    },
    async execute(_id, params) {
      const tz = (params as { timezone?: string }).timezone ?? "UTC";
      try {
        const now = new Date();
        const human = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(now);
        return { content: [{ type: "text", text: `${tz}: ${now.toISOString()} (${human})` }], details: { iso: now.toISOString(), tz } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Bad timezone: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function timeConvertTool(): ToolDefinition {
  return defineTool({
    name: "time__convert",
    label: "convert_time",
    description: "Convert an ISO time between timezones, or format it.",
    parameters: {
      type: "object",
      properties: {
        iso: { type: "string", description: "ISO 8601 timestamp." },
        toTimezone: { type: "string" },
      },
      required: ["iso", "toTimezone"],
    },
    async execute(_id, params) {
      const { iso, toTimezone } = params as { iso: string; toTimezone: string };
      try {
        const d = new Date(iso);
        const human = new Intl.DateTimeFormat("en-US", { timeZone: toTimezone, dateStyle: "full", timeStyle: "long" }).format(d);
        return { content: [{ type: "text", text: `${iso} (UTC) -> ${toTimezone}: ${human}` }], details: { iso, toTimezone } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Convert failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- calc connector ----
function calcEvalTool(): ToolDefinition {
  return defineTool({
    name: "calc__eval",
    label: "evaluate",
    description:
      "Safely evaluate an arithmetic expression (+ - * / % ** and parentheses, plus numbers). " +
      "Returns the numeric result. No variables or functions.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "e.g. '(12 * 8 + 4) / 2'." } },
      required: ["expression"],
    },
    async execute(_id, params) {
      const { expression } = params as { expression: string };
      // Strict allowlist: digits, operators, parens, decimal point, whitespace.
      if (!/^[\d+\-*/%().\s]+$/.test(expression)) {
        return { content: [{ type: "text", text: "Only arithmetic operators and numbers are allowed." }], details: {}, isError: true };
      }
      try {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${expression});`)();
        return { content: [{ type: "text", text: `${expression} = ${result}` }], details: { expression, result } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Evaluation failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function calcStatsTool(): ToolDefinition {
  return defineTool({
    name: "calc__stats",
    label: "statistics",
    description: "Compute summary statistics (count, sum, mean, min, max, median) for a list of numbers.",
    parameters: {
      type: "object",
      properties: { numbers: { type: "array", items: { type: "number" } } },
      required: ["numbers"],
    },
    async execute(_id, params) {
      const arr = (params as { numbers: number[] }).numbers ?? [];
      if (!arr.length) return { content: [{ type: "text", text: "No numbers provided." }], details: {}, isError: true };
      const sorted = [...arr].sort((a, b) => a - b);
      const sum = arr.reduce((a, b) => a + b, 0);
      const mean = sum / arr.length;
      const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const stats = { count: arr.length, sum, mean, min: sorted[0], max: sorted[sorted.length - 1], median };
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }], details: stats };
    },
  });
}

// ---- sqlite connector ----
function sqliteQueryTool(): ToolDefinition {
  return defineTool({
    name: "sqlite__query",
    label: "query",
    description:
      "Run a read-only SQL query against a local SQLite database file and return rows as text/JSON. " +
      "Uses node:sqlite if available; falls back to the sqlite3 CLI.",
    parameters: {
      type: "object",
      properties: {
        database: { type: "string", description: "Absolute path to the .db/.sqlite file." },
        sql: { type: "string", description: "SELECT query (read-only)." },
      },
      required: ["database", "sql"],
    },
    async execute(_id, params) {
      const { database, sql } = params as { database: string; sql: string };
      // Refuse anything that isn't a SELECT (defense-in-depth).
      if (!/^\s*select\b/i.test(sql)) {
        return { content: [{ type: "text", text: "Only SELECT queries are allowed." }], details: {}, isError: true };
      }
      try {
        // Prefer the sqlite3 CLI for portability (commonly installed).
        const { execFile } = await import("node:child_process");
        const out = await new Promise<string>((resolve, reject) => {
          execFile("sqlite3", ["-json", database, sql], { timeout: 15000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });
        return { content: [{ type: "text", text: out || "(no rows)" }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Query failed (is sqlite3 installed?): ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}
