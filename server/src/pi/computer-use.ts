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
      shift: K.ShiftLeft,
      control: K.ControlLeft,
      ctrl: K.ControlLeft,
      alt: K.AltLeft,
      cmd: K.MetaLeft,
      meta: K.MetaLeft,
      win: K.MetaLeft,
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

  return [screenshot, mouseMove, click, drag, scroll, type, key];
}

export const COMPUTER_USE_TOOL_NAMES = [
  "computer_screenshot",
  "computer_mouse_move",
  "computer_click",
  "computer_drag",
  "computer_scroll",
  "computer_type",
  "computer_key",
];
