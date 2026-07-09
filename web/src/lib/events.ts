export type WireEvent =
  | { type: "text_delta"; sessionId: string; delta: string }
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "message_start"; sessionId: string; role: "assistant" }
  | { type: "message_end"; sessionId: string }
  | { type: "tool_start"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; sessionId: string; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; sessionId: string; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "turn_end"; sessionId: string }
  | { type: "agent_start"; sessionId: string }
  | { type: "agent_end"; sessionId: string }
  | { type: "status"; sessionId: string; status: "compacting" | "retrying" | "idle" | "error"; message?: string }
  | { type: "ask_question"; sessionId: string; questionId: string; question: string; options?: string[] }
  | { type: "question_answered"; sessionId: string; questionId: string }
  | { type: "todo_update"; sessionId: string; todos: TodoItem[] }
  | { type: "present_files"; sessionId: string; files: PresentedFile[] }
  | { type: "artifact"; sessionId: string; artifactId: string; title: string }
  | { type: "error"; sessionId: string; message: string };

export interface PresentedFile {
  name: string;
  path: string;
  format: "docx" | "xlsx" | "pptx" | "pdf" | "md" | "html" | "txt" | "other";
  sizeBytes: number;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

export interface ProviderInfo {
  id: string;
  name: string;
  envVar: string;
  hasKey: boolean;
}
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
}
export interface SessionInfo {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
}
