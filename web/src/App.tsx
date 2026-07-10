import { useEffect, useState } from "react";
import { api } from "./lib/api";
import type { SessionInfo, ProviderInfo, ModelInfo } from "./lib/events";
import { ChatView } from "./views/ChatView";
import { SettingsView } from "./views/SettingsView";

export function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selProvider, setSelProvider] = useState("zenfree");
  const [selModel, setSelModel] = useState("deepseek-v4-flash-free");
  const [bootError, setBootError] = useState<string | null>(null);

  // Load providers + models on startup
  useEffect(() => {
    api.listProviders().then((r) => setProviders(r.providers)).catch(() => {});
    api.listModels("zenfree").then((r) => setModels(r.models)).catch(() => {});
    refreshSessions();
  }, []);

  const refreshSessions = () => {
    api.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
  };

  const newSession = () => {
    api.createSession().then((s) => {
      setActiveSession(s.id);
      refreshSessions();
    }).catch((e) => setBootError(String(e?.message ?? e)));
  };

  // Create initial session
  useEffect(() => {
    if (!activeSession && view === "chat") newSession();
  }, [view]);

  const onProviderChange = (pid: string) => {
    setSelProvider(pid);
    setSelModel("");
    api.listModels(pid).then((r) => setModels(r.models)).catch(() => {});
  };

  return (
    <div className="app-shell">
      {/* Session sidebar */}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">✦</span> Pi-Cowork
        </div>
        <button className="new-session-btn" onClick={newSession}>
          + New Chat
        </button>
        <div className="session-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`session-item ${activeSession === s.id ? "active" : ""}`}
              onClick={() => setActiveSession(s.id)}
            >
              <span className="session-dot" />
              <span className="session-label">Chat {s.id.slice(0, 8)}</span>
            </button>
          ))}
        </div>
        <nav className="sidebar-nav">
          <button
            className={view === "chat" ? "active" : ""}
            onClick={() => setView("chat")}
          >
            💬 Chat
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            ⚙️ Settings
          </button>
        </nav>
      </aside>

      {/* Main content */}
      <main className="content">
        {view === "chat" ? (
          <div className="chat-container">
            {/* Chat header with model selector */}
            <div className="chat-header">
              <div className="model-selector">
                <select
                  value={selProvider}
                  onChange={(e) => onProviderChange(e.target.value)}
                  className="provider-select"
                >
                  <option value="zenfree">Zen Free (no key)</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.hasKey}>
                      {p.name}{p.hasKey ? "" : " (needs key)"}
                    </option>
                  ))}
                </select>
                <select
                  value={selModel}
                  onChange={(e) => setSelModel(e.target.value)}
                  className="model-select"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}{m.reasoning ? " ✦" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {activeSession ? (
              <ChatView sessionId={activeSession} />
            ) : (
              <div className="loading">Starting session…</div>
            )}
          </div>
        ) : (
          <SettingsView />
        )}
      </main>
      {bootError && (
        <div className="booterr">
          Could not connect to server. Is it running?
          <pre>{bootError}</pre>
        </div>
      )}
    </div>
  );
}
