import path from "node:path";
import fs from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent/dist/core/extensions/types.js";
import type { PresentedFile } from "../event-schema.js";

/**
 * Chrome / browser control tools via Playwright, mirroring Cowork's "Claude in
 * Chrome" capability. A single browser instance is shared across calls within a
 * session and launched lazily. Screenshots are saved as deliverables (present_files).
 *
 * Safety: by default these are read/research oriented. Sensitive actions (logins,
 * purchases, form submissions) should be gated by ask_question in practice.
 */

export interface ChromeToolDeps {
  /** Workspace cwd — screenshots save to <cwd>/outputs/. */
  cwd: string;
  /** Emit present_files for screenshots. */
  emitFiles: (files: PresentedFile[]) => void;
}

// Module-level browser state (one chromium instance per process; tools are
// per-session but the browser is heavy, so we share it).
let browserPromise: Promise<any> | null = null;

async function getBrowser(): Promise<any> {
  if (!browserPromise) {
    const { chromium } = await import("playwright");
    browserPromise = chromium.launch({ headless: true }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

// One page per session id (simple 1:1 mapping; sufficient for the web app).
const pages = new Map<string, any>();

async function getPage(sessionKey: string): Promise<any> {
  if (pages.has(sessionKey)) return pages.get(sessionKey);
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (compatible; Pi-Cowork/0.1; +https://github.com/pi-cowork)",
  });
  const page = await ctx.newPage();
  pages.set(sessionKey, page);
  return page;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export async function closeAllPages(): Promise<void> {
  for (const [, page] of pages) {
    try {
      await page.context().close();
    } catch {
      /* ignore */
    }
  }
  pages.clear();
}

export async function closeBrowser(): Promise<void> {
  await closeAllPages();
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      /* ignore */
    }
    browserPromise = null;
  }
}

export function createChromeTools(deps: ChromeToolDeps): ToolDefinition[] {
  const sessionKey = deps.cwd; // one page per workspace

  const navigate = defineTool({
    name: "browser_navigate",
    label: "Open a webpage",
    description:
      "Navigate the headless browser to a URL and return the page title + a text snippet. " +
      "Use for web research. Returns title, url, and the first ~1000 chars of visible text.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to." },
        waitMs: { type: "number", description: "Optional extra wait after load (ms)." },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      const { url, waitMs } = params as { url: string; waitMs?: number };
      const page = await getPage(sessionKey);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (waitMs) await page.waitForTimeout(waitMs);
      const title = await page.title();
      const text = trunc(
        (await page.evaluate(() => document.body?.innerText ?? "")).trim(),
        1000,
      );
      return {
        content: [
          { type: "text", text: `Navigated to ${url}\nTitle: ${title}\n\n${text}` },
        ],
        details: { url, title },
      };
    },
  });

  const click = defineTool({
    name: "browser_click",
    label: "Click on page",
    description:
      "Click an element on the current page by CSS selector or visible text. " +
      "Use for interacting with pages during research or automation.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector OR visible text to click." },
        by: { type: "string", enum: ["selector", "text"], description: "Default: selector." },
      },
      required: ["selector"],
    },
    async execute(_id, params) {
      const { selector, by } = params as { selector: string; by?: "selector" | "text" };
      const page = await getPage(sessionKey);
      try {
        if (by === "text") {
          await page.getByText(selector, { exact: false }).first().click({ timeout: 10000 });
        } else {
          await page.click(selector, { timeout: 10000 });
        }
        return {
          content: [{ type: "text", text: `Clicked ${by ?? "selector"}: ${selector}` }],
          details: { selector, by: by ?? "selector" },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Click failed: ${e?.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  const type = defineTool({
    name: "browser_type",
    label: "Type into page",
    description: "Type text into a form field identified by CSS selector, then optionally press Enter.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        pressEnter: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["selector", "text"],
    },
    async execute(_id, params) {
      const { selector, text, pressEnter } = params as {
        selector: string;
        text: string;
        pressEnter?: boolean;
      };
      const page = await getPage(sessionKey);
      try {
        await page.fill(selector, text, { timeout: 10000 });
        if (pressEnter) await page.press(selector, "Enter");
        return {
          content: [{ type: "text", text: `Typed into ${selector}${pressEnter ? " + Enter" : ""}` }],
          details: { selector },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Type failed: ${e?.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  const scrape = defineTool({
    name: "browser_scrape",
    label: "Extract page content",
    description:
      "Extract structured content from the current page. By default returns the full visible text. " +
      "Optionally extract text/attrs from elements matching a CSS selector.",
    parameters: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector. If given, returns matched elements' text.",
        },
        attribute: {
          type: "string",
          description: "Optional attribute to extract (with selector), e.g. 'href'.",
        },
        maxChars: { type: "number", description: "Truncate result (default 5000)." },
      },
    },
    async execute(_id, params) {
      const { selector, attribute, maxChars } = params as {
        selector?: string;
        attribute?: string;
        maxChars?: number;
      };
      const limit = maxChars ?? 5000;
      const page = await getPage(sessionKey);
      let result: string;
      if (selector) {
        result = await page.evaluate(
          ({ sel, attr }) => {
            const els = Array.from(document.querySelectorAll(sel));
            return els
              .map((e) => (attr ? e.getAttribute(attr) : (e as HTMLElement).innerText))
              .filter(Boolean)
              .join("\n");
          },
          { sel: selector, attr: attribute ?? null },
        );
      } else {
        result = await page.evaluate(() => document.body?.innerText ?? "");
      }
      return {
        content: [{ type: "text", text: trunc(result.trim(), limit) }],
        details: { selector, attribute, chars: result.length },
      };
    },
  });

  const screenshot = defineTool({
    name: "browser_screenshot",
    label: "Capture screenshot",
    description:
      "Take a screenshot of the current page and save it as a PNG deliverable. " +
      "Returns the file path. Useful for visual verification.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'page.png'." },
        fullPage: { type: "boolean", description: "Capture full scrollable page (default false)." },
      },
      required: ["filename"],
    },
    async execute(_id, params) {
      const { filename, fullPage } = params as { filename: string; fullPage?: boolean };
      const page = await getPage(sessionKey);
      const outDir = path.join(deps.cwd, "outputs");
      await fs.mkdir(outDir, { recursive: true });
      const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
      const fullPath = path.join(outDir, safe.endsWith(".png") ? safe : `${safe}.png`);
      await page.screenshot({ path: fullPath, fullPage: !!fullPage });
      const stat = await fs.stat(fullPath);
      const file: PresentedFile = {
        name: path.basename(fullPath),
        path: path.relative(deps.cwd, fullPath),
        format: "other",
        sizeBytes: stat.size,
      };
      deps.emitFiles([file]);
      return {
        content: [{ type: "text", text: `Screenshot saved to ${file.path} (${file.sizeBytes} bytes).` }],
        details: { file },
      };
    },
  });

  const close = defineTool({
    name: "browser_close",
    label: "Close browser",
    description: "Close the current browser page/context. Use when done with browser automation to free resources.",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const page = pages.get(sessionKey);
        if (page) {
          await page.context().close();
          pages.delete(sessionKey);
        }
        return { content: [{ type: "text", text: "Browser page closed." }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Close error: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });

  return [navigate, click, type, scrape, screenshot, close];
}

export const CHROME_TOOL_NAMES = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scrape",
  "browser_screenshot",
  "browser_close",
];
