import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Projects (Cowork's Projects feature): named, persistent workspaces. Each
 * project owns a directory containing its own outputs/, memory/, .agents/skills/,
 * and an AGENTS.md for custom instructions. Sessions created under a project
 * run with that project's directory as cwd, so deliverables, memory, and skills
 * are scoped per-project and persist across restarts.
 */

export interface Project {
  id: string;
  name: string;
  instructions?: string; // written to <dir>/AGENTS.md
  createdAt: string;
}

const DEFAULT_PROJECT_ID = "default";

export class ProjectManager {
  private projects = new Map<string, Project>();
  private loaded = false;
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? config.dataDir;
  }

  private metaFile(): string {
    return path.join(this.dataDir, "projects", "projects.json");
  }

  private dir(id: string): string {
    return path.join(this.dataDir, "projects", id);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.metaFile(), "utf8");
      const arr: Project[] = JSON.parse(raw);
      for (const p of arr) this.projects.set(p.id, p);
    } catch {
      /* none yet */
    }
    // Ensure the default project always exists.
    if (!this.projects.has(DEFAULT_PROJECT_ID)) {
      this.projects.set(DEFAULT_PROJECT_ID, {
        id: DEFAULT_PROJECT_ID,
        name: "Default",
        createdAt: new Date().toISOString(),
      });
      await this.persist();
    }
    for (const p of this.projects.values()) await this.ensureProjectDir(p.id);
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.metaFile()), { recursive: true });
    await fs.writeFile(this.metaFile(), JSON.stringify([...this.projects.values()], null, 2));
  }

  private async ensureProjectDir(id: string): Promise<void> {
    const dir = this.dir(id);
    await fs.mkdir(path.join(dir, "outputs"), { recursive: true });
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /** Resolve a project id to its working directory. */
  cwd(id: string): string {
    return this.dir(id || DEFAULT_PROJECT_ID);
  }

  async create(name: string, instructions?: string): Promise<Project> {
    const id = crypto.randomUUID();
    const project: Project = {
      id,
      name: name || "Untitled project",
      instructions,
      createdAt: new Date().toISOString(),
    };
    this.projects.set(id, project);
    await this.ensureProjectDir(id);
    if (instructions) await this.writeInstructions(id, instructions);
    await this.persist();
    return project;
  }

  async rename(id: string, name: string): Promise<Project | undefined> {
    const p = this.projects.get(id);
    if (!p) return undefined;
    p.name = name;
    await this.persist();
    return p;
  }

  async writeInstructions(id: string, instructions: string): Promise<void> {
    const p = this.projects.get(id);
    if (!p) throw new Error("project not found");
    p.instructions = instructions;
    await fs.writeFile(path.join(this.dir(id), "AGENTS.md"), instructions);
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    if (id === DEFAULT_PROJECT_ID) throw new Error("cannot delete the default project");
    const existed = this.projects.delete(id);
    if (existed) {
      await fs.rm(this.dir(id), { recursive: true, force: true });
      await this.persist();
    }
    return existed;
  }
}

// Singleton
let pm: ProjectManager | null = null;
export function getProjectManager(): ProjectManager {
  if (!pm) pm = new ProjectManager();
  return pm;
}
