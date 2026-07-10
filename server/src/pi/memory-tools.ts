import path from "node:path";
import fs from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * File-based memory tools, mirroring Cowork's memory system.
 *
 * Memory lives in <cwd>/memory/ as one markdown file per entry, with YAML
 * frontmatter (type, tags, timestamp) and a body. A MEMORY.md index lists all
 * entries with [[wikilinks]] for quick orientation.
 *
 * Memory types: user (preferences/facts about the user), feedback (corrections
 * the user gave), project (project-specific context), reference (useful info).
 */

export type MemoryType = "user" | "feedback" | "project" | "reference";

const VALID_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemoryToolDeps {
  cwd: string;
}

interface MemoryEntry {
  filename: string;
  type: MemoryType;
  title: string;
  tags: string[];
  body: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "entry";
}

async function memoryDir(cwd: string): Promise<string> {
  const dir = path.join(cwd, "memory");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function parseEntry(raw: string, filename: string): MemoryEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const front = m[1];
  const body = m[2].trim();
  const get = (key: string) => {
    const line = front.split("\n").find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : "";
  };
  const tagsRaw = get("tags");
  const tags = tagsRaw
    ? tagsRaw.replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  return {
    filename,
    type: (get("type") as MemoryType) || "reference",
    title: get("title") || filename,
    tags,
    body,
  };
}

async function readAllEntries(dir: string): Promise<MemoryEntry[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
    const parsed = parseEntry(raw, name);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

async function rebuildIndex(dir: string, entries: MemoryEntry[]): Promise<void> {
  const lines = ["# Memory Index", ""];
  const byType: Record<string, MemoryEntry[]> = {};
  for (const e of entries) (byType[e.type] ??= []).push(e);
  for (const type of VALID_TYPES) {
    const group = byType[type];
    if (!group?.length) continue;
    lines.push(`## ${type}`, "");
    for (const e of group) {
      lines.push(`- [[${e.filename.replace(/\.md$/, "")}]] ${e.title}${e.tags.length ? ` _${e.tags.join(", ")}_` : ""}`);
    }
    lines.push("");
  }
  await fs.writeFile(path.join(dir, "MEMORY.md"), lines.join("\n"));
}

export function createMemoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  const memoryWrite = defineTool({
    name: "memory_write",
    label: "Save to memory",
    description:
      "Persist a durable note to the workspace memory store for use across sessions. " +
      "Use for user preferences, feedback/corrections, project context, or useful " +
      "reference info. Each entry is a markdown file in memory/ with frontmatter; " +
      "the MEMORY.md index is auto-rebuilt.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, descriptive title." },
        type: {
          type: "string",
          enum: VALID_TYPES,
          description: "user=preference/fact about user, feedback=correction, project=project context, reference=useful info.",
        },
        body: { type: "string", description: "The memory content (markdown)." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags for searchability." },
      },
      required: ["title", "type", "body"],
    },
    async execute(_id, params) {
      const { title, type, body, tags } = params as {
        title: string;
        type: MemoryType;
        body: string;
        tags?: string[];
      };
      const dir = await memoryDir(deps.cwd);
      const filename = `${slugify(title)}.md`;
      const front = [
        "---",
        `title: ${title.replace(/\n/g, " ")}`,
        `type: ${type}`,
        `tags: [${(tags ?? []).join(", ")}]`,
        `timestamp: ${new Date().toISOString()}`,
        "---",
        "",
      ].join("\n");
      await fs.writeFile(path.join(dir, filename), front + body + "\n");
      const entries = await readAllEntries(dir);
      await rebuildIndex(dir, entries);
      return {
        content: [{ type: "text", text: `Saved memory "${title}" (${type}) to ${filename}.` }],
        details: { filename, total: entries.length },
      };
    },
  });

  const memoryRead = defineTool({
    name: "memory_read",
    label: "Read memory",
    description:
      "Read the memory store: list all entries, filter by type, or read the full index. " +
      "Returns entry titles + a snippet. Use memory_search for keyword queries.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: VALID_TYPES,
          description: "Optional: filter to one memory type.",
        },
      },
    },
    async execute(_id, params) {
      const { type } = (params as { type?: MemoryType }) ?? {};
      const dir = await memoryDir(deps.cwd);
      let entries = await readAllEntries(dir);
      if (type) entries = entries.filter((e) => e.type === type);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No memory entries found." }], details: { count: 0 } };
      }
      const summary = entries
        .map((e) => `**${e.title}** [${e.type}]${e.tags.length ? ` _${e.tags.join(", ")}_` : ""}\n${e.body.slice(0, 200)}${e.body.length > 200 ? "…" : ""}`)
        .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `${entries.length} entr${entries.length === 1 ? "y" : "ies"}:\n\n${summary}` }],
        details: { count: entries.length, entries: entries.map((e) => ({ title: e.title, type: e.type, filename: e.filename })) },
      };
    },
  });

  const memorySearch = defineTool({
    name: "memory_search",
    label: "Search memory",
    description: "Search memory entries by keyword (matches title, tags, and body).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for." },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const { query } = params as { query: string };
      const q = query.toLowerCase();
      const dir = await memoryDir(deps.cwd);
      const entries = await readAllEntries(dir);
      const matches = entries.filter((e) =>
        [e.title, e.body, e.tags.join(" "), e.type].some((f) => f.toLowerCase().includes(q)),
      );
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No memory entries match "${query}".` }], details: { count: 0 } };
      }
      const summary = matches
        .map((e) => `**${e.title}** [${e.type}]\n${e.body.slice(0, 300)}`)
        .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `${matches.length} match(es) for "${query}":\n\n${summary}` }],
        details: { count: matches.length },
      };
    },
  });

  return [memoryWrite, memoryRead, memorySearch];
}

export const MEMORY_TOOL_NAMES = ["memory_write", "memory_read", "memory_search"];
