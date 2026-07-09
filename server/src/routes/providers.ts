import type { FastifyInstance } from "fastify";
import { listProviders, setApiKey, clearApiKey, listModels } from "../pi/providers.js";

export async function providerRoutes(app: FastifyInstance) {
  app.get("/api/providers", async () => ({ providers: await listProviders() }));

  app.put("/api/providers/:id/key", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { key } = req.body as { key: string };
    if (!key) return reply.code(400).send({ error: "key required" });
    await setApiKey(id, key);
    return { ok: true };
  });

  app.delete("/api/providers/:id/key", async (req) => {
    const { id } = req.params as { id: string };
    clearApiKey(id);
    return { ok: true };
  });

  app.get("/api/providers/:id/models", async (req) => {
    const { id } = req.params as { id: string };
    return { models: listModels(id) };
  });
}
