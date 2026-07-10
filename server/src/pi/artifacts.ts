import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { config } from "../config.js";

/**
 * Artifacts: self-contained HTML pages that render live in the UI (Cowork's
 * artifacts feature). Stored under <dataDir>/artifacts/<id>.html and served
 * via GET /api/artifacts/:id. The browser renders them in a sandboxed iframe.
 */

export interface ArtifactStore {
  save(html: string): Promise<{ id: string; title: string }>;
  get(id: string): Promise<string | null>;
  list(): Promise<{ id: string; title: string }[]>;
}

export function createArtifactStore(baseDir?: string): ArtifactStore {
  const dir = path.join(baseDir ?? config.dataDir, "artifacts");

  async function ensureDir(): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  function extractTitle(html: string): string {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return (m?.[1]?.trim() || "Untitled artifact").slice(0, 80);
  }

  return {
    async save(html) {
      await ensureDir();
      const id = crypto.randomUUID();
      await fs.writeFile(path.join(dir, `${id}.html`), html);
      return { id, title: extractTitle(html) };
    },
    async get(id) {
      try {
        return await fs.readFile(path.join(dir, `${id}.html`), "utf8");
      } catch {
        return null;
      }
    },
    async list() {
      await ensureDir();
      const names = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".html"));
      const out: { id: string; title: string }[] = [];
      for (const name of names) {
        const html = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
        out.push({ id: name.replace(/\.html$/, ""), title: extractTitle(html) });
      }
      return out;
    },
  };
}

// Module-level singleton (shared across sessions).
let store: ArtifactStore | null = null;
export function getArtifactStore(): ArtifactStore {
  if (!store) store = createArtifactStore();
  return store;
}

export interface ArtifactToolDeps {
  /** Emit an artifact event to subscribers. */
  emitArtifact: (artifactId: string, title: string) => void;
}

export function createArtifactTools(deps: ArtifactToolDeps): ToolDefinition[] {
  const createArtifact = defineTool({
    name: "create_artifact",
    label: "Create live HTML artifact",
    description:
      "Create a self-contained HTML page that renders live in the user's UI (charts, " +
      "dashboards, interactive widgets). Inline all CSS/JS (no external files). " +
      "CDN scripts (Chart.js, Mermaid, etc.) are allowed. The artifact opens in a " +
      "sandboxed panel the user can interact with.",
    parameters: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description: "Complete HTML document (with <html>, <head>, <body>). Must be self-contained.",
        },
      },
      required: ["html"],
    },
    async execute(_id, params) {
      const { html } = params as { html: string };
      const s = getArtifactStore();
      const { id, title } = await s.save(html);
      deps.emitArtifact(id, title);
      return {
        content: [
          {
            type: "text",
            text: `Created artifact "${title}" (id: ${id}). It is now visible to the user as a live HTML panel.`,
          },
        ],
        details: { id, title },
      };
    },
  });

  return [createArtifact];
}

export const ARTIFACT_TOOL_NAMES = ["create_artifact"];
