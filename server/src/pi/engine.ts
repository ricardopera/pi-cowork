import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getAuthStorage, getModelRegistry } from "./providers.js";
import type { WireEvent } from "../event-schema.js";

export interface CreatePiSessionOptions {
  sessionId: string;
  cwd: string;
  model?: Model<any>;
  tools?: string[];
  /** if true, do not persist session JSONL (used in some tests) */
  inMemory?: boolean;
}

export interface PiSessionHandle {
  sessionId: string;
  session: AgentSession;
  onEvent: (handler: (e: WireEvent) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
}

/** Pure mapper from a Pi AgentEvent to our wire event. Exported for unit tests. */
export function piEventToWireEvent(sessionId: string, event: any): WireEvent | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start", sessionId };
    case "agent_end":
      return { type: "agent_end", sessionId };
    case "message_start":
      return { type: "message_start", sessionId, role: "assistant" };
    case "message_end":
      return { type: "message_end", sessionId };
    case "message_update": {
      const sub = event.assistantMessageEvent;
      if (!sub) return null;
      if (sub.type === "text_delta")
        return { type: "text_delta", sessionId, delta: sub.delta ?? "" };
      if (sub.type === "thinking_delta")
        return { type: "thinking_delta", sessionId, delta: sub.delta ?? "" };
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool_start",
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: !!event.isError,
      };
    case "turn_end":
      return { type: "turn_end", sessionId };
    case "compaction_start":
      return { type: "status", sessionId, status: "compacting", message: event.reason };
    case "compaction_end":
      return { type: "status", sessionId, status: "idle" };
    case "auto_retry_start":
      return { type: "status", sessionId, status: "retrying", message: event.errorMessage };
    case "auto_retry_end":
      return { type: "status", sessionId, status: event.success ? "idle" : "error" };
    default:
      return null;
  }
}

export async function createPiSession(opts: CreatePiSessionOptions): Promise<PiSessionHandle> {
  const cwd = opts.cwd;
  const { session } = await createAgentSession({
    cwd,
    model: opts.model,
    authStorage: getAuthStorage(),
    modelRegistry: getModelRegistry(),
    tools: opts.tools ?? ["read", "bash", "edit", "write", "grep"],
    sessionManager: opts.inMemory
      ? SessionManager.inMemory(cwd)
      : SessionManager.create(cwd),
  });

  const listeners = new Set<(e: WireEvent) => void>();
  const unsubscribe = session.subscribe((event: any) => {
    const wire = piEventToWireEvent(opts.sessionId, event);
    if (wire) for (const l of listeners) l(wire);
  });

  return {
    sessionId: opts.sessionId,
    session,
    onEvent: (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    prompt: (text: string) => session.prompt(text),
    abort: () => session.abort(),
    dispose: () => {
      unsubscribe();
      listeners.clear();
      session.dispose();
    },
  };
}
