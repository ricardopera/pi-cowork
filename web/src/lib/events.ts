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
  | { type: "error"; sessionId: string; message: string };

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
