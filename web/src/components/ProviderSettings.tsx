import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProviderInfo, ModelInfo } from "../lib/events";

export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [openModels, setOpenModels] = useState<Record<string, boolean>>({});

  const refresh = () =>
    api.listProviders().then((r) => setProviders(r.providers));
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    providers.forEach((p) =>
      api
        .listModels(p.id)
        .then((r) => setModels((m) => ({ ...m, [p.id]: r.models }))),
    );
  }, [providers]);

  return (
    <div className="settings">
      <h2>Providers</h2>
      <p className="hint">
        Add an API key for any provider to start chatting. Keys are stored in Pi Agent's
        AuthStorage (~/.pi/agent/auth.json) and never leave the server.
      </p>
      {providers.map((p) => (
        <div key={p.id} className="provider">
          <div className="prov-head">
            <b>{p.name}</b> <code>{p.envVar}</code>
            {p.hasKey && <span className="ok">● keyed</span>}
          </div>
          <div className="prov-row">
            <input
              type="password"
              placeholder={`${p.envVar} value`}
              value={keys[p.id] ?? ""}
              onChange={(e) =>
                setKeys((k) => ({ ...k, [p.id]: e.target.value }))
              }
            />
            <button
              onClick={async () => {
                await api.setKey(p.id, keys[p.id] ?? "");
                refresh();
              }}
            >
              Save
            </button>
            {p.hasKey && (
              <button
                className="ghost"
                onClick={async () => {
                  await api.clearKey(p.id);
                  refresh();
                }}
              >
                Clear
              </button>
            )}
          </div>
          <button
            className="ghost small"
            onClick={() =>
              setOpenModels((o) => ({ ...o, [p.id]: !o[p.id] }))
            }
          >
            {openModels[p.id] ? "Hide" : "Show"} models (
            {(models[p.id] ?? []).length})
          </button>
          {openModels[p.id] && (
            <div className="models">
              {(models[p.id] ?? []).map((m) => (
                <span key={m.id} className="model" title={m.id}>
                  {m.name}
                  {m.reasoning ? " ✦" : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
