import type { FastifyInstance } from "fastify";
import { getHandle } from "../pi/sessions.js";
import { executeCommand } from "../pi/commands.js";
import type { AskAnswerPayload } from "../event-schema.js";

export async function messageRoutes(app: FastifyInstance) {
  app.post("/api/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    const handle = getHandle(id);
    if (!handle) return reply.code(404).send({ error: "session not found" });
    if (!text) return reply.code(400).send({ error: "text required" });

    // Slash commands: route through the command system. If the command injects
    // a prompt, send that; otherwise just return the reply (no agent turn).
    if (text.trim().startsWith("/")) {
      const result = await executeCommand(id, text);
      if (result.inject) {
        handle.prompt(result.inject).catch((err) => console.error("command inject error", err));
      }
      return { ok: true, command: true, reply: result.reply, clear: result.clear };
    }

    // Normal message: fire and forget; events flow over WS.
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

  // Resolve a pending permission request (approve or deny).
  app.post("/api/sessions/:id/permissions", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { permissionId, approved } = req.body as { permissionId: string; approved: boolean };
    const handle = getHandle(id);
    if (!handle) return reply.code(404).send({ error: "session not found" });
    if (!permissionId) return reply.code(400).send({ error: "permissionId required" });
    const resolved = handle.resolvePermission(permissionId, approved);
    if (!resolved) return reply.code(409).send({ error: "no pending permission with that id" });
    return { ok: true };
  });
}
