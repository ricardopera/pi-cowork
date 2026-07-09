import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "../src/pi/memory-tools.js";

let tmpdir: string;

function tools() {
  return createMemoryTools({ cwd: tmpdir });
}
function byName(t: any[], name: string) {
  const found = t.find((x) => x.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(async () => {
  tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cowork-mem-"));
});
afterEach(async () => {
  await fs.rm(tmpdir, { recursive: true, force: true });
});

describe("memory tools", () => {
  it("exports the expected tool names", () => {
    expect(MEMORY_TOOL_NAMES).toEqual(
      expect.arrayContaining(["memory_write", "memory_read", "memory_search"]),
    );
  });

  it("write creates a memory file + rebuilds the index", async () => {
    const write = byName(tools(), "memory_write");
    await write.execute("tc1", {
      title: "Prefers concise answers",
      type: "user",
      body: "The user likes short, direct responses.",
      tags: ["style", "tone"],
    }, undefined, undefined, {} as any);
    const files = await fs.readdir(path.join(tmpdir, "memory"));
    expect(files).toContain("prefers-concise-answers.md");
    expect(files).toContain("MEMORY.md");
    const idx = await fs.readFile(path.join(tmpdir, "memory", "MEMORY.md"), "utf8");
    expect(idx).toContain("## user");
    expect(idx).toContain("Prefers concise answers");
  });

  it("read lists entries and filters by type", async () => {
    const write = byName(tools(), "memory_write");
    await write.execute("tc1", { title: "Project uses React", type: "project", body: "Frontend is React+TS." }, undefined, undefined, {} as any);
    await write.execute("tc2", { title: "Avoid jargon", type: "feedback", body: "User said skip jargon." }, undefined, undefined, {} as any);
    const read = byName(tools(), "memory_read");
    const all = await read.execute("tc3", {}, undefined, undefined, {} as any);
    expect((all.content[0] as any).text).toContain("Project uses React");
    expect((all.content[0] as any).text).toContain("Avoid jargon");
    const filtered = await read.execute("tc4", { type: "project" }, undefined, undefined, {} as any);
    expect((filtered.content[0] as any).text).toContain("Project uses React");
    expect((filtered.content[0] as any).text).not.toContain("Avoid jargon");
  });

  it("read reports empty when no entries", async () => {
    const read = byName(tools(), "memory_read");
    const res = await read.execute("tc1", {}, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("No memory entries");
  });

  it("search matches across title/tags/body", async () => {
    const write = byName(tools(), "memory_write");
    await write.execute("tc1", { title: "API key location", type: "reference", body: "Keys live in auth.json.", tags: ["setup"] }, undefined, undefined, {} as any);
    await write.execute("tc2", { title: "Standup time", type: "project", body: "Daily at 9am.", tags: ["meeting"] }, undefined, undefined, {} as any);
    const search = byName(tools(), "memory_search");
    const hits = await search.execute("tc3", { query: "auth.json" }, undefined, undefined, {} as any);
    expect((hits.content[0] as any).text).toContain("API key location");
    expect((hits.content[0] as any).text).not.toContain("Standup");
    const none = await search.execute("tc4", { query: "nonexistent-term" }, undefined, undefined, {} as any);
    expect((none.content[0] as any).text).toContain("No memory entries match");
  });

  it("persists across tool instances (survives session restart)", async () => {
    await (byName(tools(), "memory_write")).execute("tc1", { title: "Durable note", type: "user", body: "Survives restart." }, undefined, undefined, {} as any);
    // New tool instances pointing at the same cwd should see the entry.
    const read = byName(tools(), "memory_read");
    const res = await read.execute("tc2", {}, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("Durable note");
  });
});
