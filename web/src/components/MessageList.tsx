import { useEffect, useRef } from "react";
import type { Turn } from "./types";
import { ToolCard } from "./ToolCard";
import { Markdown } from "./Markdown";

export function MessageList({ turns, onExample }: { turns: Turn[]; onExample?: (text: string) => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <div className="messages">
      {turns.length === 0 && (
        <div className="empty">
          <div className="empty-icon">✦</div>
          <h2>How can I help?</h2>
          <div className="examples">
            <button className="example" onClick={() => onExample?.("Write a one-page report on renewable energy trends")}>
              📄 Write a one-page report on renewable energy trends
            </button>
            <button className="example" onClick={() => onExample?.("Create a spreadsheet comparing three project management tools")}>
              📊 Create a spreadsheet comparing three project management tools
            </button>
            <button className="example" onClick={() => onExample?.("Research the latest developments in quantum computing and summarize")}>
              🔍 Research the latest developments in quantum computing
            </button>
            <button className="example" onClick={() => onExample?.("Draft a professional email announcing a product launch")}>
              📑 Draft a professional email announcing a product launch
            </button>
          </div>
        </div>
      )}
      {turns.map((t) => (
        <div key={t.id} className="turn">
          <div className="msg-role user-role">You</div>
          <div className="bubble user">{t.userText}</div>
          {t.thinking && <div className="thinking">{t.thinking}</div>}
          {t.tools.map((tr) => (
            <ToolCard key={tr.toolCallId} tool={tr} />
          ))}
          {t.assistantText && (
            <>
              <div className="msg-role assistant-role">Pi-Cowork</div>
              <div className="bubble assistant">
                <Markdown content={t.assistantText} />
              </div>
            </>
          )}
          {t.error && <div className="error">⚠ {t.error}</div>}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
