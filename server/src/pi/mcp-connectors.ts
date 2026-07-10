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
   * Register the BUNDLED DEFAULT CONNECTORS — fetch and filesystem — as
   * always-connected MCP-style connectors with real working tools. These ship
   * with Pi-Cowork (no external MCP server or key required) so the agent has
   * usable connector tools out of the box. Idempotent.
   */
  async seedDefaults(): Promise<void> {
    if (!this.connectors.has("fetch")) {
      this.connectors.set("fetch", {
        config: {
          id: "fetch",
          name: "Fetch (bundled)",
          transport: "http",
          status: "connected",
          toolCount: 1,
        },
        client: null,
        tools: [fetchTool()],
      });
    }
    if (!this.connectors.has("fs")) {
      this.connectors.set("fs", {
        config: {
          id: "fs",
          name: "Filesystem (bundled)",
          transport: "stdio",
          status: "connected",
          toolCount: 3,
        },
        client: null,
        tools: [fsReadTool(), fsWriteTool(), fsListTool()],
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
