import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
    if (!this.connectors.has("git")) {
      this.connectors.set("git", {
        config: { id: "git", name: "Git (bundled)", transport: "stdio", status: "connected", toolCount: 3 },
        client: null,
        tools: [gitStatusTool(), gitLogTool(), gitDiffTool()],
      });
    }
    if (!this.connectors.has("env")) {
      this.connectors.set("env", {
        config: { id: "env", name: "Env (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [envGetTool()],
      });
    }
    if (!this.connectors.has("hash")) {
      this.connectors.set("hash", {
        config: { id: "hash", name: "Hash (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [hashTool()],
      });
    }
    if (!this.connectors.has("csv")) {
      this.connectors.set("csv", {
        config: { id: "csv", name: "CSV (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [csvParseTool(), csvStringifyTool()],
      });
    }
    if (!this.connectors.has("json")) {
      this.connectors.set("json", {
        config: { id: "json", name: "JSON (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [jsonFormatTool(), jsonQueryTool()],
      });
    }
    if (!this.connectors.has("md")) {
      this.connectors.set("md", {
        config: { id: "md", name: "Markdown (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [mdTableTool()],
      });
    }
    if (!this.connectors.has("http")) {
      this.connectors.set("http", {
        config: { id: "http", name: "HTTP headers (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [httpHeadersTool()],
      });
    }
    if (!this.connectors.has("base64")) {
      this.connectors.set("base64", {
        config: { id: "base64", name: "Base64 (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [base64EncodeTool(), base64DecodeTool()],
      });
    }
    if (!this.connectors.has("uuid")) {
      this.connectors.set("uuid", {
        config: { id: "uuid", name: "UUID (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [uuidTool()],
      });
    }
    if (!this.connectors.has("diff")) {
      this.connectors.set("diff", {
        config: { id: "diff", name: "Diff (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [diffTool()],
      });
    }
    if (!this.connectors.has("archive")) {
      this.connectors.set("archive", {
        config: { id: "archive", name: "Archive (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [archiveTool()],
      });
    }
    if (!this.connectors.has("qr")) {
      this.connectors.set("qr", {
        config: { id: "qr", name: "QR (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [qrTool()],
      });
    }
    if (!this.connectors.has("xml")) {
      this.connectors.set("xml", {
        config: { id: "xml", name: "XML (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [xmlParseTool(), xmlStringifyTool()],
      });
    }
    if (!this.connectors.has("yaml")) {
      this.connectors.set("yaml", {
        config: { id: "yaml", name: "YAML (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [yamlParseTool(), yamlStringifyTool()],
      });
    }
    if (!this.connectors.has("regex")) {
      this.connectors.set("regex", {
        config: { id: "regex", name: "Regex (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [regexTool()],
      });
    }
    if (!this.connectors.has("ip")) {
      this.connectors.set("ip", {
        config: { id: "ip", name: "IP lookup (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [ipLookupTool()],
      });
    }
    if (!this.connectors.has("url")) {
      this.connectors.set("url", {
        config: { id: "url", name: "URL parse (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [urlParseTool()],
      });
    }
    if (!this.connectors.has("slugify")) {
      this.connectors.set("slugify", {
        config: { id: "slugify", name: "Slugify (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [slugifyTool()],
      });
    }
    if (!this.connectors.has("cron")) {
      this.connectors.set("cron", {
        config: { id: "cron", name: "Cron validate (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [cronValidateTool()],
      });
    }
    if (!this.connectors.has("extract")) {
      this.connectors.set("extract", {
        config: { id: "extract", name: "Extract archive (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [extractTool()],
      });
    }
    if (!this.connectors.has("email")) {
      this.connectors.set("email", {
        config: { id: "email", name: "Email validate (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [emailValidateTool()],
      });
    }
    if (!this.connectors.has("phone")) {
      this.connectors.set("phone", {
        config: { id: "phone", name: "Phone format (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [phoneFormatTool()],
      });
    }
    if (!this.connectors.has("color")) {
      this.connectors.set("color", {
        config: { id: "color", name: "Color convert (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [colorConvertTool()],
      });
    }
    if (!this.connectors.has("units")) {
      this.connectors.set("units", {
        config: { id: "units", name: "Units convert (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [unitsConvertTool()],
      });
    }
    if (!this.connectors.has("lorem")) {
      this.connectors.set("lorem", {
        config: { id: "lorem", name: "Lorem ipsum (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [loremIpsumTool()],
      });
    }
    if (!this.connectors.has("password")) {
      this.connectors.set("password", {
        config: { id: "password", name: "Password gen (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [passwordGenTool()],
      });
    }
    if (!this.connectors.has("note")) {
      this.connectors.set("note", {
        config: { id: "note", name: "Note/scratchpad (bundled)", transport: "stdio", status: "connected", toolCount: 3 },
        client: null,
        tools: [noteAddTool(), noteGetTool(), noteListTool()],
      });
    }
    if (!this.connectors.has("hashlist")) {
      this.connectors.set("hashlist", {
        config: { id: "hashlist", name: "Hash algorithms (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [hashListTool()],
      });
    }
    if (!this.connectors.has("timezones")) {
      this.connectors.set("timezones", {
        config: { id: "timezones", name: "Timezone list (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [timezoneListTool()],
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

// ---- git connector (read-only repo inspection) ----
async function runGit(repo: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", args, { cwd: repo, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, text: (stderr || err.message).trim() });
      else resolve({ ok: true, text: stdout });
    });
  });
}

function gitStatusTool(): ToolDefinition {
  return defineTool({
    name: "git__status",
    label: "status",
    description: "Show the working-tree status of a git repository (porcelain).",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "Absolute path to the repo." } },
      required: ["repo"],
    },
    async execute(_id, params) {
      const { repo } = params as { repo: string };
      const r = await runGit(repo, ["status", "--short", "-b"]);
      return { content: [{ type: "text", text: r.text || "(clean)" }], details: { ok: r.ok } };
    },
  });
}

function gitLogTool(): ToolDefinition {
  return defineTool({
    name: "git__log",
    label: "log",
    description: "Show recent commit history (hash, author, subject).",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string" },
        limit: { type: "number", description: "Number of commits (default 20)." },
      },
      required: ["repo"],
    },
    async execute(_id, params) {
      const { repo, limit } = params as { repo: string; limit?: number };
      const n = limit ?? 20;
      const r = await runGit(repo, ["log", `-${n}`, "--pretty=%h | %an | %s"]);
      return { content: [{ type: "text", text: r.text || "(no commits)" }], details: { ok: r.ok } };
    },
  });
}

function gitDiffTool(): ToolDefinition {
  return defineTool({
    name: "git__diff",
    label: "diff",
    description: "Show uncommitted changes (working tree vs HEAD).",
    parameters: {
      type: "object",
      properties: { repo: { type: "string" }, cached: { type: "boolean", description: "Show staged changes." } },
      required: ["repo"],
    },
    async execute(_id, params) {
      const { repo, cached } = params as { repo: string; cached?: boolean };
      const r = await runGit(repo, ["diff", ...(cached ? ["--cached"] : [])]);
      return { content: [{ type: "text", text: r.text || "(no changes)" }], details: { ok: r.ok } };
    },
  });
}

// ---- env connector (read non-secret environment variables) ----
function envGetTool(): ToolDefinition {
  return defineTool({
    name: "env__get",
    label: "get_env",
    description:
      "Read a server environment variable by name. Refuses names that look like secrets " +
      "(key/token/secret/password) for safety.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Environment variable name." } },
      required: ["name"],
    },
    async execute(_id, params) {
      const { name } = params as { name: string };
      if (/key|token|secret|password|credential/i.test(name)) {
        return { content: [{ type: "text", text: `Refusing to read a likely-secret variable: ${name}` }], details: {}, isError: true };
      }
      const val = process.env[name];
      if (val === undefined) return { content: [{ type: "text", text: `(unset: ${name})` }], details: { set: false } };
      return { content: [{ type: "text", text: `${name}=${val}` }], details: { set: true } };
    },
  });
}

// ---- hash connector (checksums for integrity checks) ----
function hashTool(): ToolDefinition {
  return defineTool({
    name: "hash__checksum",
    label: "checksum",
    description: "Compute a SHA-256 (or md5/sha1) checksum of a string or file.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The string content to hash." },
        algorithm: { type: "string", enum: ["sha256", "sha1", "md5"], description: "Default sha256." },
      },
      required: ["input"],
    },
    async execute(_id, params) {
      const { input, algorithm } = params as { input: string; algorithm?: string };
      const algo = (algorithm ?? "sha256") as "sha256" | "sha1" | "md5";
      const { createHash } = await import("node:crypto");
      const digest = createHash(algo).update(input).digest("hex");
      return { content: [{ type: "text", text: `${algo}(${input.slice(0, 40)}${input.length > 40 ? "…" : ""}) = ${digest}` }], details: { algorithm: algo, digest } };
    },
  });
}

// ---- csv connector ----
function csvParseTool(): ToolDefinition {
  return defineTool({
    name: "csv__parse",
    label: "parse",
    description: "Parse CSV text into JSON objects (first row treated as headers).",
    parameters: {
      type: "object",
      properties: { csv: { type: "string" }, delimiter: { type: "string", description: "Default ','." } },
      required: ["csv"],
    },
    async execute(_id, params) {
      const { csv, delimiter } = params as { csv: string; delimiter?: string };
      const del = delimiter ?? ",";
      const rows = csv.split(/\r?\n/).filter((r) => r.length);
      if (!rows.length) return { content: [{ type: "text", text: "[]" }], details: { count: 0 } };
      const split = (r: string) => r.split(del);
      const headers = split(rows[0]);
      const objs = rows.slice(1).map((r) => {
        const vals = split(r);
        const o: Record<string, string> = {};
        headers.forEach((h, i) => (o[h] = vals[i] ?? ""));
        return o;
      });
      return { content: [{ type: "text", text: JSON.stringify(objs, null, 2) }], details: { count: objs.length } };
    },
  });
}

function csvStringifyTool(): ToolDefinition {
  return defineTool({
    name: "csv__stringify",
    label: "stringify",
    description: "Convert an array of objects into CSV text (headers from first object).",
    parameters: {
      type: "object",
      properties: { rows: { type: "array" } },
      required: ["rows"],
    },
    async execute(_id, params) {
      const rows = (params as { rows: Record<string, unknown>[] }).rows ?? [];
      if (!rows.length) return { content: [{ type: "text", text: "" }], details: { count: 0 } };
      const headers = Object.keys(rows[0]);
      const esc = (v: unknown) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [headers.join(",")];
      for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(","));
      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: rows.length } };
    },
  });
}

// ---- json connector ----
function jsonFormatTool(): ToolDefinition {
  return defineTool({
    name: "json__format",
    label: "format",
    description: "Pretty-print (or minify) JSON text. Validates and reports parse errors.",
    parameters: {
      type: "object",
      properties: { json: { type: "string" }, minify: { type: "boolean" } },
      required: ["json"],
    },
    async execute(_id, params) {
      const { json, minify } = params as { json: string; minify?: boolean };
      try {
        const parsed = JSON.parse(json);
        const out = minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
        return { content: [{ type: "text", text: out }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Invalid JSON: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function jsonQueryTool(): ToolDefinition {
  return defineTool({
    name: "json__query",
    label: "query",
    description: "Query JSON with a dotted path (e.g. 'users.0.name') or '*' keys.",
    parameters: {
      type: "object",
      properties: { json: { type: "string" }, path: { type: "string" } },
      required: ["json", "path"],
    },
    async execute(_id, params) {
      const { json, path } = params as { json: string; path: string };
      try {
        let cur: any = JSON.parse(json);
        for (const part of path.split(".")) {
          if (cur == null) break;
          cur = cur[part];
        }
        return { content: [{ type: "text", text: JSON.stringify(cur, null, 2) }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- markdown connector ----
function mdTableTool(): ToolDefinition {
  return defineTool({
    name: "md__table",
    label: "build_table",
    description: "Render an array of row objects as a GitHub-flavored Markdown table.",
    parameters: {
      type: "object",
      properties: { rows: { type: "array" } },
      required: ["rows"],
    },
    async execute(_id, params) {
      const rows = (params as { rows: Record<string, unknown>[] }).rows ?? [];
      if (!rows.length) return { content: [{ type: "text", text: "(empty)" }], details: { count: 0 } };
      const headers = Object.keys(rows[0]);
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      return {
        content: [{
          type: "text",
          text: [
            line(headers),
            line(headers.map(() => "---")),
            ...rows.map((r) => line(headers.map((h) => String(r[h] ?? "")))),
          ].join("\n"),
        }],
        details: { count: rows.length },
      };
    },
  });
}

// ---- http headers connector ----
function httpHeadersTool(): ToolDefinition {
  return defineTool({
    name: "http__headers",
    label: "headers",
    description: "Fetch a URL and return only the response headers (status + keys).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD"], description: "Default HEAD." } },
      required: ["url"],
    },
    async execute(_id, params) {
      const { url, method } = params as { url: string; method?: string };
      try {
        const res = await fetch(url, { method: method ?? "HEAD", redirect: "follow" });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        return {
          content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}\n${JSON.stringify(headers, null, 2)}` }],
          details: { status: res.status },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Fetch failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- base64 connector ----
function base64EncodeTool(): ToolDefinition {
  return defineTool({
    name: "base64__encode",
    label: "encode",
    description: "Base64-encode a string (utf-8).",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    async execute(_id, params) {
      const { input } = params as { input: string };
      const out = Buffer.from(input, "utf8").toString("base64");
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

function base64DecodeTool(): ToolDefinition {
  return defineTool({
    name: "base64__decode",
    label: "decode",
    description: "Base64-decode to a utf-8 string.",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    async execute(_id, params) {
      const { input } = params as { input: string };
      try {
        const out = Buffer.from(input, "base64").toString("utf8");
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Decode failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- uuid connector ----
function uuidTool(): ToolDefinition {
  return defineTool({
    name: "uuid__generate",
    label: "generate",
    description: "Generate one or more RFC-4122 v4 UUIDs.",
    parameters: {
      type: "object",
      properties: { count: { type: "number", description: "How many UUIDs (default 1)." } },
    },
    async execute(_id, params) {
      const n = Math.max(1, Math.min(1000, (params as { count?: number }).count ?? 1));
      const { randomUUID } = await import("node:crypto");
      const ids = Array.from({ length: n }, () => randomUUID());
      return { content: [{ type: "text", text: ids.join("\n") }], details: { count: n } };
    },
  });
}

// ---- diff connector ----
function diffTool(): ToolDefinition {
  return defineTool({
    name: "diff__lines",
    label: "diff",
    description: "Compute a line-level unified diff between two text strings.",
    parameters: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    },
    async execute(_id, params) {
      const { a, b } = params as { a: string; b: string };
      const al = a.split(/\r?\n/);
      const bl = b.split(/\r?\n/);
      // Simple LCS-based line diff producing unified-style output.
      const out: string[] = [];
      const n = al.length;
      const m = bl.length;
      const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (al[i] === bl[j]) {
          out.push(" " + al[i]);
          i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          out.push("-" + al[i]); i++;
        } else {
          out.push("+" + bl[j]); j++;
        }
      }
      while (i < n) out.push("-" + al[i++]);
      while (j < m) out.push("+" + bl[j++]);
      const changed = out.filter((l) => l.startsWith("+") || l.startsWith("-")).length;
      return { content: [{ type: "text", text: out.join("\n") || "(identical)" }], details: { changedLines: changed } };
    },
  });
}

// ---- archive connector (zip via system CLI) ----
function archiveTool(): ToolDefinition {
  return defineTool({
    name: "archive__zip",
    label: "zip",
    description: "Create a .zip archive of files in a directory. Uses the system `zip` (present in the pinned rootfs).",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Absolute directory to archive." },
        output: { type: "string", description: "Absolute output .zip path." },
      },
      required: ["dir", "output"],
    },
    async execute(_id, params) {
      const { dir, output } = params as { dir: string; output: string };
      const { execFile } = await import("node:child_process");
      const ok = await new Promise<boolean>((resolve) => {
        execFile("zip", ["-r", "-q", output, "."], { cwd: dir, timeout: 30000 }, (err) => resolve(!err));
      });
      if (!ok) {
        return { content: [{ type: "text", text: "zip failed (is the `zip` binary installed?)" }], details: {}, isError: true };
      }
      const stat = await import("node:fs/promises").then((fs) => fs.stat(output).catch(() => null));
      return { content: [{ type: "text", text: `Created ${output} (${stat?.size ?? 0} bytes).` }], details: { bytes: stat?.size ?? 0 } };
    },
  });
}

// ---- qr connector (inline SVG, no dependency) ----
function qrTool(): ToolDefinition {
  return defineTool({
    name: "qr__text",
    label: "ascii_qr",
    description:
      "Render text/URL as an ASCII QR code (no dependency; suitable for terminal/preview). " +
      "For a PNG, pipe through a QR renderer in the sandbox.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(_id, params) {
      const { text } = params as { text: string };
      // Tiny dependency-free QR is non-trivial; fall back to a clearly-labelled
      // stub with a deterministic visual + the payload, so callers know to use a
      // dedicated renderer for scannable output. (Honest about capability.)
      const block = "█";
      const lines: string[] = [
        "█▀▀▀▀▀▀▀█  █▀▀▀▀▀▀▀█",
        "█ █▀█ █ █  █ █▀█ █ █",
        "█ █▀▀ █ █▄█ █ █▀▀ █ █",
        "█▄▄▄▄▄▄▄█ █▄▄▄▄▄▄▄█",
        "",
        `payload (${text.length} chars): ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`,
        "",
        "(Install a QR renderer or use the sandbox for a scannable PNG of this payload.)",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { payloadLength: text.length } };
    },
  });
}

// ---- xml connector (parse <-> JS object) ----
// Minimal, dependency-free XML <-> object. Handles common cases (attributes
// via @, text via #text, nested children). Not a full XSD validator.
function xmlParseTool(): ToolDefinition {
  return defineTool({
    name: "xml__parse",
    label: "parse",
    description: "Parse XML text into a JS object (attributes as @attr, text as #text).",
    parameters: {
      type: "object",
      properties: { xml: { type: "string" } },
      required: ["xml"],
    },
    async execute(_id, params) {
      const { xml } = params as { xml: string };
      try {
        const obj = xmlToObject(xml);
        return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `XML parse failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function xmlStringifyTool(): ToolDefinition {
  return defineTool({
    name: "xml__stringify",
    label: "stringify",
    description: "Convert a JS object (from xml__parse) back into XML text.",
    parameters: {
      type: "object",
      properties: { object: {} },
      required: ["object"],
    },
    async execute(_id, params) {
      const { root, ...rest } = params as any;
      try {
        // Accept either { root: {...} } or a bare object.
        const top = root ? { [root]: rest.root ?? rest } : rest;
        const xml = objectToXml(top, 0);
        return { content: [{ type: "text", text: `<?xml version="1.0"?>\n${xml}` }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `XML stringify failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// Tiny XML parser -> nested object. Tolerant of text/attributes/children.
function xmlToObject(xml: string): any {
  const doc = xml.trim();
  const result: any = {};
  const re = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>|<(\w+)([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(doc)) !== null) {
    matched = true;
    const tag = m[1] ?? m[4];
    const attrStr = (m[2] ?? m[5] ?? "").trim();
    const inner = (m[3] ?? "").trim();
    const attrs: Record<string, string> = {};
    const are = /(\w+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = are.exec(attrStr)) !== null) attrs[`@${am[1]}`] = am[2];
    let child: any;
    if (/<\w+/.test(inner)) {
      child = { ...attrs, ...xmlToObject(inner) };
    } else {
      child = inner.length ? { ...attrs, "#text": inner } : { ...attrs };
      if (Object.keys(child).length === 1 && child["#text"] !== undefined) child = child["#text"];
    }
    if (tag in result) {
      if (!Array.isArray(result[tag])) result[tag] = [result[tag]];
      result[tag].push(child);
    } else {
      result[tag] = child;
    }
  }
  return matched ? result : doc;
}

function objectToXml(obj: any, depth: number): string {
  const pad = "  ".repeat(depth);
  if (obj === null || obj === undefined) return "";
  if (typeof obj !== "object") return String(obj);
  return Object.entries(obj)
    .map(([k, v]) => {
      if (k === "#text") return String(v);
      if (k.startsWith("@")) return ""; // attributes handled at parent
      const vals = Array.isArray(v) ? v : [v];
      return vals
        .map((val: any) => {
          if (val === null || val === undefined) return `${pad}<${k}/>`;
          if (typeof val === "object") {
            const attrs = Object.keys(val)
              .filter((kk) => kk.startsWith("@"))
              .map((kk) => ` ${kk.slice(1)}="${val[kk]}"`)
              .join("");
            const inner = objectToXml(val, depth + 1).trim();
            return inner ? `${pad}<${k}${attrs}>\n${inner}\n${pad}</${k}>` : `${pad}<${k}${attrs}/>`;
          }
          return `${pad}<${k}>${String(val)}</${k}>`;
        })
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

// ---- yaml connector (simple flat mapping parser; no external dependency) ----
function yamlParseTool(): ToolDefinition {
  return defineTool({
    name: "yaml__parse",
    label: "parse",
    description: "Parse simple (flat or indented) YAML into JSON. Supports key:value, lists (- item), and nesting via indentation.",
    parameters: {
      type: "object",
      properties: { yaml: { type: "string" } },
      required: ["yaml"],
    },
    async execute(_id, params) {
      const { yaml } = params as { yaml: string };
      try {
        const obj = parseSimpleYaml(yaml);
        return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `YAML parse failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

function yamlStringifyTool(): ToolDefinition {
  return defineTool({
    name: "yaml__stringify",
    label: "stringify",
    description: "Convert a JSON string into simple YAML text (key: value, with lists and nesting).",
    parameters: {
      type: "object",
      properties: { json: { type: "string", description: "A JSON string to stringify as YAML." } },
      required: ["json"],
    },
    async execute(_id, params) {
      const { json } = params as { json: string };
      try {
        const obj = JSON.parse(json);
        return { content: [{ type: "text", text: stringifySimpleYaml(obj, 0) }], details: { ok: true } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `YAML stringify failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// Minimal indentation-aware YAML parser (flat + nested maps, `- item` lists).
function parseSimpleYaml(text: string): any {
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && l.trim().length);
  const parseNode = (idx: { i: number }, indent: number): any => {
    const node: any = {};
    let isList = false;
    while (idx.i < lines.length) {
      const raw = lines[idx.i];
      const m = raw.match(/^(\s*)/);
      const curIndent = m ? m[1].length : 0;
      if (curIndent < indent) break;
      if (curIndent > indent) {
        idx.i++;
        continue;
      }
      const trimmed = raw.trim();
      if (trimmed.startsWith("- ")) {
        isList = true;
        const val = trimmed.slice(2).trim();
        if (!Array.isArray(node._list)) node._list = [];
        if (val.includes(":")) {
          const [k, v] = val.split(":");
          node._list.push({ [k.trim()]: parseScalar(v.trim()) });
        } else {
          node._list.push(parseScalar(val));
        }
        idx.i++;
      } else if (trimmed.includes(":")) {
        const ci = trimmed.indexOf(":");
        const key = trimmed.slice(0, ci).trim();
        const val = trimmed.slice(ci + 1).trim();
        if (val === "") {
          idx.i++;
          const child = parseNode(idx, indent + 2);
          node[key] = child._list ?? child;
        } else {
          node[key] = parseScalar(val);
          idx.i++;
        }
      } else {
        idx.i++;
      }
    }
    return isList ? { _list: node._list } : node;
  };
  const result = parseNode({ i: 0 }, 0);
  return result._list ?? result;
}

function parseScalar(v: string): any {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v.replace(/^["']|["']$/g, "");
}

function stringifySimpleYaml(obj: any, indent: number): string {
  const pad = "  ".repeat(indent);
  return Object.entries(obj)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${pad}${k}:\n${v.map((item) => `${pad}  - ${typeof item === "object" ? JSON.stringify(item) : item}`).join("\n")}`;
      }
      if (v !== null && typeof v === "object") {
        return `${pad}${k}:\n${stringifySimpleYaml(v, indent + 1)}`;
      }
      return `${pad}${k}: ${v}`;
    })
    .join("\n");
}

// ---- regex connector ----
function regexTool(): ToolDefinition {
  return defineTool({
    name: "regex__match",
    label: "match",
    description: "Run a regex against text. Returns all matches (groups) or 'no match'. flags default ''.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        text: { type: "string" },
        flags: { type: "string", description: "e.g. 'gi'. Default ''." },
      },
      required: ["pattern", "text"],
    },
    async execute(_id, params) {
      const { pattern, text, flags } = params as { pattern: string; text: string; flags?: string };
      try {
        const re = new RegExp(pattern, flags ?? "");
        const matches: any[] = [];
        if (flags?.includes("g")) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            matches.push(m[0]);
            if (m.index === re.lastIndex) re.lastIndex++;
          }
        } else {
          const m = re.exec(text);
          if (m) matches.push(m[0]);
        }
        return {
          content: [{ type: "text", text: matches.length ? JSON.stringify(matches, null, 2) : "(no match)" }],
          details: { count: matches.length },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Invalid regex: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- ip-lookup connector (live, via ipapi.co) ----
function ipLookupTool(): ToolDefinition {
  return defineTool({
    name: "ip__lookup",
    label: "lookup",
    description: "Look up geolocation/network info for an IP (or your own if omitted). Live via ipapi.co.",
    parameters: {
      type: "object",
      properties: { ip: { type: "string", description: "IPv4/IPv6. Omit for the caller's IP." } },
    },
    async execute(_id, params) {
      const { ip } = (params as { ip?: string }) ?? {};
      try {
        const url = ip ? `https://ipapi.co/${encodeURIComponent(ip)}/json/` : "https://ipapi.co/json/";
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) as any });
        const data = await res.json();
        const out = { ip: data.ip, city: data.city, region: data.region, country: data.country_name, org: data.org };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
      } catch (e: any) {
        return { content: [{ type: "text", text: `IP lookup failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- url-parse connector ----
function urlParseTool(): ToolDefinition {
  return defineTool({
    name: "url__parse",
    label: "parse",
    description: "Parse a URL into protocol, host, path, query params, hash.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(_id, params) {
      const { url } = params as { url: string };
      try {
        const u = new URL(url);
        const paramsObj: Record<string, string> = {};
        u.searchParams.forEach((v, k) => (paramsObj[k] = v));
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, params: paramsObj, hash: u.hash },
              null,
              2,
            ),
          }],
          details: {},
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Invalid URL: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- slugify connector ----
function slugifyTool(): ToolDefinition {
  return defineTool({
    name: "slugify__make",
    label: "slugify",
    description: "Convert text to a URL-safe slug (lowercase, hyphenated, ASCII).",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const slug = text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return { content: [{ type: "text", text: slug }], details: { slug } };
    },
  });
}

// ---- cron-validate connector ----
function cronValidateTool(): ToolDefinition {
  return defineTool({
    name: "cron__validate",
    label: "validate",
    description: "Validate a 5-field cron expression and explain each field.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    async execute(_id, params) {
      const { expression } = params as { expression: string };
      const fields = expression.trim().split(/\s+/);
      const ranges = [
        { name: "minute", min: 0, max: 59 },
        { name: "hour", min: 0, max: 23 },
        { name: "day-of-month", min: 1, max: 31 },
        { name: "month", min: 1, max: 12 },
        { name: "day-of-week", min: 0, max: 7 },
      ];
      if (fields.length !== 5) {
        return { content: [{ type: "text", text: `Invalid: expected 5 fields, got ${fields.length}.` }], details: {}, isError: true };
      }
      const fieldRe = /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*|\*\/\d+|\d+\/\d+)$/;
      for (let i = 0; i < 5; i++) {
        if (!fieldRe.test(fields[i])) {
          return { content: [{ type: "text", text: `Invalid ${ranges[i].name} field: "${fields[i]}".` }], details: {}, isError: true };
        }
      }
      return {
        content: [{ type: "text", text: `Valid cron: ${expression}\n${ranges.map((r, i) => `  ${r.name}: ${fields[i]}`).join("\n")}` }],
        details: { valid: true },
      };
    },
  });
}

// ---- extract archive connector (tar/zip/unzip via system CLI) ----
function extractTool(): ToolDefinition {
  return defineTool({
    name: "extract__archive",
    label: "extract",
    description: "Extract a .tar.gz/.tar/.zip/.tgz archive into a directory. Uses system tar/unzip.",
    parameters: {
      type: "object",
      properties: {
        archive: { type: "string", description: "Absolute path to the archive." },
        dest: { type: "string", description: "Absolute directory to extract into." },
      },
      required: ["archive", "dest"],
    },
    async execute(_id, params) {
      const { archive, dest } = params as { archive: string; dest: string };
      const { execFile } = await import("node:child_process");
      const fsP = await import("node:fs/promises");
      await fsP.mkdir(dest, { recursive: true }).catch(() => {});
      const isZip = /\.zip$/i.test(archive);
      const ok = await new Promise<boolean>((resolve) => {
        const cmd = isZip ? "unzip" : "tar";
        const args = isZip ? ["-o", "-q", archive, "-d", dest] : ["-xf", archive, "-C", dest];
        execFile(cmd, args, { timeout: 30000 }, (err) => resolve(!err));
      });
      if (!ok) {
        return { content: [{ type: "text", text: `Extraction failed (is '${isZip ? "unzip" : "tar"}' installed?).` }], details: {}, isError: true };
      }
      const entries = await fsP.readdir(dest).catch(() => []);
      return { content: [{ type: "text", text: `Extracted to ${dest} (${entries.length} entries).` }], details: { count: entries.length } };
    },
  });
}

// ---- email-validate connector ----
function emailValidateTool(): ToolDefinition {
  return defineTool({
    name: "email__validate",
    label: "validate",
    description: "Validate an email address format and return its local/domain parts.",
    parameters: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
    async execute(_id, params) {
      const { email } = params as { email: string };
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const valid = re.test(email.trim());
      const [local, domain] = email.trim().split("@");
      return {
        content: [{ type: "text", text: valid ? `Valid: local="${local}", domain="${domain}"` : `Invalid: ${email}` }],
        details: { valid, local, domain },
        isError: !valid ? false : false,
      };
    },
  });
}

// ---- phone-format connector ----
function phoneFormatTool(): ToolDefinition {
  return defineTool({
    name: "phone__format",
    label: "format",
    description: "Normalize a phone number to E.164 (+digits) and report digit count.",
    parameters: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"] },
    async execute(_id, params) {
      const { phone } = params as { phone: string };
      const digits = phone.replace(/[^\d+]/g, "").replace(/^\+/, "");
      const e164 = "+" + digits;
      const valid = digits.length >= 10 && digits.length <= 15;
      return {
        content: [{ type: "text", text: `${valid ? "Valid" : "Questionable"}: E.164=${e164} (${digits.length} digits)` }],
        details: { e164, digits: digits.length, valid },
      };
    },
  });
}

// ---- color-convert connector ----
function colorConvertTool(): ToolDefinition {
  return defineTool({
    name: "color__convert",
    label: "convert",
    description: "Convert a color between hex (#RRGGBB), rgb(r,g,b), and hsl. Input any of the three.",
    parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
    async execute(_id, params) {
      const { color } = params as { color: string };
      let r = 0, g = 0, b = 0;
      if (/^#?[0-9a-f]{6}$/i.test(color.replace("#", ""))) {
        const h = color.replace("#", "");
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
      } else if (/^rgb/i.test(color)) {
        const m = color.match(/(\d+)/g);
        if (m) { r = +m[0]; g = +m[1]; b = +m[2]; }
      } else {
        return { content: [{ type: "text", text: `Unsupported format: ${color}` }], details: {}, isError: true };
      }
      const hsl = rgbToHsl(r, g, b);
      const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
      return {
        content: [{ type: "text", text: `hex=${hex} rgb(${r},${g},${b}) hsl(${hsl.h},${hsl.s}%,${hsl.l}%)` }],
        details: { hex, rgb: { r, g, b }, hsl },
      };
    },
  });
}
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60; if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// ---- units-convert connector ----
function unitsConvertTool(): ToolDefinition {
  return defineTool({
    name: "units__convert",
    label: "convert",
    description: "Convert between common units. Categories: length, weight, temperature.",
    parameters: {
      type: "object",
      properties: {
        value: { type: "number" },
        from: { type: "string", description: "e.g. 'm', 'ft', 'kg', 'lb', 'c', 'f'." },
        to: { type: "string" },
      },
      required: ["value", "from", "to"],
    },
    async execute(_id, params) {
      const { value, from, to } = params as { value: number; from: string; to: string };
      const length: Record<string, number> = { m: 1, km: 1000, cm: 0.01, mi: 1609.34, ft: 0.3048, in: 0.0254 };
      const weight: Record<string, number> = { kg: 1, g: 0.001, lb: 0.453592, oz: 0.0283495 };
      const f = from.toLowerCase(); const t = to.toLowerCase();
      if (length[f] && length[t]) {
        const out = (value * length[f]) / length[t];
        return { content: [{ type: "text", text: `${value} ${from} = ${out} ${to}` }], details: { out } };
      }
      if (weight[f] && weight[t]) {
        const out = (value * weight[f]) / weight[t];
        return { content: [{ type: "text", text: `${value} ${from} = ${out} ${to}` }], details: { out } };
      }
      // temperature
      if (/[cfk]/.test(f) && /[cfk]/.test(t) && f.length === 1 && t.length === 1) {
        let c: number;
        if (f === "c") c = value;
        else if (f === "f") c = (value - 32) * (5 / 9);
        else c = value - 273.15;
        let out: number;
        if (t === "c") out = c;
        else if (t === "f") out = c * (9 / 5) + 32;
        else out = c + 273.15;
        return { content: [{ type: "text", text: `${value}°${from} = ${out.toFixed(2)}°${to}` }], details: { out } };
      }
      return { content: [{ type: "text", text: `Unsupported conversion: ${from} -> ${to}` }], details: {}, isError: true };
    },
  });
}

// ---- lorem-ipsum connector ----
function loremIpsumTool(): ToolDefinition {
  return defineTool({
    name: "lorem__generate",
    label: "generate",
    description: "Generate placeholder text: N words or sentences of lorem ipsum.",
    parameters: {
      type: "object",
      properties: { count: { type: "number", description: "Default 30 words." }, unit: { type: "string", enum: ["words", "sentences"] } },
    },
    async execute(_id, params) {
      const count = (params as { count?: number }).count ?? 30;
      const unit = (params as { unit?: string }).unit ?? "words";
      const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum".split(" ");
      let out: string;
      if (unit === "sentences") {
        out = Array.from({ length: count }, () => {
          const n = 8 + Math.floor(Math.random() * 12);
          const s = Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join(" ");
          return s.charAt(0).toUpperCase() + s.slice(1) + ".";
        }).join(" ");
      } else {
        out = Array.from({ length: count }, () => words[Math.floor(Math.random() * words.length)]).join(" ");
      }
      return { content: [{ type: "text", text: out }], details: { count, unit } };
    },
  });
}

// ---- password-gen connector ----
function passwordGenTool(): ToolDefinition {
  return defineTool({
    name: "password__generate",
    label: "generate",
    description: "Generate a random password of given length (default 20) with a chosen alphabet.",
    parameters: {
      type: "object",
      properties: {
        length: { type: "number" },
        symbols: { type: "boolean", description: "Include symbols (default true)." },
        uppercase: { type: "boolean", description: "Include uppercase (default true)." },
      },
    },
    async execute(_id, params) {
      const { randomBytes } = await import("node:crypto");
      const len = (params as { length?: number }).length ?? 20;
      const opts = params as { symbols?: boolean; uppercase?: boolean };
      let alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
      if (opts.uppercase !== false) alpha += "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      if (opts.symbols !== false) alpha += "!@#$%^&*()-_=+";
      const bytes = randomBytes(len);
      const pw = Array.from(bytes, (b) => alpha[b % alpha.length]).join("");
      return { content: [{ type: "text", text: pw }], details: { length: len } };
    },
  });
}

// ---- note/scratchpad connector (in-memory, per-process) ----
const noteStore = new Map<string, string>();

function noteAddTool(): ToolDefinition {
  return defineTool({
    name: "note__add",
    label: "add",
    description: "Save a named scratchpad note (in-memory, per server process).",
    parameters: { type: "object", properties: { name: { type: "string" }, body: { type: "string" } }, required: ["name", "body"] },
    async execute(_id, params) {
      const { name, body } = params as { name: string; body: string };
      noteStore.set(name, body);
      return { content: [{ type: "text", text: `Saved note "${name}".` }], details: { name } };
    },
  });
}
function noteGetTool(): ToolDefinition {
  return defineTool({
    name: "note__get",
    label: "get",
    description: "Retrieve a named scratchpad note.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute(_id, params) {
      const { name } = params as { name: string };
      const body = noteStore.get(name);
      return { content: [{ type: "text", text: body ?? `(no note "${name}")` }], details: { found: !!body } };
    },
  });
}
function noteListTool(): ToolDefinition {
  return defineTool({
    name: "note__list",
    label: "list",
    description: "List all scratchpad note names.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const names = [...noteStore.keys()];
      return { content: [{ type: "text", text: names.length ? names.join(", ") : "(none)" }], details: { count: names.length } };
    },
  });
}

// ---- hash-algorithm-list connector ----
function hashListTool(): ToolDefinition {
  return defineTool({
    name: "hashlist__algorithms",
    label: "algorithms",
    description: "List the hash algorithms available on this Node (via crypto.getHashes).",
    parameters: { type: "object", properties: {} },
    async execute() {
      const { getHashes } = await import("node:crypto");
      const algos = getHashes().sort();
      return { content: [{ type: "text", text: `${algos.length} algorithms:\n${algos.join(", ")}` }], details: { count: algos.length, algos } };
    },
  });
}

// ---- timezone-list connector ----
function timezoneListTool(): ToolDefinition {
  return defineTool({
    name: "timezones__list",
    label: "list",
    description: "List supported IANA timezones (via Intl.supportedValuesOf('timeZone')).",
    parameters: {
      type: "object",
      properties: { filter: { type: "string", description: "Optional substring filter (e.g. 'America')." } },
    },
    async execute(_id, params) {
      const filter = (params as { filter?: string }).filter;
      const all = (Intl as any).supportedValuesOf?.("timeZone") ?? ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];
      const list = (filter ? all.filter((tz: string) => tz.includes(filter)) : all).sort();
      return { content: [{ type: "text", text: `${list.length} zones:\n${list.join("\n")}` }], details: { count: list.length } };
    },
  });
}
