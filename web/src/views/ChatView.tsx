import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { SessionSocket } from "../lib/ws";
import type { WireEvent, TodoItem, PresentedFile } from "../lib/events";
import { MessageList } from "../components/MessageList";
import { Composer } from "../components/Composer";
import { TaskList } from "../components/TaskList";
import { QuestionCard, type Question } from "../components/QuestionCard";
import { FileChips } from "../components/FileChips";
import type { Turn, ToolRecord } from "../components/types";

export function ChatView({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [question, setQuestion] = useState<Question | null>(null);
  const [files, setFiles] = useState<PresentedFile[]>([]);
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
                ? { ...tr, result: e.result, isError: e.isError, status: "done" }
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

    // Non-turn state: task list and clarifying questions live outside the
    // message bubbles (persistent UI), handled here.
    switch (e.type) {
      case "todo_update":
        setTodos(e.todos);
        break;
      case "present_files":
        setFiles((prev) => [...prev, ...e.files]);
        break;
      case "ask_question":
        setQuestion({
          questionId: e.questionId,
          question: e.question,
          options: e.options,
        });
        break;
      case "question_answered":
        setQuestion((q) => (q && q.questionId === e.questionId ? null : q));
        break;
    }
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

  const onAnswer = (questionId: string, answer: string) => {
    api.answerQuestion(sessionId, questionId, answer);
    // Optimistically clear; the server will also send question_answered.
    setQuestion(null);
  };

  return (
    <div className="chatview">
      {(todos.length > 0 || question || files.length > 0) && (
        <div className="sidebarwidgets">
          {todos.length > 0 && <TaskList todos={todos} />}
          {question && <QuestionCard question={question} onAnswer={onAnswer} />}
          {files.length > 0 && <FileChips files={files} />}
        </div>
      )}
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
