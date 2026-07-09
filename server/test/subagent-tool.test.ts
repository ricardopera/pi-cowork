import { describe, it, expect } from "vitest";
import { createSubagentTool, SUBAGENT_TOOL_NAMES } from "../src/pi/subagent-tool.js";

describe("subagent tool", () => {
  it("exports the dispatch_subagents tool name", () => {
    expect(SUBAGENT_TOOL_NAMES).toEqual(["dispatch_subagents"]);
  });

  it("creates a tool with the right metadata", () => {
    const tool = createSubagentTool();
    expect(tool.name).toBe("dispatch_subagents");
    expect(tool.description).toContain("concurrently");
    expect(typeof tool.execute).toBe("function");
  });

  it("rejects an empty task list", async () => {
    const tool = createSubagentTool();
    const res = await tool.execute("tc1", { tasks: [] }, undefined, undefined, {} as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("No tasks");
  });

  it("rejects too many tasks (>12)", async () => {
    const tool = createSubagentTool();
    const tasks = Array.from({ length: 13 }, (_, i) => ({ task: `task ${i}` }));
    const res = await tool.execute("tc1", { tasks }, undefined, undefined, {} as any);
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("Too many");
  });

  it("parameters schema accepts a tasks array", () => {
    const tool = createSubagentTool();
    expect(tool.parameters).toBeTruthy();
    // TypeBox schema has the array property
    const schema = tool.parameters as any;
    expect(schema.properties).toBeTruthy();
    expect(schema.properties.tasks).toBeTruthy();
  });
});
