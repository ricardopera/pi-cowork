import type { FastifyInstance } from "fastify";
import { listCommands, executeCommand } from "../pi/commands.js";
import { getHandle } from "../pi/sessions.js";

export async function commandRoutes(app: FastifyInstance) {
  app.get("/api/commands", async () => ({ commands: listCommands() }));

  // Execute a command in a session. Returns a reply (to display) and/or an
  // injected prompt (which the client then sends as a normal message), and/or
  // a clear flag.
  app.post("/api/sessions/:id/commands", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { input } = req.body as { input: string };
    if (!getHandle(id)) return reply.code(404).send({ error: "session not found" });
    if (!input) return reply.code(400).send({ error: "input required" });
    const result = await executeCommand(id, input);
    // If the command resolves to an injected prompt, send it to the session.
    if (result.inject) {
      getHandle(id)!.prompt(result.inject).catch((err) => {
        console.error("command inject error", err);
      });
    }
    return result;
  });
}
