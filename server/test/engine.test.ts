import { describe, it, expect } from "vitest";
import { piEventToWireEvent } from "../src/pi/engine.js";

describe("pi-engine event mapping", () => {
  it("maps a text_delta event", () => {
    const wire = piEventToWireEvent("session-1", {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "hi", partial: {} },
    });
    expect(wire).toEqual({ type: "text_delta", sessionId: "session-1", delta: "hi" });
  });

  it("maps a thinking_delta event", () => {
    const wire = piEventToWireEvent("s1", {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm", partial: {} },
    });
    expect(wire).toEqual({ type: "thinking_delta", sessionId: "s1", delta: "hmm" });
  });

  it("maps a tool_execution_start event", () => {
    const wire = piEventToWireEvent("s1", {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(wire).toEqual({
      type: "tool_start",
      sessionId: "s1",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
    });
  });

  it("maps a tool_execution_end event", () => {
    const wire = piEventToWireEvent("s1", {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
      result: { content: [{ type: "text", text: "a\nb" }] },
      isError: false,
    });
    expect(wire).toMatchObject({ type: "tool_end", toolName: "bash", isError: false });
  });

  it("maps lifecycle and status events", () => {
    expect(piEventToWireEvent("s", { type: "agent_start" })?.type).toBe("agent_start");
    expect(piEventToWireEvent("s", { type: "agent_end" })?.type).toBe("agent_end");
    expect(piEventToWireEvent("s", { type: "turn_end" })?.type).toBe("turn_end");
    expect(
      piEventToWireEvent("s", { type: "compaction_start", reason: "size" })?.type,
    ).toBe("status");
    expect(
      piEventToWireEvent("s", { type: "auto_retry_start", errorMessage: "x" })?.type,
    ).toBe("status");
  });

  it("returns null for events we don't surface", () => {
    expect(piEventToWireEvent("s", { type: "agent_settled" })).toBeNull();
    expect(piEventToWireEvent("s", { type: "queue_update" })).toBeNull();
  });
});

describe("safety", () => {
  it("allows benign commands", async () => {
    const { checkBash } = await import("../src/safety.js");
    expect(checkBash("ls -la").allowed).toBe(true);
    expect(checkBash("echo hello").allowed).toBe(true);
  });
  it("blocks destructive commands", async () => {
    const { checkBash } = await import("../src/safety.js");
    expect(checkBash("rm -rf /").allowed).toBe(false);
    expect(checkBash("rm -rf ~").allowed).toBe(false);
    expect(checkBash("mkfs.ext4 /dev/sda").allowed).toBe(false);
    expect(checkBash("shutdown now").allowed).toBe(false);
  });
});
