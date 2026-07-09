import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { ChatView } from "./views/ChatView";
import { SettingsView } from "./views/SettingsView";

export function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    api
      .createSession()
      .then((s) => setSessionId(s.id))
      .catch((e) => setBootError(String(e?.message ?? e)));
  }, []);

  return (
    <>
      <aside className="sidebar">
        <div className="brand">Pi-Cowork</div>
        <nav>
          <button
            className={view === "chat" ? "active" : ""}
            onClick={() => setView("chat")}
          >
            Chat
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
        </nav>
        {bootError && (
          <div className="booterr">
            Could not start a session. Is the server running?
            <pre>{bootError}</pre>
          </div>
        )}
      </aside>
      <main className="content">
        {view === "chat" ? (
          sessionId ? (
            <ChatView sessionId={sessionId} />
          ) : (
            <div className="loading">Starting session…</div>
          )
        ) : (
          <SettingsView />
        )}
      </main>
    </>
  );
}
