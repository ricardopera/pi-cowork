import type { FastifyInstance } from "fastify";
import { getHandle } from "../pi/sessions.js";
import type { AskAnswerPayload } from "../event-schema.js";

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

  // Submit an answer to a pending ask_question. Resumes the paused agent.
  app.post("/api/sessions/:id/answers", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { questionId, answer } = req.body as AskAnswerPayload;
    const handle = getHandle(id);
    if (!handle) return reply.code(404).send({ error: "session not found" });
    if (!questionId || !answer) return reply.code(400).send({ error: "questionId and answer required" });
    const resolved = handle.resolveAnswer(questionId, answer);
    if (!resolved) return reply.code(409).send({ error: "no pending question with that id" });
    return { ok: true };
  });
}
