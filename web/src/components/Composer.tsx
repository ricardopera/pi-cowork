import { useState, type KeyboardEvent } from "react";

export function Composer({
  onSend,
  disabled,
  status,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  status?: string;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className="composer">
      {status && <div className="status-pill">{status}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="Ask Pi-Cowork to do something…"
        rows={2}
      />
      <button onClick={send} disabled={disabled}>
        Send
      </button>
    </div>
  );
}
