import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectManager } from "../src/pi/projects.js";

let tmpData: string;
let pm: ProjectManager;

beforeEach(async () => {
  tmpData = await fs.mkdtemp(path.join(os.tmpdir(), "picw-proj-"));
  pm = new ProjectManager(tmpData);
  await pm.load();
});
afterEach(async () => {
  await fs.rm(tmpData, { recursive: true, force: true });
});

describe("projects", () => {
  it("creates a default project on load", () => {
    const list = pm.list();
    expect(list.find((p) => p.id === "default")).toBeTruthy();
  });

  it("creates a named project with a workspace dir", async () => {
    const p = await pm.create("Marketing");
    expect(p.name).toBe("Marketing");
    expect(p.id).toBeTruthy();
    const stat = await fs.stat(path.join(tmpData, "projects", p.id, "outputs"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("writes instructions to AGENTS.md in the project dir", async () => {
    const p = await pm.create("Legal", "Always cite statutes.");
    const md = await fs.readFile(path.join(tmpData, "projects", p.id, "AGENTS.md"), "utf8");
    expect(md).toContain("Always cite statutes.");
    expect(pm.get(p.id)?.instructions).toBe("Always cite statutes.");
  });

  it("renames a project", async () => {
    const p = await pm.create("Old");
    await pm.rename(p.id, "New");
    expect(pm.get(p.id)?.name).toBe("New");
  });

  it("updates instructions", async () => {
    const p = await pm.create("X");
    await pm.writeInstructions(p.id, "Be concise.");
    expect(pm.get(p.id)?.instructions).toBe("Be concise.");
  });

  it("removes a project and its directory", async () => {
    const p = await pm.create("ToDelete");
    const dir = path.join(tmpData, "projects", p.id);
    expect(await fs.stat(dir).then(() => true).catch(() => false)).toBe(true);
    await pm.remove(p.id);
    expect(pm.get(p.id)).toBeUndefined();
    expect(await fs.stat(dir).then(() => true).catch(() => false)).toBe(false);
  });

  it("cannot delete the default project", async () => {
    await expect(pm.remove("default")).rejects.toThrow(/cannot delete the default/);
  });

  it("cwd resolves to the project workspace dir", async () => {
    const p = await pm.create("Sales");
    expect(pm.cwd(p.id)).toBe(path.join(tmpData, "projects", p.id));
    expect(pm.cwd("default")).toBe(path.join(tmpData, "projects", "default"));
  });

  it("persists across instances", async () => {
    const p = await pm.create("Persisted");
    const pm2 = new ProjectManager(tmpData);
    await pm2.load();
    expect(pm2.get(p.id)?.name).toBe("Persisted");
  });
});
