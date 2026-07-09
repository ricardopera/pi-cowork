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
  // Capture console messages into a per-page buffer for the browser_console tool.
  await ctx.addInitScript(() => {
    (window as any).__piCoworkConsole = [];
    for (const type of ["log", "info", "warning", "error", "debug"]) {
      const orig = (console as any)[type];
      (console as any)[type] = (...args: any[]) => {
        try {
          (window as any).__piCoworkConsole.push({ type, text: args.map(String).join(" ") });
          if ((window as any).__piCoworkConsole.length > 200)
            (window as any).__piCoworkConsole.shift();
        } catch {
          /* ignore */
        }
        orig.apply(console, args);
      };
    }
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

  // ---- tab management ----
  const tabList = defineTool({
    name: "browser_tab_list",
    label: "List open tabs",
    description: "List all open browser tabs (index, url, title) in the current session's context.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const page = await getPage(sessionKey);
      const ctx = page.context();
      const tabs = ctx.pages().map((p: any, i: number) => ({ index: i, url: p.url(), title: "" }));
      for (const t of tabs) {
        try {
          t.title = await ctx.pages()[t.index].title();
        } catch {
          /* tab may not have loaded */
        }
      }
      return {
        content: [{ type: "text", text: `${tabs.length} tab(s):\n${tabs.map((t: any) => `  [${t.index}] ${t.title || t.url}`).join("\n")}` }],
        details: { tabs },
      };
    },
  });

  const tabNew = defineTool({
    name: "browser_tab_new",
    label: "Open a new tab",
    description: "Open a new browser tab and navigate to a URL. Returns the new tab index.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(_id, params) {
      const { url } = params as { url: string };
      const page = await getPage(sessionKey);
      const ctx = page.context();
      const newPage = await ctx.newPage();
      await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      return {
        content: [{ type: "text", text: `Opened new tab at ${url}.` }],
        details: { index: ctx.pages().length - 1, url },
      };
    },
  });

  const tabSwitch = defineTool({
    name: "browser_tab_switch",
    label: "Switch to a tab",
    description: "Bring a tab (by index) to the front so subsequent actions target it.",
    parameters: {
      type: "object",
      properties: { index: { type: "number" } },
      required: ["index"],
    },
    async execute(_id, params) {
      const { index } = params as { index: number };
      const page = await getPage(sessionKey);
      const tabs = page.context().pages();
      const target = tabs[index];
      if (!target) return { content: [{ type: "text", text: `No tab at index ${index} (have ${tabs.length}).` }], details: {}, isError: true };
      await target.bringToFront();
      pages.set(sessionKey, target); // make subsequent getPage() target this tab
      return { content: [{ type: "text", text: `Switched to tab ${index}: ${target.url()}.` }], details: { index } };
    },
  });

  const tabClose = defineTool({
    name: "browser_tab_close",
    label: "Close a tab",
    description: "Close a tab by index. Cannot close the last remaining tab.",
    parameters: {
      type: "object",
      properties: { index: { type: "number" } },
      required: ["index"],
    },
    async execute(_id, params) {
      const { index } = params as { index: number };
      const page = await getPage(sessionKey);
      const tabs = page.context().pages();
      if (tabs.length <= 1) return { content: [{ type: "text", text: "Cannot close the last tab." }], details: {}, isError: true };
      const target = tabs[index];
      if (!target) return { content: [{ type: "text", text: `No tab at index ${index}.` }], details: {}, isError: true };
      await target.close();
      return { content: [{ type: "text", text: `Closed tab ${index}.` }], details: { index } };
    },
  });

  // ---- JS execution ----
  const jsExecute = defineTool({
    name: "browser_js",
    label: "Execute JavaScript on the page",
    description:
      "Execute a JavaScript expression in the page context and return its JSON-serialized result. " +
      "Use for scraping dynamic content, calling page APIs, or computing values. Must be a single expression.",
    parameters: {
      type: "object",
      properties: { script: { type: "string", description: "A JS expression, e.g. 'document.title' or 'JSON.stringify({links: [...document.querySelectorAll(\"a\")].length})'." } },
      required: ["script"],
    },
    async execute(_id, params) {
      const { script } = params as { script: string };
      const page = await getPage(sessionKey);
      try {
        const result = await page.evaluate(script);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text: trunc(text ?? "(undefined)", 5000) }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `JS error: ${e?.message}` }], details: {}, isError: true };
      }
    },
  });

  // ---- form fill ----
  const formFill = defineTool({
    name: "browser_form_fill",
    label: "Fill multiple form fields",
    description:
      "Fill several form fields at once. fields: [{selector, value}]. Faster than many browser_type calls.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: { selector: { type: "string" }, value: { type: "string" } },
            required: ["selector", "value"],
          },
        },
      },
      required: ["fields"],
    },
    async execute(_id, params) {
      const { fields } = params as { fields: { selector: string; value: string }[] };
      const page = await getPage(sessionKey);
      let filled = 0;
      const errors: string[] = [];
      for (const f of fields) {
        try {
          await page.fill(f.selector, f.value, { timeout: 8000 });
          filled++;
        } catch (e: any) {
          errors.push(`${f.selector}: ${e?.message}`);
        }
      }
      return {
        content: [{ type: "text", text: `Filled ${filled}/${fields.length} field(s).${errors.length ? " Errors: " + errors.join("; ") : ""}` }],
        details: { filled, total: fields.length, errors },
        isError: filled === 0 && fields.length > 0,
      };
    },
  });

  // ---- wait for selector ----
  const waitForSelector = defineTool({
    name: "browser_wait_for",
    label: "Wait for an element",
    description: "Wait until a CSS selector appears on the page (or timeout). state: attached|visible|hidden.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string" },
        state: { type: "string", enum: ["attached", "visible", "hidden"] },
        timeoutMs: { type: "number" },
      },
      required: ["selector"],
    },
    async execute(_id, params) {
      const { selector, state, timeoutMs } = params as { selector: string; state?: "attached" | "visible" | "hidden"; timeoutMs?: number };
      const page = await getPage(sessionKey);
      try {
        await page.waitForSelector(selector, { state: state ?? "visible", timeout: timeoutMs ?? 15000 });
        return { content: [{ type: "text", text: `Element "${selector}" is ${state ?? "visible"}.` }], details: { selector } };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Timeout waiting for "${selector}": ${e?.message}` }], details: {}, isError: true };
      }
    },
  });

  // ---- network-request inspection (last N requests) ----
  const networkRequests = defineTool({
    name: "browser_network",
    label: "List recent network requests",
    description:
      "Return the last N network requests (method, url, status, resourceType) captured since the page loaded. " +
      "Use for debugging APIs or page behavior. limit defaults to 25.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" }, filter: { type: "string", description: "Optional substring to filter URLs by." } },
    },
    async execute(_id, params) {
      const { limit, filter } = params as { limit?: number; filter?: string };
      const page = await getPage(sessionKey);
      // Attach a listener if not already collecting; collect from page performance + a live buffer.
      // Simplest robust approach: use Performance API via evaluate.
      const entries: any[] = await page.evaluate(() =>
        (performance.getEntriesByType("resource") as any[]).map((e) => ({
          url: e.name,
          duration: Math.round(e.duration),
          size: e.transferSize,
        })),
      );
      let filtered = filter ? entries.filter((e) => e.url.includes(filter)) : entries;
      const n = limit ?? 25;
      const recent = filtered.slice(-n).reverse();
      return {
        content: [{ type: "text", text: `${recent.length} request(s):\n${recent.map((e) => `  ${e.url.slice(0, 90)} (${e.duration}ms, ${e.size}B)`).join("\n")}` }],
        details: { count: recent.length },
      };
    },
  });

  // ---- console-message capture ----
  const consoleMessages = defineTool({
    name: "browser_console",
    label: "Capture console messages",
    description:
      "Return recent browser console messages (logs, warnings, errors) with their type and text. " +
      "Captures messages emitted since the page loaded.",
    parameters: {
      type: "object",
      properties: { level: { type: "string", enum: ["error", "warning", "info", "log", "debug"] } },
    },
    async execute(_id, params) {
      const level = (params as { level?: string }).level;
      const page = await getPage(sessionKey);
      // Read console messages via a fresh evaluate hook is unreliable post-hoc;
      // use the PerformanceEntry-free approach: collect from window if available,
      // else attach a buffer. Simplest: evaluate a captured buffer the page exposes.
      const msgs: any[] = await page.evaluate(() => (window as any).__piCoworkConsole ?? []);
      const filtered = level ? msgs.filter((m) => m.type === level) : msgs;
      return {
        content: [{ type: "text", text: filtered.length ? filtered.map((m) => `[${m.type}] ${m.text.slice(0, 200)}`).join("\n") : "(no console messages captured)" }],
        details: { count: filtered.length },
      };
    },
  });

  // Wire up console capture on every page by injecting a buffer via init script
  // (best-effort; runs once per context creation). We add it lazily here.
  void sessionKey; // sessionKey referenced above

  return [navigate, click, type, scrape, screenshot, close, tabList, tabNew, tabSwitch, tabClose, jsExecute, formFill, waitForSelector, networkRequests, consoleMessages];
}

export const CHROME_TOOL_NAMES = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scrape",
  "browser_screenshot",
  "browser_close",
  "browser_tab_list",
  "browser_tab_new",
  "browser_tab_switch",
  "browser_tab_close",
  "browser_js",
  "browser_form_fill",
  "browser_wait_for",
  "browser_network",
  "browser_console",
];
