import type { ProviderInfo, ModelInfo, SessionInfo } from "./events";

const base = "";
async function j<T>(res: Promise<Response> | Response): Promise<T> {
  const r = await res;
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T;
}

export const api = {
  health: () => j<{ ok: boolean }>(fetch(`${base}/api/health`)),
  listProviders: () =>
    j<{ providers: ProviderInfo[] }>(fetch(`${base}/api/providers`)),
  setKey: (id: string, key: string) =>
    fetch(`${base}/api/providers/${id}/key`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  clearKey: (id: string) =>
    fetch(`${base}/api/providers/${id}/key`, { method: "DELETE" }),
  listModels: (id: string) =>
    j<{ models: ModelInfo[] }>(fetch(`${base}/api/providers/${id}/models`)),
  createSession: (providerId?: string, modelId?: string) =>
    j<SessionInfo>(
      fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, modelId }),
      }),
    ),
  listSessions: () =>
    j<{ sessions: SessionInfo[] }>(fetch(`${base}/api/sessions`)),
  sendMessage: (id: string, text: string) =>
    fetch(`${base}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  answerQuestion: (id: string, questionId: string, answer: string) =>
    fetch(`${base}/api/sessions/${id}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, answer }),
    }),
  resolvePermission: (id: string, permissionId: string, approved: boolean) =>
    fetch(`${base}/api/sessions/${id}/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionId, approved }),
    }),
};
