export interface ToolRecord {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done";
}

export interface Turn {
  id: string;
  userText: string;
  assistantText: string;
  thinking: string;
  tools: ToolRecord[];
  done: boolean;
  error?: string;
}
