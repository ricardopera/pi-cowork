import path from "node:path";
import fs from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent/dist/core/extensions/types.js";
import type { PresentedFile } from "../event-schema.js";

/**
 * Computer-use tools (Cowork's headline desktop-automation feature): screenshots,
 * mouse move/click/drag/scroll, and keyboard typing. Uses @nut-tree-fork/nut-js
 * for cross-platform native input. Screenshots are surfaced as deliverables.
 *
 * Safety: these control the real desktop. They are provided for parity; in a
 * headless/server context the screen may be virtual. Coordinate-based actions
 * should be guided by a prior screenshot. Sensitive UI (passwords, payments,
 * confirmations) should be gated by ask_question in practice.
 */

export interface ComputerUseDeps {
  cwd: string;
  emitFiles: (files: PresentedFile[]) => void;
}

let nutLoaded: any = null;
async function getNut(): Promise<any> {
  if (!nutLoaded) {
    nutLoaded = await import("@nut-tree-fork/nut-js");
    // Configure for sane defaults.
    nutLoaded.mouse.config.mouseSpeed = 1000;
    nutLoaded.keyboard.config.autoDelayMs = 10;
  }
  return nutLoaded;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const SCREENSHOT_FORMAT = "png";

export function createComputerUseTools(deps: ComputerUseDeps): ToolDefinition[] {
  const screenshot = defineTool({
    name: "computer_screenshot",
    label: "Capture desktop screenshot",
    description:
      "Capture a screenshot of the desktop and save it as a PNG deliverable. " +
      "Returns the image path. Use this to see the current screen state before " +
      "clicking or typing. Essential for computer-use workflows.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'screen.png'." },
        region: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          description: "Optional capture region (defaults to full screen).",
        },
      },
      required: ["filename"],
    },
    async execute(_id, params) {
      const { filename, region } = params as {
        filename: string;
        region?: { x: number; y: number; width: number; height: number };
      };
      const nut = await getNut();
      let img: any;
      if (region) {
        img = await nut.screen.capture(
          new nut.Region(region.x, region.y, region.width, region.height),
        );
      } else {
        img = await nut.screen.capture();
      }
      const outDir = path.join(deps.cwd, "outputs");
      await fs.mkdir(outDir, { recursive: true });
      const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
      const fullPath = path.join(outDir, safe.endsWith(".png") ? safe : `${safe}.png`);
      // nut-js capture returns an Image with .toRGB()/data; write via its helper.
      await img.toFile(fullPath);
      const stat = await fs.stat(fullPath);
      const file: PresentedFile = {
        name: path.basename(fullPath),
        path: path.relative(deps.cwd, fullPath),
        format: "other",
        sizeBytes: stat.size,
      };
      deps.emitFiles([file]);
      return {
        content: [
          {
            type: "text",
            text: `Screenshot saved to ${file.path} (${file.sizeBytes} bytes). Inspect it to plan your next action.`,
          },
        ],
        details: { file },
      };
    },
  });

  const mouseMove = defineTool({
    name: "computer_mouse_move",
    label: "Move mouse",
    description: "Move the mouse cursor to absolute screen coordinates (x, y).",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Absolute X coordinate (pixels)." },
        y: { type: "number", description: "Absolute Y coordinate (pixels)." },
      },
      required: ["x", "y"],
    },
    async execute(_id, params) {
      const { x, y } = params as { x: number; y: number };
      const nut = await getNut();
      await nut.mouse.setPosition(new nut.Point(x, y));
      return { content: [{ type: "text", text: `Moved mouse to (${x}, ${y}).` }], details: { x, y } };
    },
  });

  const click = defineTool({
    name: "computer_click",
    label: "Click mouse",
    description:
      "Click the mouse at a position. If x/y given, moves there first; otherwise clicks at the current position.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default: left." },
        double: { type: "boolean", description: "Double-click." },
      },
    },
    async execute(_id, params) {
      const { x, y, button, double } = params as {
        x?: number;
        y?: number;
        button?: "left" | "right" | "middle";
        double?: boolean;
      };
      const nut = await getNut();
      if (x != null && y != null) await nut.mouse.setPosition(new nut.Point(x, y));
      const btn =
        button === "right" ? nut.Button.RIGHT : button === "middle" ? nut.Button.MIDDLE : nut.Button.LEFT;
      if (double) {
        await nut.mouse.doubleClick(btn);
      } else {
        await nut.mouse.leftClick();
        // leftClick ignores btn; for right/middle use click
        if (button === "right" || button === "middle") {
          await nut.mouse.click(btn);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `${double ? "Double-" : ""}Clicked ${button ?? "left"}${x != null ? ` at (${x}, ${y})` : ""}.`,
          },
        ],
        details: { x, y, button, double },
      };
    },
  });

  const drag = defineTool({
    name: "computer_drag",
    label: "Drag mouse",
    description: "Drag the mouse from (fromX, fromY) to (toX, toY).",
    parameters: {
      type: "object",
      properties: {
        fromX: { type: "number" },
        fromY: { type: "number" },
        toX: { type: "number" },
        toY: { type: "number" },
      },
      required: ["fromX", "fromY", "toX", "toY"],
    },
    async execute(_id, params) {
      const { fromX, fromY, toX, toY } = params as {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
      };
      const nut = await getNut();
      await nut.mouse.drag(new nut.Point(toX, toY));
      return {
        content: [{ type: "text", text: `Dragged to (${toX}, ${toY}).` }],
        details: { fromX, fromY, toX, toY },
      };
    },
  });

  const scroll = defineTool({
    name: "computer_scroll",
    label: "Scroll",
    description: "Scroll the mouse wheel. Positive amount scrolls down, negative up.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Scroll amount (positive=down, negative=up)." },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["amount"],
    },
    async execute(_id, params) {
      const { amount, x, y } = params as { amount: number; x?: number; y?: number };
      const nut = await getNut();
      if (x != null && y != null) await nut.mouse.setPosition(new nut.Point(x, y));
      await nut.mouse.scrollDown(amount > 0 ? amount : 0);
      if (amount < 0) await nut.mouse.scrollUp(-amount);
      return {
        content: [{ type: "text", text: `Scrolled ${amount > 0 ? "down" : "up"} by ${Math.abs(amount)}.` }],
        details: { amount },
      };
    },
  });

  const type = defineTool({
    name: "computer_type",
    label: "Type text",
    description: "Type a string of text at the current focus. Use computer_key for special keys.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const nut = await getNut();
      await nut.keyboard.type(trunc(text, 4000));
      return {
        content: [{ type: "text", text: `Typed ${text.length} character(s).` }],
        details: { length: text.length },
      };
    },
  });

  const key = defineTool({
    name: "computer_key",
    label: "Press key(s)",
    description:
      "Press one or more keys (e.g. 'Enter', 'Escape', 'Tab', 'Control+c'). Use '+' for combos.",
    parameters: {
      type: "object",
      properties: {
        keys: { type: "string", description: "Key or combo, e.g. 'Enter', 'Control+c', 'Shift+Tab'." },
      },
      required: ["keys"],
    },
    async execute(_id, params) {
      const { keys } = params as { keys: string };
      const nut = await getNut();
      // Map common names to nut Key enum; support combos via '+'.
      const parts = keys.split("+").map((k) => k.trim());
      const mapped = parts.map(mapKey);
      if (mapped.length === 1) {
        await nut.keyboard.pressKey(mapped[0]);
        await nut.keyboard.releaseKey(mapped[0]);
      } else {
        await nut.keyboard.pressKey(...mapped);
        await nut.keyboard.releaseKey(...mapped);
      }
      return {
        content: [{ type: "text", text: `Pressed: ${keys}.` }],
        details: { keys },
      };
    },
  });

  function mapKey(name: string): any {
    const nut = nutLoaded;
    const K = nut.Key;
    const map: Record<string, any> = {
      enter: K.Enter,
      return: K.Enter,
      escape: K.Escape,
      esc: K.Escape,
      tab: K.Tab,
      space: K.Space,
      backspace: K.Backspace,
      delete: K.Delete,
      up: K.Up,
      down: K.Down,
      left: K.Left,
      right: K.Right,
      // Modifiers: this nut-js fork uses Left*/Right* names (not ShiftLeft).
      shift: K.LeftShift,
      control: K.LeftControl,
      ctrl: K.LeftControl,
      alt: K.LeftAlt,
      cmd: K.LeftCmd,
      meta: K.LeftMeta,
      win: K.LeftWin,
      home: K.Home,
      end: K.End,
      pageup: K.PageUp,
      pagedown: K.PageDown,
      f1: K.F1, f2: K.F2, f3: K.F3, f4: K.F4, f5: K.F5, f6: K.F6,
      f7: K.F7, f8: K.F8, f9: K.F9, f10: K.F10, f11: K.F11, f12: K.F12,
    };
    const lower = name.toLowerCase();
    if (map[lower]) return map[lower];
    // Single char -> letter/digit key
    if (name.length === 1) {
      if (/[a-z]/i.test(name)) return name.toUpperCase().charCodeAt(0); // nut accepts char codes for letters
      if (/[0-9]/.test(name)) return name.charCodeAt(0);
    }
    throw new Error(`unknown key: ${name}`);
  }

  // ---- scroll_by (direction + amount) ----
  const scrollBy = defineTool({
    name: "computer_scroll_direction",
    label: "Scroll by direction",
    description:
      "Scroll the mouse wheel by direction. direction: up|down|left|right; amount defaults to 3 (ticks).",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number" },
      },
      required: ["direction"],
    },
    async execute(_id, params) {
      const { direction, amount } = params as { direction: string; amount?: number };
      const nut = await getNut();
      const n = amount ?? 3;
      if (direction === "down") await nut.mouse.scrollDown(n);
      else if (direction === "up") await nut.mouse.scrollUp(n);
      else if (direction === "right") await nut.mouse.scrollRight(n);
      else if (direction === "left") await nut.mouse.scrollLeft(n);
      else return { content: [{ type: "text", text: `Unknown direction: ${direction}` }], details: {}, isError: true };
      return { content: [{ type: "text", text: `Scrolled ${direction} by ${n}.` }], details: { direction, amount: n } };
    },
  });

  // ---- key combo / chord (Ctrl+C, Shift+Tab, Cmd+Shift+P, etc.) ----
  const keyCombo = defineTool({
    name: "computer_key_combo",
    label: "Press key combo (chord)",
    description:
      "Press a key combination as a chord, e.g. 'Control+c', 'Shift+Tab', 'Cmd+Shift+P'. " +
      "All keys are held and released together. Use '+' to separate keys.",
    parameters: {
      type: "object",
      properties: { combo: { type: "string", description: "e.g. 'Control+c', 'Shift+ArrowDown'." } },
      required: ["combo"],
    },
    async execute(_id, params) {
      const { combo } = params as { combo: string };
      const nut = await getNut();
      const parts = combo.split("+").map((k) => k.trim()).filter(Boolean);
      const mapped = parts.map(mapKey);
      await nut.keyboard.pressKey(...mapped);
      await nut.keyboard.releaseKey(...mapped);
      return { content: [{ type: "text", text: `Pressed combo: ${combo}.` }], details: { combo } };
    },
  });

  // ---- modifier + click (Shift+click, Control+click for multi-select) ----
  const modifierClick = defineTool({
    name: "computer_modifier_click",
    label: "Click with modifier held",
    description:
      "Click while holding a modifier (Shift/Control/Alt/Cmd). Useful for multi-select or " +
      "opening links in a new tab. modifiers: array like ['control'] or ['shift','alt'].",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        modifiers: { type: "array", items: { type: "string" }, description: "e.g. ['control'] or ['shift','cmd']." },
        button: { type: "string", enum: ["left", "right", "middle"] },
      },
      required: ["x", "y", "modifiers"],
    },
    async execute(_id, params) {
      const { x, y, modifiers, button } = params as { x: number; y: number; modifiers: string[]; button?: string };
      const nut = await getNut();
      await nut.mouse.setPosition(new nut.Point(x, y));
      const modKeys = modifiers.map(mapKey);
      for (const mk of modKeys) await nut.keyboard.pressKey(mk);
      const btn = button === "right" ? nut.Button.RIGHT : button === "middle" ? nut.Button.MIDDLE : nut.Button.LEFT;
      await nut.mouse.click(btn);
      for (const mk of modKeys) await nut.keyboard.releaseKey(mk);
      return {
        content: [{ type: "text", text: `Clicked at (${x}, ${y}) with ${modifiers.join("+")} held.` }],
        details: { x, y, modifiers },
      };
    },
  });

  // ---- clipboard read/write ----
  const clipboardRead = defineTool({
    name: "computer_clipboard_read",
    label: "Read clipboard",
    description: "Read the current text content of the system clipboard.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const nut = await getNut();
      const clip = nut.clipboard.providerRegistry.getClipboard();
      const text = await clip.paste();
      return {
        content: [{ type: "text", text: `Clipboard content:\n${text ?? "(empty)"}` }],
        details: { length: text ? text.length : 0 },
      };
    },
  });

  const clipboardWrite = defineTool({
    name: "computer_clipboard_write",
    label: "Write to clipboard",
    description: "Write text to the system clipboard.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(_id, params) {
      const { text } = params as { text: string };
      const nut = await getNut();
      const clip = nut.clipboard.providerRegistry.getClipboard();
      await clip.copy(text);
      return { content: [{ type: "text", text: `Wrote ${text.length} chars to clipboard.` }], details: { length: text.length } };
    },
  });

  // ---- wait for element (screen-level, by image/timeout placeholder) ----
  // nut-js screen.waitFor expects an image; for a generic "wait N ms" we provide
  // a simple timed wait plus an opacity-based element wait if an image path is given.
  const waitFor = defineTool({
    name: "computer_wait",
    label: "Wait (for UI to settle)",
    description:
      "Pause for a fixed duration (ms) to let the UI settle, or until a timeout. Use between " +
      "actions that trigger animations/transitions.",
    parameters: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Milliseconds to wait (default 500)." },
      },
    },
    async execute(_id, params) {
      const ms = (params as { ms?: number }).ms ?? 500;
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: "text", text: `Waited ${ms}ms.` }], details: { ms } };
    },
  });

  // ---- multi-region capture ----
  const captureRegions = defineTool({
    name: "computer_capture_regions",
    label: "Capture multiple screen regions",
    description:
      "Capture several regions of the screen in one call (e.g. top, left, right panes) and " +
      "save each as a PNG deliverable. regions: [{name, x, y, width, height}].",
    parameters: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Filename prefix for the captures." },
        regions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
            required: ["name", "x", "y", "width", "height"],
          },
        },
      },
      required: ["prefix", "regions"],
    },
    async execute(_id, params) {
      const { prefix, regions } = params as {
        prefix: string;
        regions: { name: string; x: number; y: number; width: number; height: number }[];
      };
      const nut = await getNut();
      const outDir = path.join(deps.cwd, "outputs");
      await fs.mkdir(outDir, { recursive: true });
      const files: PresentedFile[] = [];
      for (const r of regions) {
        const img = await nut.screen.capture(new nut.Region(r.x, r.y, r.width, r.height));
        const safe = `${prefix}-${r.name}`.replace(/[^a-zA-Z0-9._-]/g, "_");
        const fullPath = path.join(outDir, `${safe}.png`);
        await img.toFile(fullPath);
        const stat = await fs.stat(fullPath);
        files.push({
          name: path.basename(fullPath),
          path: path.relative(deps.cwd, fullPath),
          format: "other",
          sizeBytes: stat.size,
        });
      }
      deps.emitFiles(files);
      return {
        content: [{ type: "text", text: `Captured ${files.length} region(s): ${files.map((f) => f.name).join(", ")}.` }],
        details: { count: files.length },
      };
    },
  });

  return [screenshot, mouseMove, click, drag, scroll, scrollBy, type, key, keyCombo, modifierClick, clipboardRead, clipboardWrite, waitFor, captureRegions];
}

export const COMPUTER_USE_TOOL_NAMES = [
  "computer_screenshot",
  "computer_mouse_move",
  "computer_click",
  "computer_drag",
  "computer_scroll",
  "computer_scroll_direction",
  "computer_type",
  "computer_key",
  "computer_key_combo",
  "computer_modifier_click",
  "computer_clipboard_read",
  "computer_clipboard_write",
  "computer_wait",
  "computer_capture_regions",
];

