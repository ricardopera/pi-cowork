import { describe, it, expect } from "vitest";
import {
  createComputerUseTools,
  COMPUTER_USE_TOOL_NAMES,
} from "../src/pi/computer-use.js";

// These tools drive the real desktop via nut-js. We test structure + validation
// here; live execution requires a display and is environment-dependent.

function tools() {
  return createComputerUseTools({ cwd: "/tmp", emitFiles: () => {} });
}
function byName(t: any[], name: string) {
  const found = t.find((x) => x.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("computer-use tools", () => {
  it("exports the expected tool names", () => {
    expect(COMPUTER_USE_TOOL_NAMES).toEqual(
      expect.arrayContaining([
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
        "computer_window_list",
        "computer_window_focus",
        "computer_ocr",
        "computer_color_pick",
        "computer_open_file",
        "computer_notify",
        "computer_display_info",
      ]),
    );
  });

  it("creates 27 tools with metadata", () => {
    const t = tools();
    expect(t.length).toBe(27);
    for (const tool of t) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("multi_click requires x, y, count", () => {
    const schema = byName(tools(), "computer_multi_click").parameters as any;
    expect(schema.required).toEqual(["x", "y", "count"]);
  });

  it("key_hold requires key + action", () => {
    const schema = byName(tools(), "computer_key_hold").parameters as any;
    expect(schema.required).toEqual(["key", "action"]);
    expect(schema.properties.action.enum).toEqual(["down", "up"]);
  });

  it("window_arrange requires index + position + size", () => {
    const schema = byName(tools(), "computer_window_arrange").parameters as any;
    expect(schema.required).toEqual(["index", "x", "y", "width", "height"]);
  });

  it("mouse_position and active_window take no required params", () => {
    expect((byName(tools(), "computer_mouse_position").parameters as any).required ?? []).toEqual([]);
    expect((byName(tools(), "computer_active_window").parameters as any).required ?? []).toEqual([]);
  });

  it("scroll_direction requires a direction", () => {
    const schema = byName(tools(), "computer_scroll_direction").parameters as any;
    expect(schema.properties.direction.enum).toEqual(["up", "down", "left", "right"]);
  });

  it("key_combo requires a combo", () => {
    const schema = byName(tools(), "computer_key_combo").parameters as any;
    expect(schema.required).toEqual(["combo"]);
  });

  it("modifier_click requires x, y, and modifiers", () => {
    const schema = byName(tools(), "computer_modifier_click").parameters as any;
    expect(schema.required).toEqual(expect.arrayContaining(["x", "y", "modifiers"]));
  });

  it("clipboard_write requires text", () => {
    const schema = byName(tools(), "computer_clipboard_write").parameters as any;
    expect(schema.required).toEqual(["text"]);
  });

  it("capture_regions requires prefix and regions", () => {
    const schema = byName(tools(), "computer_capture_regions").parameters as any;
    expect(schema.required).toEqual(expect.arrayContaining(["prefix", "regions"]));
  });

  it("window_focus accepts index or titleContains", () => {
    const schema = byName(tools(), "computer_window_focus").parameters as any;
    expect(schema.properties.index).toBeTruthy();
    expect(schema.properties.titleContains).toBeTruthy();
  });

  it("color_pick requires x and y", () => {
    const schema = byName(tools(), "computer_color_pick").parameters as any;
    expect(schema.required).toEqual(["x", "y"]);
  });

  it("open_file requires a target", () => {
    const schema = byName(tools(), "computer_open_file").parameters as any;
    expect(schema.required).toEqual(["target"]);
  });

  it("notify requires a title", () => {
    const schema = byName(tools(), "computer_notify").parameters as any;
    expect(schema.required).toEqual(["title"]);
  });

  it("display_info takes no required params", () => {
    const schema = byName(tools(), "computer_display_info").parameters as any;
    expect(schema.required ?? []).toEqual([]);
  });

  it("ocr optionally takes a region", () => {
    const schema = byName(tools(), "computer_ocr").parameters as any;
    expect(schema.properties.region).toBeTruthy();
    expect(schema.required ?? []).toEqual([]);
  });

  it("mouse_move requires x and y", () => {
    const schema = byName(tools(), "computer_mouse_move").parameters as any;
    expect(schema.required).toEqual(expect.arrayContaining(["x", "y"]));
  });

  it("type requires text", () => {
    const schema = byName(tools(), "computer_type").parameters as any;
    expect(schema.required).toEqual(expect.arrayContaining(["text"]));
  });

  it("key requires keys", () => {
    const schema = byName(tools(), "computer_key").parameters as any;
    expect(schema.required).toEqual(expect.arrayContaining(["keys"]));
  });

  it("drag requires all four coordinates", () => {
    const schema = byName(tools(), "computer_drag").parameters as any;
    expect(schema.required).toEqual(
      expect.arrayContaining(["fromX", "fromY", "toX", "toY"]),
    );
  });

  it("click supports button + double options", () => {
    const schema = byName(tools(), "computer_click").parameters as any;
    expect(schema.properties.button.enum).toEqual(["left", "right", "middle"]);
    expect(schema.properties.double).toBeTruthy();
  });

  it("screenshot requires a filename", () => {
    const schema = byName(tools(), "computer_screenshot").parameters as any;
    expect(schema.required).toEqual(["filename"]);
  });
});
