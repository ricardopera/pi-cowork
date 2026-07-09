// Wire events sent server->browser over the session WebSocket.
export type WireEvent =
  // assistant streaming
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "message_start"; sessionId: string; role: "assistant" }
  | { type: "message_end"; sessionId: string }
  // tools
  | { type: "tool_start"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; sessionId: string; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; sessionId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  // turn lifecycle
  | { type: "turn_end"; sessionId: string }
  | { type: "agent_start"; sessionId: string }
  | { type: "agent_end"; sessionId: string }
  // status
  | { type: "status"; sessionId: string; status: "compacting" | "retrying" | "idle" | "error"; message?: string }
  // clarifying question (ask_question tool) — agent is paused awaiting an answer
  | { type: "ask_question"; sessionId: string; questionId: string; question: string; options?: string[] }
  // answer submitted (lets all clients clear the pending card)
  | { type: "question_answered"; sessionId: string; questionId: string }
  // task list (todo_write tool) — full replacement list
  | { type: "todo_update"; sessionId: string; todos: TodoItem[] }
  // deliverables surfaced to the user (present_files tool)
  | { type: "present_files"; sessionId: string; files: PresentedFile[] }
  // live HTML artifact created (create_artifact tool)
  | { type: "artifact"; sessionId: string; artifactId: string; title: string }
  // permission request: a tool needs explicit user approval (explicit-permission list)
  | { type: "permission_request"; sessionId: string; permissionId: string; toolName: string; reason: string }
  // permission resolved (approved or denied) — lets clients clear the prompt
  | { type: "permission_resolved"; sessionId: string; permissionId: string; approved: boolean }
  // errors
  | { type: "error"; sessionId: string; message: string };

export interface PresentedFile {
  name: string;
  path: string; // path relative to the session workspace
  format: "docx" | "xlsx" | "pptx" | "pdf" | "md" | "html" | "txt" | "other";
  sizeBytes: number;
}

// Browser->server WS commands.
export type WireCommand =
  | { type: "subscribe"; sessionId: string }
  | { type: "abort"; sessionId: string };

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

export interface AskAnswerPayload {
  questionId: string;
  answer: string;
}

export interface SessionInfo {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderInfo {
  id: string; // "openrouter" | "zai" | "minimax" | "opencode"
  name: string; // display name
  envVar: string; // env var name
  hasKey: boolean; // whether a key is configured
}

export interface ModelInfo {
  id: string; // model id within provider
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
}
