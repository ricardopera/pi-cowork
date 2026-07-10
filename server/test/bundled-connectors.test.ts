import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { McpConnectorManager } from "../src/pi/mcp-connectors.js";

let tmp: string;
let mgr: McpConnectorManager;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-conn-"));
  // Use the real singleton (it carries seedDefaults); reset by constructing fresh.
  mgr = new McpConnectorManager();
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("bundled default connectors", () => {
  it("seedDefaults registers fetch + fs connectors as connected", async () => {
    await mgr.seedDefaults();
    const list = mgr.list();
    const ids = list.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["fetch", "fs"]));
    expect(list.find((c) => c.id === "fetch")?.status).toBe("connected");
    expect(list.find((c) => c.id === "fs")?.status).toBe("connected");
  });

  it("seedDefaults exposes 4 connector tools (fetch + 3 fs)", async () => {
    await mgr.seedDefaults();
    const names = mgr.getToolNames();
    expect(names).toEqual(
      expect.arrayContaining(["fetch__fetch", "fs__read_file", "fs__write_file", "fs__list_dir"]),
    );
    expect(names.length).toBe(4);
  });

  it("seedDefaults is idempotent", async () => {
    await mgr.seedDefaults();
    await mgr.seedDefaults();
    expect(mgr.getToolNames().length).toBe(4);
  });

  it("fs__write_file + fs__read_file round-trip works", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const write = tools.find((t) => t.name === "fs__write_file")!;
    const read = tools.find((t) => t.name === "fs__read_file")!;
    const target = path.join(tmp, "hello.txt");
    await write.execute("tc1", { path: target, content: "bundled works" }, undefined, undefined, {} as any);
    const res = await read.execute("tc2", { path: target }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toBe("bundled works");
  });

  it("fs__list_dir lists entries", async () => {
    await mgr.seedDefaults();
    await fs.writeFile(path.join(tmp, "a.txt"), "x");
    await fs.writeFile(path.join(tmp, "b.txt"), "y");
    const list = mgr.getConnectedTools().find((t) => t.name === "fs__list_dir")!;
    const res = await list.execute("tc1", { path: tmp }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("a.txt");
    expect(text).toContain("b.txt");
  });

  it("fetch__fetch retrieves a live URL", async () => {
    await mgr.seedDefaults();
    const fetchTool = mgr.getConnectedTools().find((t) => t.name === "fetch__fetch")!;
    const res = await fetchTool.execute("tc1", { url: "https://example.com", maxChars: 500 }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("HTTP 200");
    expect(text).toContain("Example Domain");
  }, 20000);

  it("fs__read_file errors on a missing path", async () => {
    await mgr.seedDefaults();
    const read = mgr.getConnectedTools().find((t) => t.name === "fs__read_file")!;
    const res = await read.execute("tc1", { path: path.join(tmp, "nope.txt") }, undefined, undefined, {} as any);
    expect(res.isError).toBe(true);
  });
});
