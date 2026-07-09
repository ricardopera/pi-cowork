import type { FastifyInstance } from "fastify";
import { createSession, listSessions } from "../pi/sessions.js";

export async function sessionRoutes(app: FastifyInstance) {
  app.post("/api/sessions", async (req) => {
    const { providerId, modelId } = (req.body ?? {}) as {
      providerId?: string;
      modelId?: string;
    };
    const { info } = await createSession({ providerId, modelId });
    return info;
  });

  app.get("/api/sessions", async () => ({ sessions: await listSessions() }));
}
