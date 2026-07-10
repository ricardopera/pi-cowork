import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillsManager } from "../src/pi/skills.js";

let tmpRoot: string;
let tmpWorkspace: string;
let tmpGlobal: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "picw-"));
  tmpWorkspace = path.join(tmpRoot, "workspace");
  tmpGlobal = path.join(tmpRoot, "skills");
  await fs.mkdir(tmpWorkspace, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function mgr() {
  return new SkillsManager(tmpWorkspace, tmpGlobal);
}

describe("skills manager", () => {
  it("seeds starter skills into the global library", async () => {
    const m = mgr();
    await m.seedBuiltin();
    const skills = await m.list();
    const names = skills.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["Research and Summarize", "Write a Document", "Analyze Data"]),
    );
  });

  it("seeds the expanded knowledge-worker skill set (>= 50)", async () => {
    const m = mgr();
    await m.seedBuiltin();
    const names = (await m.list()).map((s) => s.name);
    expect(names.length).toBeGreaterThanOrEqual(50);
    expect(names).toEqual(
      expect.arrayContaining([
        "Draft an Email",
        "Clean Data",
        "Meeting Notes",
        "Competitor Analysis",
        "Project Brief",
        "Summarize a Long Document",
        "Build a Spreadsheet Model",
        "Write a Social Post",
        "Q&A / FAQ Prep",
        "Code Explainer",
        "Troubleshoot an Issue",
        "Write a Job Description",
        "Onboarding Doc",
        "Decision Memo",
        "Retrospective",
        "Translate / Localize",
        "Review a Pull Request",
        "Write a Blog Post",
      ]),
    );
  });

  it("seeding is idempotent (does not duplicate)", async () => {
    const m = mgr();
    await m.seedBuiltin();
    await m.seedBuiltin();
    const skills = await m.list();
    const research = skills.filter((s) => s.name === "Research and Summarize");
    expect(research).toHaveLength(1);
  });

  it("enabling a skill copies it into the project .agents/skills dir", async () => {
    const m = mgr();
    await m.seedBuiltin();
    await m.enable("research-and-summarize.md");
    const projectFile = path.join(
      tmpWorkspace,
      ".agents",
      "skills",
      "research-and-summarize.md",
    );
    const stat = await fs.stat(projectFile);
    expect(stat.isFile()).toBe(true);
    const skills = await m.list();
    expect(
      skills.find((s) => s.name === "Research and Summarize")?.enabled,
    ).toBe(true);
  });

  it("disabling removes it from the project", async () => {
    const m = mgr();
    await m.seedBuiltin();
    await m.enable("write-a-doc.md");
    await m.disable("write-a-doc.md");
    const skills = await m.list();
    expect(skills.find((s) => s.name === "Write a Document")?.enabled).toBe(false);
  });

  it("install adds a custom global skill and parses frontmatter", async () => {
    const m = mgr();
    await m.install(
      "custom.md",
      "---\nname: Custom Skill\ndescription: A test skill.\ntriggers: [foo, bar]\n---\n# Body\n",
    );
    const skills = await m.list();
    const custom = skills.find((s) => s.name === "Custom Skill");
    expect(custom).toBeTruthy();
    expect(custom?.description).toBe("A test skill.");
    expect(custom?.triggers).toEqual(["foo", "bar"]);
  });

  it("uninstall removes a global skill", async () => {
    const m = mgr();
    await m.install("temp.md", "---\nname: Temp\n---\nbody");
    await m.uninstall("temp.md");
    const skills = await m.list();
    expect(skills.find((s) => s.name === "Temp")).toBeUndefined();
  });
});
