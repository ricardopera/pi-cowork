import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { getAuthStorage, getModelRegistry } from "./providers.js";
import { createCoworkTools } from "./cowork-tools.js";
import { createDocTools, DOC_TOOL_NAMES } from "./doc-tools.js";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory-tools.js";
import { createChromeTools, CHROME_TOOL_NAMES } from "./chrome-tools.js";
import { createArtifactTools, ARTIFACT_TOOL_NAMES } from "./artifacts.js";
import { getMcpManager } from "./mcp-connectors.js";
import { createSubagentTool, SUBAGENT_TOOL_NAMES } from "./subagent-tool.js";
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
  /** Resolve a pending ask_question with the user's answer. Returns false if no pending question. */
  resolveAnswer: (questionId: string, answer: string) => boolean;
  /** Whether a clarifying question is currently awaiting an answer. */
  hasPendingQuestion: () => boolean;
  dispose: () => void;
}

// Emit a synthetic error event to all listeners, used when prompt() throws
// synchronously (e.g. missing API key) before the agent loop starts — those
// errors would otherwise never reach the WS stream.
function emitError(sessionId: string, listeners: Set<(e: WireEvent) => void>, message: string) {
  const evt: WireEvent = { type: "error", sessionId, message };
  for (const l of listeners) l(evt);
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
  const sessionId = opts.sessionId;
  const listeners = new Set<(e: WireEvent) => void>();

  // Pending ask_question resolvers, keyed by questionId (= toolCallId).
  const pendingQuestions = new Map<string, { resolve: (a: string) => void; reject: (e: Error) => void }>();

  const emitWire = (e: WireEvent) => {
    for (const l of listeners) l(e);
  };

  // Cowork custom tools, wired to this session's event stream + answer resolver.
  const coworkTools = createCoworkTools({
    emit: (evt) => {
      if (evt.kind === "ask_question") {
        emitWire({ type: "ask_question", sessionId, questionId: evt.questionId, question: evt.question, options: evt.options });
      } else if (evt.kind === "todo_update") {
        emitWire({ type: "todo_update", sessionId, todos: evt.todos });
      }
    },
    registerQuestion: (questionId: string) =>
      new Promise<string>((resolve, reject) => {
        pendingQuestions.set(questionId, { resolve, reject });
      }),
  });

  // Document-creation tools + present_files, wired to the workspace + event stream.
  const docTools = createDocTools({
    cwd,
    emitFiles: (files) => emitWire({ type: "present_files", sessionId, files }),
  });

  // File-based memory tools, wired to the workspace memory/ dir.
  const memoryTools = createMemoryTools({ cwd });

  // Chrome control tools (Playwright), wired to the workspace for screenshots.
  const chromeTools = createChromeTools({
    cwd,
    emitFiles: (files) => emitWire({ type: "present_files", sessionId, files }),
  });

  // Artifact tools (live HTML), wired to the artifact store + event stream.
  const artifactTools = createArtifactTools({
    emitArtifact: (artifactId, title) =>
      emitWire({ type: "artifact", sessionId, artifactId, title }),
  });

  // MCP connector tools (from connected MCP servers), registered dynamically.
  const mcpTools = getMcpManager().getConnectedTools();
  const mcpToolNames = mcpTools.map((t) => t.name);

  // Sub-agent dispatch tool (concurrent in-memory sub-sessions).
  const subagentTool = createSubagentTool();

  const { session } = await createAgentSession({
    cwd,
    model: opts.model,
    authStorage: getAuthStorage(),
    modelRegistry: getModelRegistry(),
    tools: opts.tools ?? [
      "read", "bash", "edit", "write", "grep",
      "ask_question", "todo_write",
      ...DOC_TOOL_NAMES,
      ...MEMORY_TOOL_NAMES,
      ...CHROME_TOOL_NAMES,
      ...ARTIFACT_TOOL_NAMES,
      ...mcpToolNames,
      ...SUBAGENT_TOOL_NAMES,
    ],
    customTools: [
      ...coworkTools,
      ...docTools,
      ...memoryTools,
      ...chromeTools,
      ...artifactTools,
      ...mcpTools,
      subagentTool,
    ],
    sessionManager: opts.inMemory
      ? SessionManager.inMemory(cwd)
      : SessionManager.create(cwd),
  });

  const unsubscribe = session.subscribe((event: any) => {
    const wire = piEventToWireEvent(sessionId, event);
    if (wire) emitWire(wire);
  });

  return {
    sessionId,
    session,
    onEvent: (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    // Wrap prompt so synchronous failures (e.g. "No API key found") are surfaced
    // to subscribers as error events instead of vanishing into a console log.
    prompt: async (text: string) => {
      try {
        await session.prompt(text);
      } catch (err: any) {
        emitError(sessionId, listeners, err?.message ?? String(err));
      }
    },
    abort: () => session.abort(),
    resolveAnswer: (questionId: string, answer: string): boolean => {
      const pending = pendingQuestions.get(questionId);
      if (!pending) return false;
      pendingQuestions.delete(questionId);
      pending.resolve(answer);
      // Notify all clients the question has been answered (so they clear the card).
      emitWire({ type: "question_answered", sessionId, questionId });
      return true;
    },
    hasPendingQuestion: () => pendingQuestions.size > 0,
    dispose: () => {
      // Reject any still-pending questions so the tool promise doesn't leak.
      for (const [, p] of pendingQuestions) p.reject(new Error("session disposed"));
      pendingQuestions.clear();
      unsubscribe();
      listeners.clear();
      session.dispose();
    },
  };
}
