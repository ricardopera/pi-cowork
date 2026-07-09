import { useEffect, useRef } from "react";
import type { Turn } from "./types";
import { ToolCard } from "./ToolCard";

export function MessageList({ turns }: { turns: Turn[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <div className="messages">
      {turns.length === 0 && (
        <div className="empty">
          <h2>Pi-Cowork</h2>
          <p>
            Ask me to do something — research a topic, write a document, analyze data, or
            automate a task. Powered by Pi Agent with your choice of provider.
          </p>
        </div>
      )}
      {turns.map((t) => (
        <div key={t.id} className="turn">
          <div className="bubble user">{t.userText}</div>
          {t.thinking && <div className="thinking">{t.thinking}</div>}
          {t.tools.map((tr) => (
            <ToolCard key={tr.toolCallId} tool={tr} />
          ))}
          {t.assistantText && <div className="bubble assistant">{t.assistantText}</div>}
          {t.error && <div className="error">⚠ {t.error}</div>}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
