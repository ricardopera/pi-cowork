import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCommand,
  listCommands,
  executeCommand,
  getCommand,
} from "../src/pi/commands.js";

// The built-in commands are registered on module import. We test them plus a
// custom-registered command and the dispatch logic.

describe("slash commands", () => {
  it("registers built-in commands on import", () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["help", "todo", "doc", "research", "memory", "clear", "stop"]),
    );
  });

  it("registers a custom command", () => {
    registerCommand({
      name: "ping",
      description: "pong",
      async execute() {
        return { reply: "pong" };
      },
    });
    expect(getCommand("ping")).toBeTruthy();
  });

  it("non-command text returns an inject", async () => {
    const result = await executeCommand("s1", "hello there");
    expect(result.inject).toBe("hello there");
  });

  it("unknown command returns a helpful reply", async () => {
    const result = await executeCommand("s1", "/nonexistent");
    expect(result.reply).toContain("Unknown command");
  });

  it("/help lists commands", async () => {
    const result = await executeCommand("s1", "/help");
    expect(result.reply).toContain("Commands:");
    expect(result.reply).toContain("/todo");
  });

  it("/todo produces an inject instruction", async () => {
    const result = await executeCommand("s1", "/todo research, draft, review");
    expect(result.inject).toContain("research");
    expect(result.inject).toContain("draft");
    expect(result.inject).toContain("review");
  });

  it("/doc validates format", async () => {
    const bad = await executeCommand("s1", "/doc xyz some topic");
    expect(bad.reply).toContain("Usage");
    const noTopic = await executeCommand("s1", "/doc pdf");
    expect(noTopic.reply).toContain("topic");
    const ok = await executeCommand("s1", "/doc pdf quarterly report");
    expect(ok.inject).toContain("pdf");
    expect(ok.inject).toContain("quarterly report");
  });

  it("/research produces an inject", async () => {
    const result = await executeCommand("s1", "/research quantum computing");
    expect(result.inject).toContain("quantum computing");
  });

  it("/clear returns the clear flag", async () => {
    const result = await executeCommand("s1", "/clear");
    expect(result.clear).toBe(true);
  });

  it("passes args after the command name", async () => {
    registerCommand({
      name: "echo",
      description: "echo args",
      async execute(_sid, args) {
        return { reply: `echo: ${args}` };
      },
    });
    const result = await executeCommand("s1", "/echo hello world");
    expect(result.reply).toBe("echo: hello world");
  });
});
