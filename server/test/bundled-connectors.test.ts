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
  it("seedDefaults registers all bundled connectors as connected", async () => {
    await mgr.seedDefaults();
    const list = mgr.list();
    const ids = list.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["fetch", "fs", "time", "calc", "sqlite", "git", "env", "hash"]));
    for (const id of ["fetch", "fs", "time", "calc", "sqlite", "git", "env", "hash"]) {
      expect(list.find((c) => c.id === id)?.status).toBe("connected");
    }
  });

  it("seedDefaults exposes 14 connector tools across 8 connectors", async () => {
    await mgr.seedDefaults();
    const names = mgr.getToolNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "fetch__fetch",
        "fs__read_file", "fs__write_file", "fs__list_dir",
        "time__now", "time__convert",
        "calc__eval", "calc__stats",
        "sqlite__query",
        "git__status", "git__log", "git__diff",
        "env__get",
        "hash__checksum",
      ]),
    );
    expect(names.length).toBe(14);
  });

  it("seedDefaults is idempotent", async () => {
    await mgr.seedDefaults();
    await mgr.seedDefaults();
    expect(mgr.getToolNames().length).toBe(14);
  });

  it("env__get reads a non-secret variable", async () => {
    process.env.PICOWORK_TEST_VAR = "hello-env";
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "env__get")!;
    const res = await t.execute("tc1", { name: "PICOWORK_TEST_VAR" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("hello-env");
    delete process.env.PICOWORK_TEST_VAR;
  });

  it("env__get refuses to read likely-secret variables", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "env__get")!;
    const res = await t.execute("tc1", { name: "MY_API_KEY" }, undefined, undefined, {} as any);
    expect(res.isError).toBe(true);
  });

  it("hash__checksum computes a sha256 digest", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "hash__checksum")!;
    const res = await t.execute("tc1", { input: "pi-cowork", algorithm: "sha256" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("sha256");
    expect(text).toMatch(/[0-9a-f]{64}/); // a 64-hex sha256 digest is present
  });

  it("git__status reports on a repository", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "git__status")!;
    const res = await t.execute("tc1", { repo: process.cwd() }, undefined, undefined, {} as any);
    // Either a status listing or "(clean)" — both indicate the tool ran.
    expect(typeof (res.content[0] as any).text).toBe("string");
  });

  it("time__now returns the current time in a timezone", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "time__now")!;
    const res = await t.execute("tc1", { timezone: "UTC" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("UTC");
    expect((res.content[0] as any).text).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("calc__eval evaluates arithmetic", async () => {
    await mgr.seedDefaults();
    const c = mgr.getConnectedTools().find((x) => x.name === "calc__eval")!;
    const res = await c.execute("tc1", { expression: "(12 * 8 + 4) / 2" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("50");
  });

  it("calc__eval rejects non-arithmetic input", async () => {
    await mgr.seedDefaults();
    const c = mgr.getConnectedTools().find((x) => x.name === "calc__eval")!;
    const res = await c.execute("tc1", { expression: "process.exit(1)" }, undefined, undefined, {} as any);
    expect(res.isError).toBe(true);
  });

  it("calc__stats computes summary statistics", async () => {
    await mgr.seedDefaults();
    const c = mgr.getConnectedTools().find((x) => x.name === "calc__stats")!;
    const res = await c.execute("tc1", { numbers: [1, 2, 3, 4, 100] }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain('"count": 5');
    expect(text).toContain('"median": 3');
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
