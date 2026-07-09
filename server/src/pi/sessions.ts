import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { createPiSession, type PiSessionHandle } from "./engine.js";
import { resolveModel } from "./providers.js";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionInfo } from "../event-schema.js";

// Active in-memory handles keyed by sessionId.
const handles = new Map<string, PiSessionHandle>();

function defaultCwd(): string {
  return path.join(config.dataDir, "workspaces", "default");
}

export async function createSession(opts: {
  providerId?: string;
  modelId?: string;
}): Promise<{ handle: PiSessionHandle; info: SessionInfo }> {
  const id = crypto.randomUUID();
  const cwd = defaultCwd();
  let model: Model<any> | undefined;
  if (opts.providerId && opts.modelId) {
    model = resolveModel(opts.providerId, opts.modelId);
  }
  const handle = await createPiSession({ sessionId: id, cwd, model });
  handles.set(id, handle);
  const now = Date.now();
  const info: SessionInfo = { id, createdAt: now, updatedAt: now };
  return { handle, info };
}

export function getHandle(sessionId: string): PiSessionHandle | undefined {
  return handles.get(sessionId);
}

export function removeHandle(sessionId: string): void {
  const h = handles.get(sessionId);
  if (h) {
    h.dispose();
    handles.delete(sessionId);
  }
}

export async function listSessions(): Promise<SessionInfo[]> {
  const now = Date.now();
  return Array.from(handles.values()).map((h) => ({
    id: h.sessionId,
    updatedAt: now,
    createdAt: now,
  }));
}
