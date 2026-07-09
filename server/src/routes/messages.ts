import type { FastifyInstance } from "fastify";
import { getHandle } from "../pi/sessions.js";

export async function messageRoutes(app: FastifyInstance) {
  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    const handle = getHandle(id);
    if (!handle) return reply.code(404).send({ error: "session not found" });
    if (!text) return reply.code(400).send({ error: "text required" });
    // Fire and forget: events flow over WS. Errors surface via the WS stream.
    handle.prompt(text).catch((err) => {
      console.error("prompt error", err);
    });
    return { ok: true };
  });
}
