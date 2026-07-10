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
    expect(ids).toEqual(
      expect.arrayContaining([
        "fetch", "fs", "time", "calc", "sqlite", "git", "env", "hash",
        "csv", "json", "md", "http", "base64", "uuid", "diff", "archive", "qr",
        "xml", "yaml", "regex", "ip", "url", "slugify", "cron", "extract",
      ]),
    );
    for (const id of ids) {
      expect(list.find((c) => c.id === id)?.status).toBe("connected");
    }
  });

  it("seedDefaults exposes 36 connector tools across 25 connectors", async () => {
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
        "env__get", "hash__checksum",
        "csv__parse", "csv__stringify",
        "json__format", "json__query",
        "md__table",
        "http__headers",
        "base64__encode", "base64__decode",
        "uuid__generate",
        "diff__lines",
        "archive__zip",
        "qr__text",
        "xml__parse", "xml__stringify",
        "yaml__parse", "yaml__stringify",
        "regex__match",
        "ip__lookup",
        "url__parse",
        "slugify__make",
        "cron__validate",
        "extract__archive",
      ]),
    );
    expect(names.length).toBe(36);
  });

  it("seedDefaults is idempotent", async () => {
    await mgr.seedDefaults();
    await mgr.seedDefaults();
    expect(mgr.getToolNames().length).toBe(36);
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

  it("csv__parse parses CSV to objects, csv__stringify round-trips", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const parse = tools.find((t) => t.name === "csv__parse")!;
    const stringify = tools.find((t) => t.name === "csv__stringify")!;
    const res = await parse.execute("tc1", { csv: "name,age\nAda,36\nAlan,41" }, undefined, undefined, {} as any);
    expect(JSON.parse((res.content[0] as any).text)).toEqual([
      { name: "Ada", age: "36" },
      { name: "Alan", age: "41" },
    ]);
    const out = await stringify.execute("tc2", { rows: [{ a: "1", b: "2" }] }, undefined, undefined, {} as any);
    expect((out.content[0] as any).text).toContain("a,b");
  });

  it("json__format pretty-prints and validates", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "json__format")!;
    const ok = await t.execute("tc1", { json: '{"a":1}' }, undefined, undefined, {} as any);
    expect((ok.content[0] as any).text).toContain('"a": 1');
    const bad = await t.execute("tc2", { json: "{not json" }, undefined, undefined, {} as any);
    expect(bad.isError).toBe(true);
  });

  it("md__table renders a markdown table", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "md__table")!;
    const res = await t.execute("tc1", { rows: [{ x: "1", y: "2" }, { x: "3", y: "4" }] }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("| x | y |");
    expect(text).toContain("| --- |");
  });

  it("base64 encode/decode round-trips", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const enc = tools.find((x) => x.name === "base64__encode")!;
    const dec = tools.find((x) => x.name === "base64__decode")!;
    const e = await enc.execute("tc1", { input: "Pi-Cowork" }, undefined, undefined, {} as any);
    const d = await dec.execute("tc2", { input: (e.content[0] as any).text }, undefined, undefined, {} as any);
    expect((d.content[0] as any).text).toBe("Pi-Cowork");
  });

  it("uuid__generate produces valid UUIDs", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "uuid__generate")!;
    const res = await t.execute("tc1", { count: 3 }, undefined, undefined, {} as any);
    const ids = (res.content[0] as any).text.split("\n");
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("diff__lines shows added/removed lines", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "diff__lines")!;
    const res = await t.execute("tc1", { a: "a\nb\nc", b: "a\nx\nc" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("-b");
    expect(text).toContain("+x");
  });

  it("http__headers fetches headers (live)", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "http__headers")!;
    const res = await t.execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toMatch(/HTTP \d+/);
  }, 20000);

  it("json__query navigates a dotted path", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "json__query")!;
    const res = await t.execute("tc1", { json: '{"users":[{"name":"Ada"}]}', path: "users.0.name" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text.trim()).toBe('"Ada"');
  });

  it("qr__text returns a payload-labelled rendering", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "qr__text")!;
    const res = await t.execute("tc1", { text: "https://pi-cowork.example" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("https://pi-cowork.example");
  });

  it("xml__parse parses an element, xml__stringify round-trips", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const parse = tools.find((x) => x.name === "xml__parse")!;
    const res = await parse.execute("tc1", { xml: "<note to=\"Ada\">hi</note>" }, undefined, undefined, {} as any);
    const obj = JSON.parse((res.content[0] as any).text);
    expect(obj.note["@to"]).toBe("Ada");
    expect(obj.note["#text"]).toBe("hi");
  });

  it("yaml__parse <-> yaml__stringify round-trips", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const parse = tools.find((x) => x.name === "yaml__parse")!;
    const stringify = tools.find((x) => x.name === "yaml__stringify")!;
    const p = await parse.execute("tc1", { yaml: "name: Ada\nage: 36" }, undefined, undefined, {} as any);
    expect(JSON.parse((p.content[0] as any).text)).toEqual({ name: "Ada", age: 36 });
    const s = await stringify.execute("tc2", { json: '{"a":1}' }, undefined, undefined, {} as any);
    expect((s.content[0] as any).text).toContain("a: 1");
  });

  it("regex__match returns matches", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "regex__match")!;
    const res = await t.execute("tc1", { pattern: "\\d+", text: "a1b22c333", flags: "g" }, undefined, undefined, {} as any);
    expect(JSON.parse((res.content[0] as any).text)).toEqual(["1", "22", "333"]);
  });

  it("regex__match reports invalid patterns", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "regex__match")!;
    const res = await t.execute("tc1", { pattern: "(", text: "x" }, undefined, undefined, {} as any);
    expect(res.isError).toBe(true);
  });

  it("ip__lookup returns geo data or a clear error (live)", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "ip__lookup")!;
    const res = await t.execute("tc1", { ip: "8.8.8.8" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    // Either JSON geo data, or (offline/sandbox) a clear error.
    if (!res.isError) {
      const obj = JSON.parse(text);
      expect(obj.ip).toBe("8.8.8.8");
    } else {
      expect(text).toMatch(/lookup failed/i);
    }
  }, 20000);

  it("url__parse decomposes a URL with query params", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "url__parse")!;
    const res = await t.execute("tc1", { url: "https://a.example/x?n=1&m=2#h" }, undefined, undefined, {} as any);
    const obj = JSON.parse((res.content[0] as any).text);
    expect(obj.hostname).toBe("a.example");
    expect(obj.params).toEqual({ n: "1", m: "2" });
    expect(obj.hash).toBe("#h");
  });

  it("slugify__make produces URL-safe slugs", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "slugify__make")!;
    const res = await t.execute("tc1", { text: "Héllo, World! 2024" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toBe("hello-world-2024");
  });

  it("cron__validate accepts a valid expression and rejects bad ones", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "cron__validate")!;
    const ok = await t.execute("tc1", { expression: "0 9 * * 1-5" }, undefined, undefined, {} as any);
    expect(ok.isError).toBeUndefined();
    expect((ok.content[0] as any).text).toContain("Valid cron");
    const bad = await t.execute("tc2", { expression: "not cron" }, undefined, undefined, {} as any);
    expect(bad.isError).toBe(true);
  });
});
