import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { SessionSocket } from "../lib/ws";
import type { WireEvent } from "../lib/events";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import type { Turn, ToolRecord } from "../components/types";

export function ChatView({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [socket, setSocket] = useState<SessionSocket | null>(null);

  const handleEvent = useCallback((e: WireEvent) => {
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      const updateLast = (mut: (t: Turn) => Turn) => {
        if (last) next[next.length - 1] = mut(last);
      };
      switch (e.type) {
        case "text_delta":
          updateLast((t) => ({ ...t, assistantText: t.assistantText + e.delta }));
          break;
        case "thinking_delta":
          updateLast((t) => ({ ...t, thinking: t.thinking + e.delta }));
          break;
        case "tool_start":
          updateLast((t) => ({
            ...t,
            tools: [
              ...t.tools,
              {
                toolCallId: e.toolCallId,
                toolName: e.toolName,
                args: e.args,
                status: "running",
              } as ToolRecord,
            ],
          }));
          break;
        case "tool_end":
          updateLast((t) => ({
            ...t,
            tools: t.tools.map((tr) =>
              tr.toolCallId === e.toolCallId
                ? {
                    ...tr,
                    result: e.result,
                    isError: e.isError,
                    status: "done",
                  }
                : tr,
            ),
          }));
          break;
        case "agent_start":
          setBusy(true);
          break;
        case "agent_end":
          updateLast((t) => ({ ...t, done: true }));
          setBusy(false);
          setStatus("");
          break;
        case "turn_end":
          updateLast((t) => ({ ...t, done: true }));
          break;
        case "status":
          setStatus(e.status === "idle" ? "" : e.status);
          break;
        case "error":
          updateLast((t) => ({ ...t, error: e.message }));
          setBusy(false);
          break;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const s = new SessionSocket(sessionId);
    setSocket(s);
    s.connect();
    const off = s.onEvent(handleEvent);
    return () => {
      off();
      s.close();
    };
  }, [sessionId, handleEvent]);

  const send = (text: string) => {
    setTurns((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        userText: text,
        assistantText: "",
        thinking: "",
        tools: [],
        done: false,
      },
    ]);
    api.sendMessage(sessionId, text);
  };

  return (
    <div className="chatview">
      <MessageList turns={turns} />
      <Composer onSend={send} disabled={busy} status={status} />
      {busy && socket && (
        <button className="abort" onClick={() => socket.abort()}>
          Stop
        </button>
      )}
    </div>
  );
}
