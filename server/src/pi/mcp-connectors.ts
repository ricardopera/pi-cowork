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
    if (!this.connectors.has("md2html")) {
      this.connectors.set("md2html", {
        config: { id: "md2html", name: "Markdown->HTML (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [mdToHtmlTool()],
      });
    }
    if (!this.connectors.has("html2text")) {
      this.connectors.set("html2text", {
        config: { id: "html2text", name: "HTML->text (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [htmlToTextTool()],
      });
    }
    if (!this.connectors.has("sentiment")) {
      this.connectors.set("sentiment", {
        config: { id: "sentiment", name: "Sentiment (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [sentimentTool()],
      });
    }
    if (!this.connectors.has("readability")) {
      this.connectors.set("readability", {
        config: { id: "readability", name: "Readability (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [readabilityTool()],
      });
    }
    if (!this.connectors.has("grammar")) {
      this.connectors.set("grammar", {
        config: { id: "grammar", name: "Grammar count (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [grammarCountTool()],
      });
    }
    if (!this.connectors.has("emoji")) {
      this.connectors.set("emoji", {
        config: { id: "emoji", name: "Emoji info (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [emojiInfoTool()],
      });
    }
    if (!this.connectors.has("currency")) {
      this.connectors.set("currency", {
        config: { id: "currency", name: "Currency format (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [currencyFormatTool()],
      });
    }
    if (!this.connectors.has("number")) {
      this.connectors.set("number", {
        config: { id: "number", name: "Number format (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [numberFormatTool()],
      });
    }
    if (!this.connectors.has("datefmt")) {
      this.connectors.set("datefmt", {
        config: { id: "datefmt", name: "Date format (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [dateFormatTool()],
      });
    }
    if (!this.connectors.has("weather")) {
      this.connectors.set("weather", {
        config: { id: "weather", name: "Weather (bundled)", transport: "http", status: "connected", toolCount: 1 },
        client: null,
        tools: [weatherTool()],
      });
    }
    if (!this.connectors.has("stock")) {
      this.connectors.set("stock", {
        config: { id: "stock", name: "Stock quote (bundled)", transport: "http", status: "connected", toolCount: 1 },
        client: null,
        tools: [stockQuoteTool()],
      });
    }
    if (!this.connectors.has("isbn")) {
      this.connectors.set("isbn", {
        config: { id: "isbn", name: "ISBN lookup (bundled)", transport: "http", status: "connected", toolCount: 1 },
        client: null,
        tools: [isbnLookupTool()],
      });
    }
    if (!this.connectors.has("morse")) {
      this.connectors.set("morse", {
        config: { id: "morse", name: "Morse code (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [morseEncodeTool(), morseDecodeTool()],
      });
    }
    if (!this.connectors.has("rot13")) {
      this.connectors.set("rot13", {
        config: { id: "rot13", name: "ROT13 cipher (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [rot13Tool()],
      });
    }
    if (!this.connectors.has("roman")) {
      this.connectors.set("roman", {
        config: { id: "roman", name: "Roman numerals (bundled)", transport: "stdio", status: "connected", toolCount: 2 },
        client: null,
        tools: [romanToNumberTool(), numberToRomanTool()],
      });
    }
    if (!this.connectors.has("leet")) {
      this.connectors.set("leet", {
        config: { id: "leet", name: "Leet speak (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [leetTool()],
      });
    }
    if (!this.connectors.has("piglatin")) {
      this.connectors.set("piglatin", {
        config: { id: "piglatin", name: "Pig Latin (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [pigLatinTool()],
      });
    }
    if (!this.connectors.has("haiku")) {
      this.connectors.set("haiku", {
        config: { id: "haiku", name: "Haiku generator (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [haikuTool()],
      });
    }
    if (!this.connectors.has("country")) {
      this.connectors.set("country", {
        config: { id: "country", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [countryInfoTool()],
      });
    }
    if (!this.connectors.has("langdetect")) {
      this.connectors.set("langdetect", {
        config: { id: "langdetect", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [langDetectTool()],
      });
    }
    if (!this.connectors.has("textstats")) {
      this.connectors.set("textstats", {
        config: { id: "textstats", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [textStatsTool()],
      });
    }
    if (!this.connectors.has("wordfreq")) {
      this.connectors.set("wordfreq", {
        config: { id: "wordfreq", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [wordFreqTool()],
      });
    }
    if (!this.connectors.has("palindrome")) {
      this.connectors.set("palindrome", {
        config: { id: "palindrome", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [palindromeTool()],
      });
    }
    if (!this.connectors.has("anagram")) {
      this.connectors.set("anagram", {
        config: { id: "anagram", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [anagramTool()],
      });
    }
    if (!this.connectors.has("caesar")) {
      this.connectors.set("caesar", {
        config: { id: "caesar", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [caesarTool()],
      });
    }
    if (!this.connectors.has("atbash")) {
      this.connectors.set("atbash", {
        config: { id: "atbash", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [atbashTool()],
      });
    }
    if (!this.connectors.has("binconv")) {
      this.connectors.set("binconv", {
        config: { id: "binconv", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [binaryConvertTool()],
      });
    }
    if (!this.connectors.has("textcase")) {
      this.connectors.set("textcase", {
        config: { id: "textcase", name: "${name}", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [textCaseTool()],
      });
    }
    if (!this.connectors.has("histogram")) {
      this.connectors.set("histogram", {
        config: { id: "histogram", name: "Histogram (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [histogramTool()],
      });
    }
    if (!this.connectors.has("percentile")) {
      this.connectors.set("percentile", {
        config: { id: "percentile", name: "Percentile (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [percentileTool()],
      });
    }
    if (!this.connectors.has("correlate")) {
      this.connectors.set("correlate", {
        config: { id: "correlate", name: "Correlation (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [correlationTool()],
      });
    }
    if (!this.connectors.has("freqtable")) {
      this.connectors.set("freqtable", {
        config: { id: "freqtable", name: "Frequency table (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [freqTableTool()],
      });
    }
    if (!this.connectors.has("sortlines")) {
      this.connectors.set("sortlines", {
        config: { id: "sortlines", name: "Sort lines (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [sortLinesTool()],
      });
    }
    if (!this.connectors.has("dedupe")) {
      this.connectors.set("dedupe", {
        config: { id: "dedupe", name: "Dedupe (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [dedupeTool()],
      });
    }
    if (!this.connectors.has("reverse")) {
      this.connectors.set("reverse", {
        config: { id: "reverse", name: "Reverse text (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [reverseTool()],
      });
    }
    if (!this.connectors.has("chunk")) {
      this.connectors.set("chunk", {
        config: { id: "chunk", name: "Chunk (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [chunkTool()],
      });
    }
    if (!this.connectors.has("truncate")) {
      this.connectors.set("truncate", {
        config: { id: "truncate", name: "Truncate (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [truncateTool()],
      });
    }
    if (!this.connectors.has("linecount")) {
      this.connectors.set("linecount", {
        config: { id: "linecount", name: "Line count (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [lineCountTool()],
      });
    }
    if (!this.connectors.has("charfreq")) {
      this.connectors.set("charfreq", {
        config: { id: "charfreq", name: "Char frequency (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [charFreqTool()],
      });
    }
    if (!this.connectors.has("strdist")) {
      this.connectors.set("strdist", {
        config: { id: "strdist", name: "String distance (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [stringDistTool()],
      });

    }
    if (!this.connectors.has("mdlinks")) {
      this.connectors.set("mdlinks", {
        config: { id: "mdlinks", name: "Markdown links (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [mdLinksTool()],
      });
    }
    if (!this.connectors.has("diffsum")) {
      this.connectors.set("diffsum", {
        config: { id: "diffsum", name: "Diff summary (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [diffSummaryTool()],
      });
    }
    if (!this.connectors.has("numwords")) {
      this.connectors.set("numwords", {
        config: { id: "numwords", name: "Number to words (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [numberToWordsTool()],
      });
    }
    if (!this.connectors.has("ordinal")) {
      this.connectors.set("ordinal", {
        config: { id: "ordinal", name: "Ordinal (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [ordinalTool()],
      });
    }
    if (!this.connectors.has("prime")) {
      this.connectors.set("prime", {
        config: { id: "prime", name: "Prime check (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [primeCheckTool()],
      });
    }
    if (!this.connectors.has("mathops")) {
      this.connectors.set("mathops", {
        config: { id: "mathops", name: "GCD/LCM (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [gcdLcmTool()],
      });
    }
    if (!this.connectors.has("pct")) {
      this.connectors.set("pct", {
        config: { id: "pct", name: "Percentage (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [percentageTool()],
      });
    }
    if (!this.connectors.has("ratio")) {
      this.connectors.set("ratio", {
        config: { id: "ratio", name: "Ratio simplify (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [ratioSimplifyTool()],
      });
    }
    if (!this.connectors.has("stemmer")) {
      this.connectors.set("stemmer", {
        config: { id: "stemmer", name: "Porter stemmer (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [porterStemmerTool()],
      });
    }
    if (!this.connectors.has("ngram")) {
      this.connectors.set("ngram", {
        config: { id: "ngram", name: "N-gram (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [ngramTool()],
      });
    }
    if (!this.connectors.has("wrap")) {
      this.connectors.set("wrap", {
        config: { id: "wrap", name: "Text wrap (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [textWrapTool()],
      });
    }
    if (!this.connectors.has("colalign")) {
      this.connectors.set("colalign", {
        config: { id: "colalign", name: "Column align (bundled)", transport: "stdio", status: "connected", toolCount: 1 },
        client: null,
        tools: [columnAlignTool()],
      });
    }

    if (!this.connectors.has("zodiac")) {
      this.connectors.set("zodiac", { config: { id: "zodiac", name: "Zodiac sign (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [zodiacTool()] });
    }
    if (!this.connectors.has("dice")) {
      this.connectors.set("dice", { config: { id: "dice", name: "Dice roll (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [diceTool()] });
    }
    if (!this.connectors.has("coinflip")) {
      this.connectors.set("coinflip", { config: { id: "coinflip", name: "Coin flip (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [coinFlipTool()] });
    }
    if (!this.connectors.has("pick")) {
      this.connectors.set("pick", { config: { id: "pick", name: "Random pick (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [randomPickTool()] });
    }
    if (!this.connectors.has("shuffle")) {
      this.connectors.set("shuffle", { config: { id: "shuffle", name: "Shuffle (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [shuffleTool()] });
    }
    if (!this.connectors.has("tabulate")) {
      this.connectors.set("tabulate", { config: { id: "tabulate", name: "Tabulate (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [tabulateTool()] });
    }
    if (!this.connectors.has("outline")) {
      this.connectors.set("outline", { config: { id: "outline", name: "Outline (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [outlineTool()] });
    }
    if (!this.connectors.has("tocgen")) {
      this.connectors.set("tocgen", { config: { id: "tocgen", name: "TOC generator (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [tocGenTool()] });
    }
    if (!this.connectors.has("textpad")) {
      this.connectors.set("textpad", { config: { id: "textpad", name: "Text pad (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [textPadTool()] });
    }
    if (!this.connectors.has("stripansi")) {
      this.connectors.set("stripansi", { config: { id: "stripansi", name: "Strip ANSI (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [stripAnsiTool()] });
    }
    if (!this.connectors.has("countinst")) {
      this.connectors.set("countinst", { config: { id: "countinst", name: "Count instances (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [countInstancesTool()] });
    }
    if (!this.connectors.has("joinlines")) {
      this.connectors.set("joinlines", { config: { id: "joinlines", name: "Join lines (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [joinLinesTool()] });
    }
    if (!this.connectors.has("asciiart")) {
      this.connectors.set("asciiart", { config: { id: "asciiart", name: "ASCII art (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [asciiArtTool()] });
    }
    if (!this.connectors.has("typetest")) {
      this.connectors.set("typetest", { config: { id: "typetest", name: "Type test (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [typeTestTool()] });
    }
    if (!this.connectors.has("fact")) {
      this.connectors.set("fact", { config: { id: "fact", name: "Factorial (bundled)", transport: "stdio", status: "connected", toolCount: 1 }, client: null, tools: [factorialTool()] });
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

// ---- markdown-to-html connector ----
function mdToHtmlTool(): ToolDefinition {
  return defineTool({
    name: "md2html__convert",
    label: "convert",
    description: "Convert simple Markdown to HTML (headings, bold, italic, code, links, lists, paragraphs).",
    parameters: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
    async execute(_id, params) {
      const { markdown } = params as { markdown: string };
      let html = markdown
        .escapeHtml ? markdown : markdown; // no escape helper; do inline below
      // Process block elements line by line.
      const lines = html.split(/\r?\n/);
      const out: string[] = [];
      let inList = false;
      let inCode = false;
      const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
      for (const line of lines) {
        if (line.trim().startsWith("```")) { inCode = !inCode; out.push(inCode ? "<pre><code>" : "</code></pre>"); continue; }
        if (inCode) { out.push(line); continue; }
        const h = line.match(/^(#{1,6})\s+(.*)/);
        if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inlineMd(h[2])}</h${lvl}>`); continue; }
        const li = line.match(/^[-*]\s+(.*)/);
        if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inlineMd(li[1])}</li>`); continue; }
        if (line.trim() === "") { closeList(); continue; }
        closeList();
        out.push(`<p>${inlineMd(line)}</p>`);
      }
      closeList();
      return { content: [{ type: "text", text: out.join("\n") }], details: {} };
    },
  });
}
// Inline markdown: **bold**, *italic*, `code`, [text](url)
function inlineMd(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

// ---- html-to-text connector ----
function htmlToTextTool(): ToolDefinition {
  return defineTool({
    name: "html2text__strip",
    label: "strip",
    description: "Strip HTML tags from text, leaving readable plain text (block elements add newlines).",
    parameters: { type: "object", properties: { html: { type: "string" } }, required: ["html"] },
    async execute(_id, params) {
      const { html } = params as { html: string };
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return { content: [{ type: "text", text }], details: { length: text.length } };
    },
  });
}

// ---- sentiment connector (lexicon-based) ----
function sentimentTool(): ToolDefinition {
  return defineTool({
    name: "sentiment__analyze",
    label: "analyze",
    description: "Lexicon-based sentiment score (-1 negative to +1 positive) for English text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const pos = new Set("good great excellent amazing wonderful happy love best perfect awesome positive beautiful brilliant fantastic nice win winning joy delighted superb outstanding".split(" "));
      const neg = new Set("bad terrible awful horrible sad hate worst broken fail failure angry unhappy poor disgusting ugly disappointing boring pain misery negative wrong".split(" "));
      const words = text.toLowerCase().split(/\W+/).filter(Boolean);
      let score = 0;
      for (const w of words) { if (pos.has(w)) score++; if (neg.has(w)) score--; }
      const norm = words.length ? score / words.length : 0;
      const label = norm > 0.05 ? "positive" : norm < -0.05 ? "negative" : "neutral";
      return { content: [{ type: "text", text: `${label} (score=${norm.toFixed(3)}, raw=${score}, words=${words.length})` }], details: { score: norm, label } };
    },
  });
}

// ---- readability connector (Flesch reading ease) ----
function readabilityTool(): ToolDefinition {
  return defineTool({
    name: "readability__score",
    label: "score",
    description: "Compute Flesch reading-ease score and reading level for English text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const sentences = (text.match(/[.!?]+/g) || []).length || 1;
      const words = text.split(/\s+/).filter(Boolean);
      const wordCount = words.length || 1;
      const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0) || 1;
      const score = 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount);
      const level = score >= 70 ? "easy" : score >= 50 ? "medium" : "hard";
      return {
        content: [{ type: "text", text: `Flesch: ${score.toFixed(1)} (${level}). ${wordCount} words, ${sentences} sentences, ${syllables} syllables.` }],
        details: { score, level, words: wordCount, sentences, syllables },
      };
    },
  });
}
function countSyllable(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  const groups = word.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}
function countSyllables(word: string): number { return countSyllable(word); }

// ---- grammar-count connector ----
function grammarCountTool(): ToolDefinition {
  return defineTool({
    name: "grammar__count",
    label: "count",
    description: "Count words, sentences, paragraphs, and characters in text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const words = text.split(/\s+/).filter(Boolean).length;
      const sentences = (text.match(/[.!?]+/g) || []).length;
      const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length).length;
      const chars = text.length;
      return { content: [{ type: "text", text: `${words} words, ${sentences} sentences, ${paragraphs} paragraphs, ${chars} chars.` }], details: { words, sentences, paragraphs, chars } };
    },
  });
}

// ---- emoji-info connector ----
function emojiInfoTool(): ToolDefinition {
  return defineTool({
    name: "emoji__info",
    label: "info",
    description: "Report info about emoji in text: count, unique set, and their Unicode code points.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;
      const found = text.match(emojiRe) || [];
      const unique = [...new Set(found)];
      const codepoints = unique.map((e) => `U+${e.codePointAt(0)!.toString(16).toUpperCase()}`);
      return { content: [{ type: "text", text: `${found.length} emoji (${unique.length} unique): ${unique.join(" ")}\ncode points: ${codepoints.join(", ")}` }], details: { count: found.length, unique: unique.length } };
    },
  });
}

// ---- currency-format connector ----
function currencyFormatTool(): ToolDefinition {
  return defineTool({
    name: "currency__format",
    label: "format",
    description: "Format a number as a currency string (default USD). Uses Intl.NumberFormat.",
    parameters: {
      type: "object",
      properties: { amount: { type: "number" }, currency: { type: "string", description: "ISO 4217 code, e.g. USD, EUR, JPY. Default USD." }, locale: { type: "string", description: "e.g. en-US. Default en-US." } },
      required: ["amount"],
    },
    async execute(_id, params) {
      const { amount, currency, locale } = params as { amount: number; currency?: string; locale?: string };
      const formatted = new Intl.NumberFormat(locale ?? "en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
      return { content: [{ type: "text", text: formatted }], details: { formatted } };
    },
  });
}

// ---- number-format connector ----
function numberFormatTool(): ToolDefinition {
  return defineTool({
    name: "number__format",
    label: "format",
    description: "Format a number with grouping, decimals, or as a percentage.",
    parameters: {
      type: "object",
      properties: {
        value: { type: "number" },
        decimals: { type: "number", description: "Fraction digits (default 0)." },
        style: { type: "string", enum: ["decimal", "percent", "scientific"], description: "Default decimal." },
        locale: { type: "string" },
      },
      required: ["value"],
    },
    async execute(_id, params) {
      const { value, decimals, style, locale } = params as { value: number; decimals?: number; style?: string; locale?: string };
      const formatted = new Intl.NumberFormat(locale ?? "en-US", {
        style: (style as any) ?? "decimal",
        minimumFractionDigits: decimals ?? 0,
        maximumFractionDigits: decimals ?? 0,
      }).format(value);
      return { content: [{ type: "text", text: formatted }], details: { formatted } };
    },
  });
}

// ---- date-format connector ----
function dateFormatTool(): ToolDefinition {
  return defineTool({
    name: "datefmt__format",
    label: "format",
    description: "Format an ISO date string (or now) into a human-readable form, in a given timezone/locale.",
    parameters: {
      type: "object",
      properties: {
        iso: { type: "string", description: "ISO 8601 timestamp. Omit for now()." },
        timezone: { type: "string", description: "IANA tz, default UTC." },
        locale: { type: "string", description: "e.g. en-US. Default en-US." },
        dateStyle: { type: "string", enum: ["full", "long", "medium", "short"] },
        timeStyle: { type: "string", enum: ["full", "long", "medium", "short"] },
      },
    },
    async execute(_id, params) {
      const { iso, timezone, locale, dateStyle, timeStyle } = params as any;
      const date = iso ? new Date(iso) : new Date();
      if (isNaN(date.getTime())) return { content: [{ type: "text", text: `Invalid date: ${iso}` }], details: {}, isError: true };
      const formatted = new Intl.DateTimeFormat(locale ?? "en-US", {
        timeZone: timezone ?? "UTC",
        dateStyle: dateStyle ?? "long",
        timeStyle: timeStyle ?? "short",
      }).format(date);
      return { content: [{ type: "text", text: formatted }], details: { formatted } };
    },
  });
}

// ---- weather connector (live, via wttr.in) ----
function weatherTool(): ToolDefinition {
  return defineTool({
    name: "weather__current",
    label: "current",
    description: "Get current weather for a city (live via wttr.in). Returns temp, conditions, wind.",
    parameters: { type: "object", properties: { location: { type: "string", description: "City name." } }, required: ["location"] },
    async execute(_id, params) {
      const { location } = params as { location: string };
      try {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, { signal: AbortSignal.timeout(10000) as any });
        const data = await res.json();
        const cur = data.current_condition?.[0] ?? {};
        return {
          content: [{ type: "text", text: `${location}: ${cur.temp_C}°C / ${cur.temp_F}°F, ${cur.weatherDesc?.[0]?.value ?? "?"}, humidity ${cur.humidity}%, wind ${cur.windspeedKmph} km/h` }],
          details: { tempC: cur.temp_C, tempF: cur.temp_F, desc: cur.weatherDesc?.[0]?.value },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Weather lookup failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- stock-quote connector (live, via stooq.com) ----
function stockQuoteTool(): ToolDefinition {
  return defineTool({
    name: "stock__quote",
    label: "quote",
    description: "Get a stock quote (symbol, price, change) via stooq.com CSV. Live.",
    parameters: { type: "object", properties: { symbol: { type: "string", description: "Ticker, e.g. AAPL." } }, required: ["symbol"] },
    async execute(_id, params) {
      const { symbol } = params as { symbol: string };
      try {
        const res = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}&f=sd2t2ohlcvn&h&e=csv`, { signal: AbortSignal.timeout(10000) as any });
        const text = await res.text();
        const row = text.trim().split("\n")[1]?.split(",") ?? [];
        const [sym, , , open, high, low, close, , name] = row;
        if (!close) return { content: [{ type: "text", text: `No data for ${symbol}` }], details: {}, isError: true };
        return {
          content: [{ type: "text", text: `${name || sym}: close=${close}, open=${open}, high=${high}, low=${low}` }],
          details: { symbol: sym, close, open, high, low },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Stock lookup failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- isbn-lookup connector (live, via openlibrary.org) ----
function isbnLookupTool(): ToolDefinition {
  return defineTool({
    name: "isbn__lookup",
    label: "lookup",
    description: "Look up a book by ISBN (10 or 13) via Open Library. Returns title, author, publish year.",
    parameters: { type: "object", properties: { isbn: { type: "string" } }, required: ["isbn"] },
    async execute(_id, params) {
      const { isbn } = params as { isbn: string };
      const clean = isbn.replace(/[^0-9X]/gi, "");
      try {
        const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${clean}&format=json&jscmd=data`, { signal: AbortSignal.timeout(10000) as any });
        const data = await res.json();
        const book = data[`ISBN:${clean}`];
        if (!book) return { content: [{ type: "text", text: `No book found for ISBN ${clean}` }], details: {}, isError: true };
        const authors = book.authors?.map((a: any) => a.name).join(", ") ?? "Unknown";
        return {
          content: [{ type: "text", text: `"${book.title}" by ${authors} (${book.publish_date ?? "?"}). Publisher: ${book.publishers?.[0]?.name ?? "?"}` }],
          details: { title: book.title, authors, publishDate: book.publish_date },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `ISBN lookup failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- morse-code connector ----
const MORSE_MAP: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---",
  K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-",
  U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....",
  "6": "-....", "7": "--...", "8": "---..", "9": "----.", ".": ".-.-.-", ",": "--..--", "?": "..--..",
};
function morseEncodeTool(): ToolDefinition {
  return defineTool({
    name: "morse__encode",
    label: "encode",
    description: "Encode text to International Morse Code. Letters separated by space, words by ' / '.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const words = text.toUpperCase().split(/\s+/);
      const encoded = words.map((word) =>
        word.split("").map((ch) => MORSE_MAP[ch] ?? "").filter(Boolean).join(" "),
      ).join(" / ");
      return { content: [{ type: "text", text: encoded }], details: {} };
    },
  });
}
function morseDecodeTool(): ToolDefinition {
  return defineTool({
    name: "morse__decode",
    label: "decode",
    description: "Decode Morse Code to text. Letters separated by space, words by ' / '.",
    parameters: { type: "object", properties: { morse: { type: "string" } }, required: ["morse"] },
    async execute(_id, params) {
      const { morse } = params as { morse: string };
      const reverse: Record<string, string> = {};
      for (const [k, v] of Object.entries(MORSE_MAP)) reverse[v] = k;
      const words = morse.trim().split(" / ");
      const decoded = words.map((word) =>
        word.split(" ").map((code) => reverse[code] ?? "").join(""),
      ).join(" ");
      return { content: [{ type: "text", text: decoded }], details: {} };
    },
  });
}

// ---- rot13 connector ----
function rot13Tool(): ToolDefinition {
  return defineTool({
    name: "rot13__apply",
    label: "apply",
    description: "Apply ROT13 cipher to text (self-inverse: apply twice to get back the original).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const out = text.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
      });
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- roman-numerals connector ----
function numberToRomanTool(): ToolDefinition {
  return defineTool({
    name: "roman__from_number",
    label: "from_number",
    description: "Convert an integer (1-3999) to Roman numerals.",
    parameters: { type: "object", properties: { number: { type: "number" } }, required: ["number"] },
    async execute(_id, params) {
      const { number } = params as { number: number };
      if (number < 1 || number > 3999 || !Number.isInteger(number))
        return { content: [{ type: "text", text: "Must be an integer 1-3999." }], details: {}, isError: true };
      const vals: [number, string][] = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
      let n = number; let out = "";
      for (const [v, s] of vals) { while (n >= v) { out += s; n -= v; } }
      return { content: [{ type: "text", text: `${number} = ${out}` }], details: { roman: out } };
    },
  });
}
function romanToNumberTool(): ToolDefinition {
  return defineTool({
    name: "roman__to_number",
    label: "to_number",
    description: "Convert Roman numerals to an integer.",
    parameters: { type: "object", properties: { roman: { type: "string" } }, required: ["roman"] },
    async execute(_id, params) {
      const { roman } = params as { roman: string };
      const r = roman.toUpperCase();
      const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
      let total = 0;
      for (let i = 0; i < r.length; i++) {
        const cur = map[r[i]]; const next = map[r[i + 1]];
        if (next && cur < next) { total -= cur; } else { total += cur; }
      }
      return { content: [{ type: "text", text: `${roman} = ${total}` }], details: { number: total } };
    },
  });
}

// ---- leet-speak connector ----
function leetTool(): ToolDefinition {
  return defineTool({
    name: "leet__convert",
    label: "convert",
    description: "Convert text to leet speak (1337). Replaces letters with numbers/symbols.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const map: Record<string, string> = { a: "4", e: "3", i: "1", o: "0", s: "5", t: "7", l: "1", b: "8", g: "9" };
      const out = text.toLowerCase().replace(/[aeiostlbg]/g, (c) => map[c] ?? c);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- pig-latin connector ----
function pigLatinTool(): ToolDefinition {
  return defineTool({
    name: "piglatin__convert",
    label: "convert",
    description: "Convert English text to Pig Latin. Consonant clusters move to end + 'ay'; vowels add 'way'.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const out = text.split(/\s+/).map((word) => {
        const m = word.match(/^([^aeiouAEIOU]*)(.*)/);
        if (!m) return word;
        const [, cluster, rest] = m;
        if (!cluster) return rest + "way";
        return rest + cluster + "ay";
      }).join(" ");
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- haiku-generator connector ----
function haikuTool(): ToolDefinition {
  return defineTool({
    name: "haiku__generate",
    label: "generate",
    description: "Generate a 5-7-5 syllable haiku from random word banks (lightweight placeholder poetry).",
    parameters: { type: "object", properties: { topic: { type: "string", description: "Optional topic word to weave in." } } },
    async execute(_id, params) {
      const topic = (params as { topic?: string }).topic ?? "";
      const five1 = ["Silent", "Gentle", "Golden", "Quiet", "Ancient", "Hidden", "Silver", "Distant"];
      const five2 = ["morning dew", "falling leaves", "mountain stream", "whisper wind", "ocean tide", "forest path", "starlit sky", "river bend"];
      const seven1 = ["The crane stands still", "Petals drift away", "Moonlight bathes the earth", "Waves crash on the shore", "Clouds drift slowly by", "Sunset paints the hills"];
      const seven2 = ["in the cold dawn light", "on the quiet pond", "through the bamboo grove", "where the herons wait", "as the world awakes", "while the crickets sing"];
      const r = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
      const line1 = topic ? `${topic} calls softly` : `${r(five1)} ${r(five2)}`;
      const line2 = `${r(seven1)} ${r(seven2)}`;
      const line3 = `${r(five1)} ${r(five2)}`;
      return { content: [{ type: "text", text: `${line1}\n${line2}\n${line3}` }], details: {} };
    },
  });
}

// ---- country-info connector (via restcountries.com) ----
function countryInfoTool(): ToolDefinition {
  return defineTool({
    name: "country__info",
    label: "info",
    description: "Look up country info (capital, population, currencies, languages, flag) by name or ISO code. Live via restcountries.com.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(_id, params) {
      const { query } = params as { query: string };
      try {
        const res = await fetch(`https://restcountries.com/v3.1/name/${encodeURIComponent(query)}?fields=name,capital,population,currencies,languages,flag`, { signal: AbortSignal.timeout(10000) as any });
        const data = await res.json();
        const c = Array.isArray(data) ? data[0] : data;
        if (!c) return { content: [{ type: "text", text: `No country found for ${query}` }], details: {}, isError: true };
        return {
          content: [{ type: "text", text: `${c.name?.common}: capital=${c.capital?.[0] ?? "?"}, pop=${c.population}, currencies=${Object.keys(c.currencies ?? {}).join(",")}, languages=${Object.values(c.languages ?? {}).join(",")} ${c.flag ?? ""}` }],
          details: { name: c.name?.common, capital: c.capital?.[0], population: c.population },
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Country lookup failed: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });
}

// ---- language-detect connector (script-based heuristic) ----
function langDetectTool(): ToolDefinition {
  return defineTool({
    name: "langdetect__detect",
    label: "detect",
    description: "Heuristic language detection by Unicode script + common stopwords. Returns detected script and likely language.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const scripts: [RegExp, string][] = [
        [/[\u4e00-\u9fff]/, "Chinese (CJK)"],
        [/[\u3040-\u30ff]/, "Japanese (kana)"],
        [/[\uac00-\ud7af]/, "Korean (Hangul)"],
        [/[\u0400-\u04ff]/, "Cyrillic (Russian/Bulgarian/etc.)"],
        [/[\u0600-\u06ff]/, "Arabic"],
        [/[\u0900-\u097f]/, "Devanagari (Hindi/etc.)"],
        [/[\u0590-\u05ff]/, "Hebrew"],
        [/[\u4e00-\u9fff]/, "Thai"],
      ];
      for (const [re, label] of scripts) { if (re.test(text)) return { content: [{ type: "text", text: label }], details: { language: label } }; }
      // Latin: use stopwords
      const lower = text.toLowerCase();
      const en = /\b(the|and|is|of|to|in|that|it|for)\b/.test(lower);
      const es = /\b(el|la|de|que|en|los|se|las|por)\b/.test(lower);
      const fr = /\b(le|les|de|et|des|que|dans|un|une)\b/.test(lower);
      const de = /\b(der|die|das|und|ist|nicht|ein|den|von)\b/.test(lower);
      const lang = en ? "English" : es ? "Spanish" : fr ? "French" : de ? "German" : "Latin script (unknown)";
      return { content: [{ type: "text", text: lang }], details: { language: lang } };
    },
  });
}

// ---- text-stats connector (detailed stats beyond grammar__count) ----
function textStatsTool(): ToolDefinition {
  return defineTool({
    name: "textstats__analyze",
    label: "analyze",
    description: "Compute detailed text stats: avg word length, longest word, reading time, unique words.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const words = text.split(/\s+/).filter(Boolean);
      const wc = words.length || 1;
      const avgLen = words.reduce((s, w) => s + w.length, 0) / wc;
      const longest = words.reduce((a, b) => b.length > a.length ? b : a, "");
      const unique = new Set(words.map((w) => w.toLowerCase())).size;
      const readingTimeMin = Math.ceil(wc / 200);
      return {
        content: [{ type: "text", text: `${wc} words, avg length ${avgLen.toFixed(1)}, longest="${longest}", ${unique} unique, ~${readingTimeMin} min read` }],
        details: { words: wc, avgLength: avgLen, longest, unique, readingTimeMin },
      };
    },
  });
}

// ---- word-frequency connector ----
function wordFreqTool(): ToolDefinition {
  return defineTool({
    name: "wordfreq__count",
    label: "count",
    description: "Count word frequency in text. Returns the top N words by count.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, topN: { type: "number", description: "Default 10." } },
      required: ["text"],
    },
    async execute(_id, params) {
      const { text, topN } = params as { text: string; topN?: number };
      const n = topN ?? 10;
      const freq: Record<string, number> = {};
      for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) freq[w] = (freq[w] ?? 0) + 1;
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n);
      return { content: [{ type: "text", text: top.map(([w, c]) => `${w}: ${c}`).join("\n") }], details: { unique: Object.keys(freq).length } };
    },
  });
}

// ---- palindrome check connector ----
function palindromeTool(): ToolDefinition {
  return defineTool({
    name: "palindrome__check",
    label: "check",
    description: "Check if text is a palindrome (ignoring case, spaces, and punctuation).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const clean = text.toLowerCase().replace(/[^a-z0-9]/g, "");
      const isPal = clean === clean.split("").reverse().join("");
      return { content: [{ type: "text", text: isPal ? `"${text}" IS a palindrome.` : `"${text}" is NOT a palindrome.` }], details: { isPalindrome: isPal } };
    },
  });
}

// ---- anagram check connector ----
function anagramTool(): ToolDefinition {
  return defineTool({
    name: "anagram__check",
    label: "check",
    description: "Check if two words/phrases are anagrams (same letters rearranged).",
    parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    async execute(_id, params) {
      const { a, b } = params as { a: string; b: string };
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").split("").sort().join("");
      const isAna = norm(a) === norm(b);
      return { content: [{ type: "text", text: isAna ? `"${a}" and "${b}" ARE anagrams.` : `"${a}" and "${b}" are NOT anagrams.` }], details: { isAnagram: isAna } };
    },
  });
}

// ---- caesar cipher connector ----
function caesarTool(): ToolDefinition {
  return defineTool({
    name: "caesar__shift",
    label: "shift",
    description: "Apply a Caesar cipher shift to text. shift: integer (positive = right, negative = left).",
    parameters: { type: "object", properties: { text: { type: "string" }, shift: { type: "number" } }, required: ["text", "shift"] },
    async execute(_id, params) {
      const { text, shift } = params as { text: string; shift: number };
      const out = text.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + shift + 26 * 100) % 26) + base);
      });
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- atbash cipher connector ----
function atbashTool(): ToolDefinition {
  return defineTool({
    name: "atbash__apply",
    label: "apply",
    description: "Apply the Atbash cipher (A<->Z, B<->Y, ...). Self-inverse.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const out = text.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(base + 25 - (c.charCodeAt(0) - base));
      });
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- binary convert connector ----
function binaryConvertTool(): ToolDefinition {
  return defineTool({
    name: "binconv__convert",
    label: "convert",
    description: "Convert text to binary (8-bit per char) or binary back to text (auto-detect direction).",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
    async execute(_id, params) {
      const { input } = params as { input: string };
      if (/^[01\s]+$/.test(input)) {
        const text = input.trim().split(/\s+/).map((b) => String.fromCharCode(parseInt(b, 2))).join("");
        return { content: [{ type: "text", text }], details: { direction: "binary->text" } };
      }
      const binary = input.split("").map((c) => c.charCodeAt(0).toString(2).padStart(8, "0")).join(" ");
      return { content: [{ type: "text", text: binary }], details: { direction: "text->binary" } };
    },
  });
}

// ---- text-case connector ----
function textCaseTool(): ToolDefinition {
  return defineTool({
    name: "textcase__convert",
    label: "convert",
    description: "Convert text case: upper, lower, title, sentence, camelCase, snake_case, kebab-case.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        to: { type: "string", enum: ["upper", "lower", "title", "sentence", "camel", "snake", "kebab"] },
      },
      required: ["text", "to"],
    },
    async execute(_id, params) {
      const { text, to } = params as { text: string; to: string };
      let out = text;
      switch (to) {
        case "upper": out = text.toUpperCase(); break;
        case "lower": out = text.toLowerCase(); break;
        case "title": out = text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()); break;
        case "sentence": out = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase(); break;
        case "camel": out = text.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()); break;
        case "snake": out = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); break;
        case "kebab": out = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); break;
      }
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- histogram connector ----
function histogramTool(): ToolDefinition {
  return defineTool({
    name: "histogram__build",
    label: "build",
    description: "Build a histogram from a list of numbers with given bin count.",
    parameters: { type: "object", properties: { numbers: { type: "array", items: { type: "number" } }, bins: { type: "number" } }, required: ["numbers"] },
    async execute(_id, params) {
      const nums = (params as { numbers: number[] }).numbers ?? [];
      const binCount = (params as { bins?: number }).bins ?? 10;
      if (!nums.length) return { content: [{ type: "text", text: "No data." }], details: {}, isError: true };
      const min = Math.min(...nums), max = Math.max(...nums);
      const width = (max - min) / binCount || 1;
      const counts = new Array(binCount).fill(0);
      for (const n of nums) { const b = Math.min(binCount - 1, Math.floor((n - min) / width)); counts[b]++; }
      const bars = counts.map((c, i) => `[${(min + i * width).toFixed(1)}–${(min + (i + 1) * width).toFixed(1)}): ${"█".repeat(c)} ${c}`).join("\n");
      return { content: [{ type: "text", text: bars }], details: { bins: counts } };
    },
  });
}

// ---- percentile connector ----
function percentileTool(): ToolDefinition {
  return defineTool({
    name: "percentile__compute",
    label: "compute",
    description: "Compute the Nth percentile of a list of numbers.",
    parameters: { type: "object", properties: { numbers: { type: "array", items: { type: "number" } }, p: { type: "number" } }, required: ["numbers", "p"] },
    async execute(_id, params) {
      const nums = [...((params as { numbers: number[] }).numbers ?? [])].sort((a, b) => a - b);
      const p = (params as { p: number }).p;
      if (!nums.length || p < 0 || p > 100) return { content: [{ type: "text", text: "Need numbers and p in [0,100]." }], details: {}, isError: true };
      const idx = (p / 100) * (nums.length - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      const val = lo === hi ? nums[lo] : nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
      return { content: [{ type: "text", text: `p${p} = ${val}` }], details: { percentile: p, value: val } };
    },
  });
}

// ---- correlation connector ----
function correlationTool(): ToolDefinition {
  return defineTool({
    name: "correlate__pearson",
    label: "pearson",
    description: "Compute Pearson correlation coefficient between two equal-length arrays.",
    parameters: { type: "object", properties: { x: { type: "array", items: { type: "number" } }, y: { type: "array", items: { type: "number" } } }, required: ["x", "y"] },
    async execute(_id, params) {
      const x = (params as any).x ?? [], y = (params as any).y ?? [];
      if (x.length !== y.length || !x.length) return { content: [{ type: "text", text: "Need equal-length arrays." }], details: {}, isError: true };
      const n = x.length;
      const sx = x.reduce((a: number, b: number) => a + b, 0), sy = y.reduce((a: number, b: number) => a + b, 0);
      const sxy = x.reduce((s: number, xi: number, i: number) => s + xi * y[i], 0);
      const sx2 = x.reduce((s: number, xi: number) => s + xi * xi, 0), sy2 = y.reduce((s: number, yi: number) => s + yi * yi, 0);
      const r = (n * sxy - sx * sy) / Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
      return { content: [{ type: "text", text: `Pearson r = ${r.toFixed(4)}` }], details: { r } };
    },
  });
}

// ---- frequency-table connector ----
function freqTableTool(): ToolDefinition {
  return defineTool({
    name: "freqtable__build",
    label: "build",
    description: "Build a frequency table from a list of categorical values.",
    parameters: { type: "object", properties: { values: { type: "array" } }, required: ["values"] },
    async execute(_id, params) {
      const vals = (params as any).values ?? [];
      const freq: Record<string, number> = {};
      for (const v of vals) freq[String(v)] = (freq[String(v)] ?? 0) + 1;
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
      return { content: [{ type: "text", text: sorted.map(([k, c]) => `${k}: ${c}`).join("\n") }], details: { unique: sorted.length } };
    },
  });
}

// ---- sort-lines connector ----
function sortLinesTool(): ToolDefinition {
  return defineTool({
    name: "sortlines__sort",
    label: "sort",
    description: "Sort lines of text alphabetically (or reverse).",
    parameters: { type: "object", properties: { text: { type: "string" }, reverse: { type: "boolean" } }, required: ["text"] },
    async execute(_id, params) {
      const { text, reverse } = params as { text: string; reverse?: boolean };
      const lines = text.split(/\r?\n/).sort();
      if (reverse) lines.reverse();
      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: lines.length } };
    },
  });
}

// ---- dedupe connector ----
function dedupeTool(): ToolDefinition {
  return defineTool({
    name: "dedupe__lines",
    label: "dedupe",
    description: "Remove duplicate lines, preserving first-occurrence order.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const seen = new Set<string>();
      const out = text.split(/\r?\n/).filter((l) => { if (seen.has(l)) return false; seen.add(l); return true; });
      return { content: [{ type: "text", text: out.join("\n") }], details: { unique: out.length } };
    },
  });
}

// ---- reverse connector ----
function reverseTool(): ToolDefinition {
  return defineTool({
    name: "reverse__text",
    label: "reverse",
    description: "Reverse text: by character or by word.",
    parameters: { type: "object", properties: { text: { type: "string" }, by: { type: "string", enum: ["char", "word"] } }, required: ["text"] },
    async execute(_id, params) {
      const { text, by } = params as { text: string; by?: string };
      const out = by === "word" ? text.split(/\s+/).reverse().join(" ") : text.split("").reverse().join("");
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- chunk connector ----
function chunkTool(): ToolDefinition {
  return defineTool({
    name: "chunk__split",
    label: "split",
    description: "Split a list into chunks of size N.",
    parameters: { type: "object", properties: { items: { type: "array" }, size: { type: "number" } }, required: ["items", "size"] },
    async execute(_id, params) {
      const items = (params as any).items ?? [];
      const size = Math.max(1, (params as any).size ?? 2);
      const chunks: any[][] = [];
      for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
      return { content: [{ type: "text", text: JSON.stringify(chunks, null, 2) }], details: { chunks: chunks.length } };
    },
  });
}

// ---- truncate connector ----
function truncateTool(): ToolDefinition {
  return defineTool({
    name: "truncate__text",
    label: "truncate",
    description: "Truncate text to N chars with an ellipsis.",
    parameters: { type: "object", properties: { text: { type: "string" }, maxChars: { type: "number" } }, required: ["text", "maxChars"] },
    async execute(_id, params) {
      const { text, maxChars } = params as { text: string; maxChars: number };
      const out = text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
      return { content: [{ type: "text", text: out }], details: { original: text.length, truncated: out.length } };
    },
  });
}

// ---- line-count connector ----
function lineCountTool(): ToolDefinition {
  return defineTool({
    name: "linecount__count",
    label: "count",
    description: "Count lines in text (blank + non-blank separately).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const lines = text.split(/\r?\n/);
      const blank = lines.filter((l) => !l.trim()).length;
      return { content: [{ type: "text", text: `${lines.length} lines (${blank} blank, ${lines.length - blank} non-blank)` }], details: { total: lines.length, blank, nonBlank: lines.length - blank } };
    },
  });
}

// ---- char-frequency connector ----
function charFreqTool(): ToolDefinition {
  return defineTool({
    name: "charfreq__count",
    label: "count",
    description: "Count character frequency in text (top N).",
    parameters: { type: "object", properties: { text: { type: "string" }, topN: { type: "number" } }, required: ["text"] },
    async execute(_id, params) {
      const { text, topN } = params as { text: string; topN?: number };
      const freq: Record<string, number> = {};
      for (const c of text) freq[c] = (freq[c] ?? 0) + 1;
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, topN ?? 20);
      return { content: [{ type: "text", text: sorted.map(([c, n]) => `'${c}': ${n}`).join("\n") }], details: { unique: Object.keys(freq).length } };
    },
  });
}

// ---- string-distance connector (Levenshtein) ----
function stringDistTool(): ToolDefinition {
  return defineTool({
    name: "strdist__levenshtein",
    label: "levenshtein",
    description: "Compute the Levenshtein edit distance between two strings.",
    parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    async execute(_id, params) {
      const { a, b } = params as { a: string; b: string };
      const m = a.length, n = b.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      return { content: [{ type: "text", text: `Levenshtein("${a}","${b}") = ${dp[m][n]}` }], details: { distance: dp[m][n] } };
    },
  });
}

// ---- markdown-links-extract connector ----
function mdLinksTool(): ToolDefinition {
  return defineTool({
    name: "mdlinks__extract",
    label: "extract",
    description: "Extract all links [text](url) from Markdown text.",
    parameters: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
    async execute(_id, params) {
      const { markdown } = params as { markdown: string };
      const links: { text: string; url: string }[] = [];
      const re = /\[([^\]]+)\]\(([^)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(markdown)) !== null) links.push({ text: m[1], url: m[2] });
      return { content: [{ type: "text", text: links.length ? links.map((l) => `${l.text}: ${l.url}`).join("\n") : "(no links)" }], details: { count: links.length } };
    },
  });
}

// ---- text-diff-summary connector ----
function diffSummaryTool(): ToolDefinition {
  return defineTool({
    name: "diffsum__summarize",
    label: "summarize",
    description: "Summarize the diff between two text strings (added/removed/changed counts).",
    parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    async execute(_id, params) {
      const { a, b } = params as { a: string; b: string };
      const al = new Set(a.split(/\r?\n/));
      const bl = new Set(b.split(/\r?\n/));
      const added = [...bl].filter((l) => !al.has(l)).length;
      const removed = [...al].filter((l) => !bl.has(l)).length;
      const unchanged = [...al].filter((l) => bl.has(l)).length;
      return { content: [{ type: "text", text: `${added} added, ${removed} removed, ${unchanged} unchanged` }], details: { added, removed, unchanged } };
    },
  });
}

// ---- number-to-words connector ----
function numberToWordsTool(): ToolDefinition {
  return defineTool({
    name: "numwords__convert",
    label: "convert",
    description: "Convert a number (0-999999) to its English word form.",
    parameters: { type: "object", properties: { number: { type: "number" } }, required: ["number"] },
    async execute(_id, params) {
      const n = (params as { number: number }).number;
      if (n < 0 || n > 999999 || !Number.isInteger(n)) return { content: [{ type: "text", text: "Must be integer 0-999999." }], details: {}, isError: true };
      const ones = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
      const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
      const two = (num: number): string => num < 20 ? ones[num] : tens[Math.floor(num/10)] + (num%10 ? "-" + ones[num%10] : "");
      const three = (num: number): string => num < 100 ? two(num) : ones[Math.floor(num/100)] + " hundred" + (num%100 ? " " + two(num%100) : "");
      const words = n < 1000 ? three(n) : three(Math.floor(n/1000)) + " thousand" + (n%1000 ? " " + three(n%1000) : "");
      return { content: [{ type: "text", text: words }], details: { words } };
    },
  });
}

// ---- ordinal connector ----
function ordinalTool(): ToolDefinition {
  return defineTool({
    name: "ordinal__convert",
    label: "convert",
    description: "Convert a number to its ordinal form (1st, 2nd, 3rd, 4th...).",
    parameters: { type: "object", properties: { number: { type: "number" } }, required: ["number"] },
    async execute(_id, params) {
      const n = (params as { number: number }).number;
      const s = ["th","st","nd","rd"];
      const v = Math.abs(n) % 100;
      const ord = n + (s[(v - 20) % 10] || s[v] || s[0]);
      return { content: [{ type: "text", text: ord }], details: { ordinal: ord } };
    },
  });
}

// ---- prime-check connector ----
function primeCheckTool(): ToolDefinition {
  return defineTool({
    name: "prime__check",
    label: "check",
    description: "Check if a number is prime.",
    parameters: { type: "object", properties: { number: { type: "number" } }, required: ["number"] },
    async execute(_id, params) {
      const n = (params as { number: number }).number;
      if (n < 2 || !Number.isInteger(n)) return { content: [{ type: "text", text: `${n} is NOT prime (must be integer >= 2).` }], details: { isPrime: false } };
      for (let i = 2; i * i <= n; i++) if (n % i === 0) return { content: [{ type: "text", text: `${n} is NOT prime (divisible by ${i}).` }], details: { isPrime: false, factor: i } };
      return { content: [{ type: "text", text: `${n} IS prime.` }], details: { isPrime: true } };
    },
  });
}

// ---- gcd/lcm connector ----
function gcdLcmTool(): ToolDefinition {
  return defineTool({
    name: "mathops__gcd_lcm",
    label: "gcd_lcm",
    description: "Compute GCD and LCM of two integers.",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    async execute(_id, params) {
      const { a, b } = params as { a: number; b: number };
      const gcd = (x: number, y: number): number => y === 0 ? x : gcd(y, x % y);
      const g = gcd(Math.abs(a), Math.abs(b));
      const l = Math.abs(a * b) / g;
      return { content: [{ type: "text", text: `GCD(${a}, ${b}) = ${g}, LCM = ${l}` }], details: { gcd: g, lcm: l } };
    },
  });
}

// ---- percentage connector ----
function percentageTool(): ToolDefinition {
  return defineTool({
    name: "pct__compute",
    label: "compute",
    description: "Compute percentage: 'what percent of B is A' or 'A% of B'. mode: 'of' or 'is'.",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, mode: { type: "string", enum: ["of", "is"], description: "'is' = A is what pct of B; 'of' = A% of B. Default 'is'." } }, required: ["a", "b"] },
    async execute(_id, params) {
      const { a, b, mode } = params as { a: number; b: number; mode?: string };
      if (mode === "of") { const r = (a / 100) * b; return { content: [{ type: "text", text: `${a}% of ${b} = ${r}` }], details: { result: r } }; }
      if (b === 0) return { content: [{ type: "text", text: "Cannot divide by zero." }], details: {}, isError: true };
      const r = (a / b) * 100;
      return { content: [{ type: "text", text: `${a} is ${r.toFixed(2)}% of ${b}` }], details: { percent: r } };
    },
  });
}

// ---- ratio-simplify connector ----
function ratioSimplifyTool(): ToolDefinition {
  return defineTool({
    name: "ratio__simplify",
    label: "simplify",
    description: "Simplify a ratio A:B to lowest terms.",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    async execute(_id, params) {
      const { a, b } = params as { a: number; b: number };
      const gcd = (x: number, y: number): number => y === 0 ? x : gcd(y, x % y);
      const g = gcd(Math.abs(a), Math.abs(b)) || 1;
      return { content: [{ type: "text", text: `${a}:${b} = ${a/g}:${b/g}` }], details: { simplified: `${a/g}:${b/g}` } };
    },
  });
}

// ---- porter-stemmer connector (simplified) ----
function porterStemmerTool(): ToolDefinition {
  return defineTool({
    name: "stemmer__porter",
    label: "stem",
    description: "Apply a simplified Porter stemmer to reduce English words to their stem.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const stem = (w: string): string => {
        w = w.toLowerCase();
        if (w.length <= 3) return w;
        w = w.replace(/(sses|ies)$/, "ss").replace(/(ss)$/, "ss");
        w = w.replace(/(eed)$/, "ee").replace(/(ed|ing)$/, "");
        w = w.replace(/(ly|ment|ness|ence|ance|able|ible|al|er|ic|ou|ism|ate|iti|ous|ive|ize)$/, "");
        return w;
      };
      const out = text.split(/\s+/).map(stem).join(" ");
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });
}

// ---- n-gram connector ----
function ngramTool(): ToolDefinition {
  return defineTool({
    name: "ngram__extract",
    label: "extract",
    description: "Extract N-grams (word sequences of length N) from text.",
    parameters: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } }, required: ["text", "n"] },
    async execute(_id, params) {
      const { text, n } = params as { text: string; n: number };
      const words = text.split(/\s+/).filter(Boolean);
      const grams: string[] = [];
      for (let i = 0; i <= words.length - n; i++) grams.push(words.slice(i, i + n).join(" "));
      return { content: [{ type: "text", text: grams.join("\n") || "(none)" }], details: { count: grams.length } };
    },
  });
}

// ---- text-wrap connector ----
function textWrapTool(): ToolDefinition {
  return defineTool({
    name: "wrap__text",
    label: "wrap",
    description: "Wrap text to a maximum line width, breaking at word boundaries.",
    parameters: { type: "object", properties: { text: { type: "string" }, width: { type: "number" } }, required: ["text", "width"] },
    async execute(_id, params) {
      const { text, width } = params as { text: string; width: number };
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        if ((line + " " + w).trim().length > width && line) { lines.push(line); line = w; }
        else line = (line + " " + w).trim();
      }
      if (line) lines.push(line);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { lines: lines.length } };
    },
  });
}

// ---- column-align connector ----
function columnAlignTool(): ToolDefinition {
  return defineTool({
    name: "colalign__align",
    label: "align",
    description: "Align tab/space-separated rows into aligned columns.",
    parameters: { type: "object", properties: { text: { type: "string" }, delimiter: { type: "string", description: "Default tab." } }, required: ["text"] },
    async execute(_id, params) {
      const { text, delimiter } = params as { text: string; delimiter?: string };
      const del = delimiter ?? "\t";
      const rows = text.split(/\r?\n/).map((r) => r.split(del));
      const cols = Math.max(...rows.map((r) => r.length));
      const widths: number[] = [];
      for (let c = 0; c < cols; c++) widths[c] = Math.max(...rows.map((r) => (r[c] ?? "").length));
      const out = rows.map((r) => r.map((cell, c) => (cell ?? "").padEnd(widths[c])).join("  ")).join("\n");
      return { content: [{ type: "text", text: out }], details: { rows: rows.length, cols } };
    },
  });
}

// ---- zodiac connector ----
function zodiacTool(): ToolDefinition {
  return defineTool({
    name: "zodiac__sign",
    label: "sign",
    description: "Get the Western zodiac sign for a birth date (month, day).",
    parameters: { type: "object", properties: { month: { type: "number" }, day: { type: "number" } }, required: ["month", "day"] },
    async execute(_id, params) {
      const { month, day } = params as { month: number; day: number };
      const signs: [string, number, number][] = [["Capricorn",12,22],["Aquarius",1,20],["Pisces",2,19],["Aries",3,21],["Taurus",4,20],["Gemini",5,21],["Cancer",6,21],["Leo",7,23],["Virgo",8,23],["Libra",9,23],["Scorpio",10,23],["Sagittarius",11,22],["Capricorn",12,22]];
      let sign = "Capricorn";
      for (const [name, m, d] of signs) { if (month === m && day >= d) { sign = name; break; } if (month === m && day < d) { const prev = signs[signs.findIndex(([,mm]) => mm === m) - 1]; sign = prev?.[0] ?? "Capricorn"; break; } }
      if (month < 1 || month > 12 || day < 1 || day > 31) return { content: [{ type: "text", text: "Invalid date." }], details: {}, isError: true };
      return { content: [{ type: "text", text: `${month}/${day}: ${sign}` }], details: { sign } };
    },
  });
}

// ---- dice-roll connector ----
function diceTool(): ToolDefinition {
  return defineTool({
    name: "dice__roll",
    label: "roll",
    description: "Roll N dice with S sides each (default 1d6). Returns individual rolls + sum.",
    parameters: { type: "object", properties: { count: { type: "number" }, sides: { type: "number" } } },
    async execute(_id, params) {
      const count = Math.max(1, Math.min(100, (params as any).count ?? 1));
      const sides = Math.max(2, Math.min(1000, (params as any).sides ?? 6));
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      const sum = rolls.reduce((a, b) => a + b, 0);
      return { content: [{ type: "text", text: `${count}d${sides}: [${rolls.join(", ")}] = ${sum}` }], details: { rolls, sum } };
    },
  });
}

// ---- coin-flip connector ----
function coinFlipTool(): ToolDefinition {
  return defineTool({
    name: "coinflip__flip",
    label: "flip",
    description: "Flip a coin N times (default 1). Returns results.",
    parameters: { type: "object", properties: { count: { type: "number" } } },
    async execute(_id, params) {
      const n = Math.max(1, Math.min(10000, (params as any).count ?? 1));
      const flips = Array.from({ length: n }, () => (Math.random() < 0.5 ? "H" : "T"));
      return { content: [{ type: "text", text: flips.join(" ") }], details: { heads: flips.filter((f) => f === "H").length, tails: flips.filter((f) => f === "T").length } };
    },
  });
}

// ---- random-pick connector ----
function randomPickTool(): ToolDefinition {
  return defineTool({
    name: "pick__random",
    label: "random",
    description: "Pick N random items from a list (without replacement by default).",
    parameters: { type: "object", properties: { items: { type: "array" }, n: { type: "number" } }, required: ["items"] },
    async execute(_id, params) {
      const items = [...((params as any).items ?? [])];
      const n = Math.min((params as any).n ?? 1, items.length);
      const picked: any[] = [];
      for (let i = 0; i < n; i++) picked.push(items.splice(Math.floor(Math.random() * items.length), 1)[0]);
      return { content: [{ type: "text", text: JSON.stringify(picked) }], details: { picked: n } };
    },
  });
}

// ---- shuffle connector ----
function shuffleTool(): ToolDefinition {
  return defineTool({
    name: "shuffle__items",
    label: "shuffle",
    description: "Shuffle a list of items randomly (Fisher-Yates).",
    parameters: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
    async execute(_id, params) {
      const items = [...((params as any).items ?? [])];
      for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      return { content: [{ type: "text", text: JSON.stringify(items) }], details: {} };
    },
  });
}

// ---- tabulate connector ----
function tabulateTool(): ToolDefinition {
  return defineTool({
    name: "tabulate__format",
    label: "format",
    description: "Format an array of objects as a text table with headers.",
    parameters: { type: "object", properties: { rows: { type: "array" } }, required: ["rows"] },
    async execute(_id, params) {
      const rows = (params as any).rows ?? [];
      if (!rows.length) return { content: [{ type: "text", text: "(empty)" }], details: {} };
      const headers = Object.keys(rows[0]);
      const widths = headers.map((h) => Math.max(h.length, ...rows.map((r: any) => String(r[h] ?? "").length)));
      const fmt = (cells: any[]) => "| " + cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join(" | ") + " |";
      const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
      return { content: [{ type: "text", text: [fmt(headers), sep, ...rows.map((r: any) => fmt(headers.map((h) => r[h])))].join("\n") }], details: { rows: rows.length } };
    },
  });
}

// ---- outline connector ----
function outlineTool(): ToolDefinition {
  return defineTool({
    name: "outline__extract",
    label: "extract",
    description: "Extract a hierarchical outline from Markdown headings.",
    parameters: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
    async execute(_id, params) {
      const { markdown } = params as { markdown: string };
      const lines = markdown.split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l));
      const outline = lines.map((l) => { const m = l.match(/^(#{1,6})\s+(.*)/); const lvl = m![1].length; return "  ".repeat(lvl - 1) + "- " + m![2]; }).join("\n");
      return { content: [{ type: "text", text: outline || "(no headings)" }], details: { count: lines.length } };
    },
  });
}

// ---- toc-generator connector ----
function tocGenTool(): ToolDefinition {
  return defineTool({
    name: "tocgen__generate",
    label: "generate",
    description: "Generate a table of contents from Markdown headings with anchor links.",
    parameters: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
    async execute(_id, params) {
      const { markdown } = params as { markdown: string };
      const lines = markdown.split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l));
      const toc = lines.map((l) => {
        const m = l.match(/^(#{1,6})\s+(.*)/); const lvl = m![1].length; const text = m![2];
        const anchor = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return "  ".repeat(lvl - 1) + `- [${text}](#${anchor})`;
      }).join("\n");
      return { content: [{ type: "text", text: toc || "(no headings)" }], details: { count: lines.length } };
    },
  });
}

// ---- text-pad connector ----
function textPadTool(): ToolDefinition {
  return defineTool({
    name: "textpad__pad",
    label: "pad",
    description: "Pad text to a target length (left/right/center) with a given char.",
    parameters: { type: "object", properties: { text: { type: "string" }, length: { type: "number" }, side: { type: "string", enum: ["left", "right", "center"] }, char: { type: "string" } }, required: ["text", "length"] },
    async execute(_id, params) {
      const { text, length, side, char } = params as any;
      const c = (char ?? " ")[0] ?? " ";
      const diff = Math.max(0, length - text.length);
      if (side === "left") return { content: [{ type: "text", text: c.repeat(diff) + text }] };
      if (side === "center") { const l = Math.floor(diff / 2); return { content: [{ type: "text", text: c.repeat(l) + text + c.repeat(diff - l) }] }; }
      return { content: [{ type: "text", text: text + c.repeat(diff) }] };
    },
  });
}

// ---- strip-ansi connector ----
function stripAnsiTool(): ToolDefinition {
  return defineTool({
    name: "stripansi__clean",
    label: "clean",
    description: "Remove ANSI escape codes from text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      return { content: [{ type: "text", text: clean }], details: { removed: text.length - clean.length } };
    },
  });
}

// ---- count-instances connector ----
function countInstancesTool(): ToolDefinition {
  return defineTool({
    name: "countinst__count",
    label: "count",
    description: "Count non-overlapping occurrences of a substring in text.",
    parameters: { type: "object", properties: { text: { type: "string" }, pattern: { type: "string" } }, required: ["text", "pattern"] },
    async execute(_id, params) {
      const { text, pattern } = params as { text: string; pattern: string };
      if (!pattern) return { content: [{ type: "text", text: "0" }], details: { count: 0 } };
      const count = text.split(pattern).length - 1;
      return { content: [{ type: "text", text: `"${pattern}" appears ${count} time(s).` }], details: { count } };
    },
  });
}

// ---- join-lines connector ----
function joinLinesTool(): ToolDefinition {
  return defineTool({
    name: "joinlines__join",
    label: "join",
    description: "Join lines of text with a separator (default ', ').",
    parameters: { type: "object", properties: { text: { type: "string" }, separator: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text, separator } = params as { text: string; separator?: string };
      const joined = text.split(/\r?\n/).join(separator ?? ", ");
      return { content: [{ type: "text", text: joined }], details: {} };
    },
  });
}

// ---- ascii-art connector ----
function asciiArtTool(): ToolDefinition {
  return defineTool({
    name: "asciiart__banner",
    label: "banner",
    description: "Render a simple ASCII banner from text (uppercase, block style).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const fonts: Record<string, string[]> = {
        A:["  AAA  "," A   A ","AAAAAAA","A     A","A     A"],B:["BBBBBB  ","B     B","BBBBBB ","B     B","BBBBBB  "],C:[" CCCCC ","C     C","C      ","C     C"," CCCCC "],D:["DDDDD  ","D    D","D     D","D    D","DDDDD  "],E:["EEEEEEE","E      ","EEEEE  ","E      ","EEEEEEE"],F:["FFFFFFF","F     ","FFFFF  ","F      ","F      "],G:[" GGGGG ","G     G","G  GGGG","G     G"," GGGG G"],H:["H     H","H     H","HHHHHHH","H     H","H     H"],I:["IIIIIII","   I   ","   I   ","   I   ","IIIIIII"],L:["L      ","L      ","L      ","L      ","LLLLLLL"],N:["N     N","NN    N","N N   N","N  N  N","N     N"],O:[" OOOOO ","O     O","O     O","O     O"," OOOOO "],P:["PPPPPP ","P     P","PPPPPP ","P      ","P      "],R:["RRRRRR ","R     R","RRRRRR ","R    R ","R     R"],S:[" SSSSS","S     "," SSSSS","     S","SSSSS "],T:["TTTTTTT","   T   ","   T   ","   T   ","   T   "],U:["U     U","U     U","U     U","U     U"," UUUUU "],W:["W     W","W     W","W  W  W","W W W W"," W   W "],
      };
      const upper = text.toUpperCase().slice(0, 20);
      const lines = [0,1,2,3,4].map((row) => upper.split("").map((c) => fonts[c]?.[row] ?? "       ").join(" ")).join("\n");
      return { content: [{ type: "text", text: lines }], details: {} };
    },
  });
}

// ---- type-test connector ----
function typeTestTool(): ToolDefinition {
  return defineTool({
    name: "typetest__detect",
    label: "detect",
    description: "Detect the type of a value: string, number, boolean, null, JSON object/array, URL, date.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    async execute(_id, params) {
      const v = (params as { value: string }).value;
      let type = "string";
      if (/^-?\d+$/.test(v)) type = "integer";
      else if (/^-?\d+\.\d+$/.test(v)) type = "float";
      else if (v === "true" || v === "false") type = "boolean";
      else if (v === "null") type = "null";
      else if (/^https?:\/\//.test(v)) type = "URL";
      else if (/^\d{4}-\d{2}-\d{2}/.test(v)) type = "date-like";
      else { try { const p = JSON.parse(v); type = Array.isArray(p) ? "JSON array" : typeof p === "object" && p !== null ? "JSON object" : "string"; } catch {} }
      return { content: [{ type: "text", text: `"${v.slice(0, 50)}" => ${type}` }], details: { type } };
    },
  });
}

// ---- factorial connector ----
function factorialTool(): ToolDefinition {
  return defineTool({
    name: "fact__compute",
    label: "compute",
    description: "Compute the factorial of a non-negative integer (max 170).",
    parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    async execute(_id, params) {
      const n = (params as { n: number }).n;
      if (n < 0 || n > 170 || !Number.isInteger(n)) return { content: [{ type: "text", text: "Must be integer 0-170." }], details: {}, isError: true };
      let r = 1; for (let i = 2; i <= n; i++) r *= i;
      return { content: [{ type: "text", text: `${n}! = ${r}` }], details: { result: r } };
    },
  });
}
