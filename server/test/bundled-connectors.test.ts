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
        "xml", "yaml", "regex", "ip", "url", "slugify", "cron", "extract", "email", "phone", "color", "units", "lorem", "password", "note", "hashlist", "timezones", "md2html", "html2text", "sentiment", "readability", "grammar", "emoji", "currency", "number", "datefmt", "weather", "stock", "isbn", "morse", "rot13", "roman", "leet", "piglatin", "haiku", "country", "langdetect", "textstats", "wordfreq", "palindrome", "anagram", "caesar", "atbash", "binconv", "textcase", "histogram", "percentile", "correlate", "freqtable", "sortlines", "dedupe", "reverse", "chunk", "truncate", "linecount", "charfreq", "strdist", "mdlinks", "diffsum", "numwords", "ordinal", "prime", "mathops", "pct", "ratio", "stemmer", "ngram", "wrap", "colalign", "zodiac", "dice", "coinflip", "pick", "shuffle", "tabulate", "outline", "tocgen", "textpad", "stripansi", "countinst", "joinlines", "asciiart", "typetest", "fact", "fib", "collatz", "ismult", "divmod", "meanmed", "range", "variance", "zip", "flatten", "uniq", "intersect", "setdiff", "groupcount", "dotprod", "vadd", "transpose", "isop", "digits", "textfind", "textreplace", "texttrim", "textsplit", "lineprefix", "linesuffix", "indent", "comment", "fence", "countdown", "seq", "between", "urlencode", "urldecode", "htmlesc", "htmlunesc", "timestamp",
      ]),
    );
    for (const id of ids) {
      expect(list.find((c) => c.id === id)?.status).toBe("connected");
    }
  });

  it("seedDefaults exposes 151 connector tools across 136 connectors", async () => {
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
        "extract__archive", "email__validate", "phone__format", "color__convert", "units__convert", "lorem__generate", "password__generate", "note__add", "note__get", "note__list", "hashlist__algorithms", "timezones__list", "md2html__convert", "html2text__strip", "sentiment__analyze", "readability__score", "grammar__count", "emoji__info", "currency__format", "number__format", "datefmt__format", "weather__current", "stock__quote", "isbn__lookup", "morse__encode", "morse__decode", "rot13__apply", "roman__from_number", "roman__to_number", "leet__convert", "piglatin__convert", "haiku__generate", "country__info", "langdetect__detect", "textstats__analyze", "wordfreq__count", "palindrome__check", "anagram__check", "caesar__shift", "atbash__apply", "binconv__convert", "textcase__convert", "histogram__build", "percentile__compute", "correlate__pearson", "freqtable__build", "sortlines__sort", "dedupe__lines", "reverse__text", "chunk__split", "truncate__text", "linecount__count", "charfreq__count", "strdist__levenshtein", "mdlinks__extract", "diffsum__summarize", "numwords__convert", "ordinal__convert", "prime__check", "mathops__gcd_lcm", "pct__compute", "ratio__simplify", "stemmer__porter", "ngram__extract", "wrap__text", "colalign__align", "zodiac__sign", "dice__roll", "coinflip__flip", "pick__random", "shuffle__items", "tabulate__format", "outline__extract", "tocgen__generate", "textpad__pad", "stripansi__clean", "countinst__count", "joinlines__join", "asciiart__banner", "typetest__detect", "fact__compute", "fib__sequence", "collatz__sequence", "ismult__check", "divmod__compute", "meanmed__compute", "range__compute", "variance__compute", "zip__arrays", "flatten__nested", "uniq__dedupe", "intersect__arrays", "setdiff__arrays", "groupcount__count", "dotprod__compute", "vadd__compute", "transpose__matrix", "isop__check", "digits__split", "textfind__search", "textreplace__replace", "texttrim__trim", "textsplit__split", "lineprefix__add", "linesuffix__add", "indent__add", "comment__add", "fence__wrap", "countdown__from", "seq__range", "between__extract", "urlencode__encode", "urldecode__decode", "htmlesc__escape", "htmlunesc__unescape", "timestamp__convert",
      ]),
    );
    expect(names.length).toBe(151);
  });

  it("seedDefaults is idempotent", async () => {
    await mgr.seedDefaults();
    await mgr.seedDefaults();
    expect(mgr.getToolNames().length).toBe(151);
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

  it("email__validate checks format and splits parts", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "email__validate")!;
    const ok = await t.execute("tc1", { email: "a@b.com" }, undefined, undefined, {} as any);
    expect((ok.content[0] as any).text).toContain('local="a"');
    const bad = await t.execute("tc2", { email: "nope" }, undefined, undefined, {} as any);
    expect((bad.content[0] as any).text).toContain("Invalid");
  });

  it("phone__format normalizes to E.164", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "phone__format")!;
    const res = await t.execute("tc1", { phone: "+1 (415) 555-1234" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("E.164=+14155551234");
  });

  it("color__convert converts hex to rgb/hsl", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "color__convert")!;
    const res = await t.execute("tc1", { color: "#ff0000" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("rgb(255,0,0)");
    expect(text).toMatch(/hsl\(/);
  });

  it("units__convert converts length, weight, and temperature", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "units__convert")!;
    const m = await t.execute("tc1", { value: 1, from: "km", to: "m" }, undefined, undefined, {} as any);
    expect((m.content[0] as any).text).toContain("1000 m");
    const w = await t.execute("tc2", { value: 1, from: "kg", to: "lb" }, undefined, undefined, {} as any);
    expect((w.content[0] as any).text).toMatch(/2\.20.*lb/);
    const temp = await t.execute("tc3", { value: 0, from: "c", to: "f" }, undefined, undefined, {} as any);
    expect((temp.content[0] as any).text).toContain("32");
  });

  it("lorem__generate produces words/sentences", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "lorem__generate")!;
    const w = await t.execute("tc1", { count: 10, unit: "words" }, undefined, undefined, {} as any);
    expect((w.content[0] as any).text.split(" ")).toHaveLength(10);
    const s = await t.execute("tc2", { count: 2, unit: "sentences" }, undefined, undefined, {} as any);
    expect((s.content[0] as any).text.match(/\./g)?.length).toBe(2);
  });

  it("password__generate returns the requested length", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "password__generate")!;
    const res = await t.execute("tc1", { length: 24 }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text.length).toBe(24);
  });

  it("note add/get/list round-trips", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const add = tools.find((x) => x.name === "note__add")!;
    const get = tools.find((x) => x.name === "note__get")!;
    const list = tools.find((x) => x.name === "note__list")!;
    await add.execute("tc1", { name: "groceries", body: "milk, eggs" }, undefined, undefined, {} as any);
    const g = await get.execute("tc2", { name: "groceries" }, undefined, undefined, {} as any);
    expect((g.content[0] as any).text).toBe("milk, eggs");
    const l = await list.execute("tc3", {}, undefined, undefined, {} as any);
    expect((l.content[0] as any).text).toContain("groceries");
  });

  it("hashlist__algorithms lists available hashes", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "hashlist__algorithms")!;
    const res = await t.execute("tc1", {}, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("sha256");
  });

  it("timezones__list lists and filters zones", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "timezones__list")!;
    const all = await t.execute("tc1", {}, undefined, undefined, {} as any);
    expect((all.content[0] as any).text).toContain("America/");
    const filt = await t.execute("tc2", { filter: "Europe" }, undefined, undefined, {} as any);
    expect((filt.content[0] as any).text).toContain("Europe/London");
  });

  it("md2html__convert renders headings and inline formatting", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "md2html__convert")!;
    const res = await t.execute("tc1", { markdown: "# Title\n**bold** and *italic*" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("<h1>Title</h1>");
    expect(text).toContain("<strong>bold</strong>");
    expect(text).toContain("<em>italic</em>");
  });

  it("html2text__strip removes tags", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "html2text__strip")!;
    const res = await t.execute("tc1", { html: "<p>Hello <b>world</b></p>" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("Hello world");
  });

  it("sentiment__analyze scores positive/negative text", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "sentiment__analyze")!;
    const pos = await t.execute("tc1", { text: "This is great and wonderful" }, undefined, undefined, {} as any);
    expect((pos.content[0] as any).text).toContain("positive");
    const neg = await t.execute("tc2", { text: "This is terrible and awful" }, undefined, undefined, {} as any);
    expect((neg.content[0] as any).text).toContain("negative");
  });

  it("readability__score returns a Flesch score", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "readability__score")!;
    const res = await t.execute("tc1", { text: "The cat sat on the mat. It was happy." }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toMatch(/Flesch:/);
  });

  it("grammar__count counts words/sentences", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "grammar__count")!;
    const res = await t.execute("tc1", { text: "One. Two. Three words here." }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toMatch(/5 words.*3 sentences/);
  });

  it("emoji__info finds and counts emoji", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "emoji__info")!;
    const res = await t.execute("tc1", { text: "hi 🚀🚀🎉" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("3 emoji");
    expect(text).toContain("2 unique");
  });

  it("currency__format formats a number as USD", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "currency__format")!;
    const res = await t.execute("tc1", { amount: 1234.5, currency: "USD" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toMatch(/\$1,234\.50/);
  });

  it("number__format groups and rounds", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "number__format")!;
    const res = await t.execute("tc1", { value: 1234567, decimals: 0 }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("1,234,567");
  });

  it("datefmt__format formats an ISO date", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "datefmt__format")!;
    const res = await t.execute("tc1", { iso: "2024-01-15T10:00:00Z", timezone: "UTC" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("2024");
  });

  it("morse__encode and morse__decode round-trip", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const enc = tools.find((x) => x.name === "morse__encode")!;
    const dec = tools.find((x) => x.name === "morse__decode")!;
    const e = await enc.execute("tc1", { text: "SOS" }, undefined, undefined, {} as any);
    expect((e.content[0] as any).text).toBe("... --- ...");
    const d = await dec.execute("tc2", { morse: "... --- ..." }, undefined, undefined, {} as any);
    expect((d.content[0] as any).text).toBe("SOS");
  });

  it("rot13__apply is self-inverse", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "rot13__apply")!;
    const e = await t.execute("tc1", { text: "Hello" }, undefined, undefined, {} as any);
    const d = await t.execute("tc2", { text: (e.content[0] as any).text }, undefined, undefined, {} as any);
    expect((d.content[0] as any).text).toBe("Hello");
  });

  it("roman__from_number and roman__to_number round-trip", async () => {
    await mgr.seedDefaults();
    const tools = mgr.getConnectedTools();
    const from = tools.find((x) => x.name === "roman__from_number")!;
    const to = tools.find((x) => x.name === "roman__to_number")!;
    const r = await from.execute("tc1", { number: 2024 }, undefined, undefined, {} as any);
    expect((r.content[0] as any).text).toContain("MMXXIV");
    const n = await to.execute("tc2", { roman: "MMXXIV" }, undefined, undefined, {} as any);
    expect((n.content[0] as any).text).toContain("2024");
  });

  it("leet__convert substitutes letters", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "leet__convert")!;
    const res = await t.execute("tc1", { text: "leet" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toBe("1337");
  });

  it("piglatin__convert moves consonant clusters", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "piglatin__convert")!;
    const res = await t.execute("tc1", { text: "hello world" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("ello");
    expect(text).toContain("ay");
  });

  it("haiku__generate produces a 3-line poem", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "haiku__generate")!;
    const res = await t.execute("tc1", { topic: "code" }, undefined, undefined, {} as any);
    const lines = (res.content[0] as any).text.split("\n");
    expect(lines).toHaveLength(3);
  });

  it("weather__current returns data or error (live)", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "weather__current")!;
    const res = await t.execute("tc1", { location: "London" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    if (!res.isError) expect(text).toMatch(/°C/);
    else expect(text).toMatch(/lookup failed/i);
  }, 20000);

  it("isbn__lookup returns book data or not-found (live)", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "isbn__lookup")!;
    const res = await t.execute("tc1", { isbn: "9780140328721" }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    if (!res.isError) expect(text).toMatch(/"[^"]+"/); // title in quotes
    else expect(text).toMatch(/No book found|lookup failed/i);
  }, 20000);

  it("palindrome__check detects palindromes", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "palindrome__check")!;
    const yes = await t.execute("tc1", { text: "A man a plan a canal Panama" }, undefined, undefined, {} as any);
    expect((yes.content[0] as any).text).toContain("IS a palindrome");
    const no = await t.execute("tc2", { text: "hello world" }, undefined, undefined, {} as any);
    expect((no.content[0] as any).text).toContain("NOT");
  });

  it("anagram__check compares words", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "anagram__check")!;
    const yes = await t.execute("tc1", { a: "listen", b: "silent" }, undefined, undefined, {} as any);
    expect((yes.content[0] as any).text).toContain("ARE anagrams");
    const no = await t.execute("tc2", { a: "hello", b: "world" }, undefined, undefined, {} as any);
    expect((no.content[0] as any).text).toContain("NOT");
  });

  it("caesar__shift shifts by N", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "caesar__shift")!;
    const res = await t.execute("tc1", { text: "abc", shift: 3 }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toBe("def");
  });

  it("atbash__apply is self-inverse", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "atbash__apply")!;
    const e = await t.execute("tc1", { text: "Hello" }, undefined, undefined, {} as any);
    const d = await t.execute("tc2", { text: (e.content[0] as any).text }, undefined, undefined, {} as any);
    expect((d.content[0] as any).text).toBe("Hello");
  });

  it("binconv__convert round-trips text->binary->text", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "binconv__convert")!;
    const enc = await t.execute("tc1", { input: "Hi" }, undefined, undefined, {} as any);
    expect((enc.content[0] as any).text).toMatch(/^01001/);
    const dec = await t.execute("tc2", { input: (enc.content[0] as any).text }, undefined, undefined, {} as any);
    expect((dec.content[0] as any).text).toBe("Hi");
  });

  it("textcase__convert converts to snake_case", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "textcase__convert")!;
    const res = await t.execute("tc1", { text: "Hello World Foo", to: "snake" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toBe("hello_world_foo");
  });

  it("wordfreq__count returns top words", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "wordfreq__count")!;
    const res = await t.execute("tc1", { text: "the the the cat cat dog", topN: 3 }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text.split("\n")[0]).toContain("the: 3");
  });

  it("textstats__analyze returns detailed stats", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "textstats__analyze")!;
    const res = await t.execute("tc1", { text: "hello world foo" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("3 words");
  });

  it("langdetect__detect identifies Latin script languages", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "langdetect__detect")!;
    const en = await t.execute("tc1", { text: "the quick brown fox is running" }, undefined, undefined, {} as any);
    expect((en.content[0] as any).text).toContain("English");
  });

  it("sortlines__sort sorts alphabetically", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "sortlines__sort")!;
    const res = await t.execute("tc1", { text: "banana\napple\ncherry" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("apple\nbanana\ncherry");
  });

  it("dedupe__lines removes duplicates", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "dedupe__lines")!;
    const res = await t.execute("tc1", { text: "a\nb\na\nc\nb" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toBe("a\nb\nc");
  });

  it("strdist__levenshtein computes edit distance", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "strdist__levenshtein")!;
    const res = await t.execute("tc1", { a: "kitten", b: "sitting" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("3");
  });

  it("percentile__compute returns the p-th value", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "percentile__compute")!;
    const res = await t.execute("tc1", { numbers: [1, 2, 3, 4, 5], p: 50 }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("3");
  });


  it("prime__check identifies primes", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "prime__check")!;
    const yes = await t.execute("tc1", { number: 17 }, undefined, undefined, {} as any);
    expect((yes.content[0] as any).text).toContain("IS prime");
    const no = await t.execute("tc2", { number: 15 }, undefined, undefined, {} as any);
    expect((no.content[0] as any).text).toContain("NOT prime");
  });

  it("ordinal__convert produces ordinals", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "ordinal__convert")!;
    const res = await t.execute("tc1", { number: 42 }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("42nd");
  });

  it("mdlinks__extract finds markdown links", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "mdlinks__extract")!;
    const res = await t.execute("tc1", { markdown: "[click](https://x.com) here" }, undefined, undefined, {} as any);
    expect((res.content[0] as any).text).toContain("click: https://x.com");
  });

  it("mathops__gcd_lcm computes GCD and LCM", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "mathops__gcd_lcm")!;
    const res = await t.execute("tc1", { a: 12, b: 18 }, undefined, undefined, {} as any);
    const text = (res.content[0] as any).text;
    expect(text).toContain("GCD(12, 18) = 6");
    expect(text).toContain("LCM = 36");
  });

  it("wrap__text wraps to width", async () => {
    await mgr.seedDefaults();
    const t = mgr.getConnectedTools().find((x) => x.name === "wrap__text")!;
    const res = await t.execute("tc1", { text: "one two three four five", width: 10 }, undefined, undefined, {} as any);
    const lines = (res.content[0] as any).text.split("\n");


    for (const l of lines) expect(l.length).toBeLessThanOrEqual(10);
  });
});
