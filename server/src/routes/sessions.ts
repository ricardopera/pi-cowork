import type { FastifyInstance } from "fastify";
import { createSession, listSessions } from "../pi/sessions.js";

export async function sessionRoutes(app: FastifyInstance) {
  app.post("/api/sessions", async (req) => {
    const { providerId, modelId, projectId } = (req.body ?? {}) as {
      providerId?: string;
      modelId?: string;
      projectId?: string;
    };
    const { info } = await createSession({ providerId, modelId, projectId });
    return info;
  });

  app.get("/api/sessions", async () => ({ sessions: await listSessions() }));
}
