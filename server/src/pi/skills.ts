import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config.js";

/**
 * Pi-Cowork skills manager.
 *
 * Skills are markdown files (with optional YAML frontmatter: name, description,
 * triggers) that teach the agent how to handle certain task types. Pi Agent's own
 * resource loader discovers skills from <cwd>/.agents/skills/ (walked to git
 * root), so Pi-Cowork's job is to:
 *   1. maintain a global skill library at ~/.pi-cowork/skills/
 *   2. let a project enable skills by copying them into <workspace>/.agents/skills/
 *   3. expose list/enable/disable via REST
 *
 * This gives Pi-Cowork the *capability* to have many skills without hand-coding
 * each — exactly Cowork's plugin model, layered on Pi's native skill loading.
 */

export interface SkillManifest {
  name: string;
  description: string;
  triggers?: string[];
  source: "global" | "project";
  enabled: boolean; // whether it's currently in the project's .agents/skills/
}

const DEFAULT_GLOBAL_SKILLS_DIR = path.join(config.dataDir, "skills");

function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".agents", "skills");
}

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  triggers?: string[];
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const front = m[1];
  const get = (key: string) => {
    const line = front.split("\n").find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : undefined;
  };
  const triggersRaw = get("triggers");
  const triggers = triggersRaw
    ? triggersRaw.replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;
  return { name: get("name"), description: get("description"), triggers };
}

async function readSkillFile(filePath: string): Promise<SkillManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  const meta = parseFrontmatter(raw);
  const base = path.basename(filePath, ".md");
  return {
    name: meta.name ?? base,
    description: meta.description ?? "",
    triggers: meta.triggers,
    source: "global",
    enabled: false,
  };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
  } catch {
    return [];
  }
}

export class SkillsManager {
  constructor(
    private cwd: string,
    private globalDir: string = DEFAULT_GLOBAL_SKILLS_DIR,
  ) {}

  /** List all skills: global library + project-enabled, with enabled flag. */
  async list(): Promise<SkillManifest[]> {
    await fs.mkdir(this.globalDir, { recursive: true });
    const [globalNames, projectNames] = await Promise.all([
      listDir(this.globalDir),
      listDir(projectSkillsDir(this.cwd)),
    ]);
    const enabledSet = new Set(projectNames);
    const all = new Set([...globalNames, ...projectNames]);
    const out: SkillManifest[] = [];
    for (const name of all) {
      const inGlobal = globalNames.includes(name);
      const filePath = inGlobal
        ? path.join(this.globalDir, name)
        : path.join(projectSkillsDir(this.cwd), name);
      const skill = await readSkillFile(filePath);
      if (skill) {
        skill.source = inGlobal ? "global" : "project";
        skill.enabled = enabledSet.has(name);
        out.push(skill);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Enable a global skill in this project (copy into .agents/skills/). */
  async enable(skillFile: string): Promise<void> {
    const src = path.join(this.globalDir, skillFile);
    const dest = path.join(projectSkillsDir(this.cwd), skillFile);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }

  /** Disable a skill in this project (remove from .agents/skills/). */
  async disable(skillFile: string): Promise<void> {
    const dest = path.join(projectSkillsDir(this.cwd), skillFile);
    await fs.rm(dest, { force: true });
  }

  /** Install a new global skill from name + content. */
  async install(filename: string, content: string): Promise<void> {
    if (!filename.endsWith(".md")) throw new Error("skill must be a .md file");
    await fs.mkdir(this.globalDir, { recursive: true });
    const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    await fs.writeFile(path.join(this.globalDir, safe), content);
  }

  /** Remove a global skill. */
  async uninstall(filename: string): Promise<void> {
    await fs.rm(path.join(this.globalDir, path.basename(filename)), { force: true });
  }

  /** Ensure the bundled starter skills exist (seeded once on first run). */
  async seedBuiltin(): Promise<void> {
    await fs.mkdir(this.globalDir, { recursive: true });
    for (const [name, content] of Object.entries(STARTER_SKILLS)) {
      const dest = path.join(this.globalDir, name);
      if (!(await fs.stat(dest).catch(() => null))) {
        await fs.writeFile(dest, content);
      }
    }
  }
}

// A small starter set of skills — written originally for Pi-Cowork (not copied
// from Anthropic), demonstrating the format and covering common knowledge work.
const STARTER_SKILLS: Record<string, string> = {
  "research-and-summarize.md": `---
name: Research and Summarize
description: Research a topic using web search and produce a concise, well-cited summary.
triggers: [research, summarize, explain, overview]
---

# Research and Summarize

When asked to research or summarize a topic:

1. Use ask_question to clarify scope, depth, and audience if ambiguous.
2. Break the work into steps with todo_write.
3. Search the web for authoritative sources.
4. Synthesize findings into a clear summary with citations.
5. Offer to export the result as a document (create_docx / create_pdf / create_file).
`,
  "write-a-doc.md": `---
name: Write a Document
description: Produce a polished document (docx, pdf, xlsx, pptx) from a brief.
triggers: [write, document, report, memo, slide, deck, spreadsheet]
---

# Write a Document

When asked to create a document:

1. Clarify: audience, length, tone, format (ask_question).
2. Plan the structure (todo_write).
3. Draft the content section by section.
4. Generate the deliverable with the matching tool:
   - Word report -> create_docx
   - Spreadsheet -> create_xlsx
   - Slides -> create_pptx
   - PDF -> create_pdf
   - Markdown/HTML -> create_file
5. Present the result with present_files.
`,
  "analyze-data.md": `---
name: Analyze Data
description: Analyze a CSV or spreadsheet, compute statistics, and report findings.
triggers: [analyze, data, csv, statistics, trends]
---

# Analyze Data

When asked to analyze data:

1. Find or ask where the data lives (ask_question if needed).
2. Read it (read tool) and inspect with bash (python/pandas if available).
3. Compute summary statistics and notable patterns.
4. Present findings clearly; offer to export an xlsx or chart.
5. Save durable facts about the dataset to memory.
`,
};
