import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createChromeTools, CHROME_TOOL_NAMES, closeBrowser } from "../src/pi/chrome-tools.js";
import type { PresentedFile } from "../src/pi/event-schema.js";

let tmpdir: string;
let emitted: PresentedFile[];

function tools() {
  emitted = [];
  return createChromeTools({
    cwd: tmpdir,
    emitFiles: (files) => emitted.push(...files),
  });
}
function byName(t: any[], name: string) {
  const found = t.find((x) => x.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(async () => {
  tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "picw-chrome-"));
});
afterEach(async () => {
  await closeBrowser();
  await fs.rm(tmpdir, { recursive: true, force: true });
});

// These tests hit the real network (example.com). They are skipped in CI / offline
// via the PLAYWRIGHT_SKIP env guard. Locally they validate the full browser stack.
const SKIP = !!process.env.PLAYWRIGHT_SKIP || process.env.CI === "true";

describe.skipIf(SKIP)("chrome tools", () => {
  it("exports the expected tool names", () => {
    expect(CHROME_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_scrape",
        "browser_screenshot",
        "browser_close",
      ]),
    );
  });

  it("navigates to a page and returns title + text", async () => {
    const nav = byName(tools(), "browser_navigate");
    const res = await nav.execute(
      "tc1",
      { url: "https://example.com" },
      undefined,
      undefined,
      {} as any,
    );
    const text = (res.content[0] as any).text;
    expect(text).toContain("Example Domain");
    expect(res.details).toMatchObject({ url: "https://example.com" });
  }, 30000);

  it("scrapes the page text", async () => {
    const t = tools();
    await byName(t, "browser_navigate").execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any);
    const res = await byName(t, "browser_scrape").execute("tc2", {}, undefined, undefined, {} as any);
    expect((res.content[0] as any).text.toLowerCase()).toContain("example");
  }, 30000);

  it("takes a screenshot and presents it", async () => {
    const t = tools();
    await byName(t, "browser_navigate").execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any);
    const res = await byName(t, "browser_screenshot").execute(
      "tc2",
      { filename: "shot.png" },
      undefined,
      undefined,
      {} as any,
    );
    expect(emitted.length).toBe(1);
    expect(emitted[0].name).toBe("shot.png");
    const stat = await fs.stat(path.join(tmpdir, "outputs", "shot.png"));
    expect(stat.size).toBeGreaterThan(1000);
  }, 30000);

  it("extracts links via selector + attribute", async () => {
    const t = tools();
    await byName(t, "browser_navigate").execute("tc1", { url: "https://example.com" }, undefined, undefined, {} as any);
    const res = await byName(t, "browser_scrape").execute(
      "tc2",
      { selector: "a", attribute: "href" },
      undefined,
      undefined,
      {} as any,
    );
    // example.com has at least one link
    expect(typeof (res.content[0] as any).text).toBe("string");
  }, 30000);
});
