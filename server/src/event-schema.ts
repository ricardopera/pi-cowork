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
  // errors
  | { type: "error"; sessionId: string; message: string };

// Browser->server WS commands.
export type WireCommand =
  | { type: "subscribe"; sessionId: string }
  | { type: "abort"; sessionId: string };

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
