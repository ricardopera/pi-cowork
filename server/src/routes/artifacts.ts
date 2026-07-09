import type { FastifyInstance } from "fastify";
import { getArtifactStore } from "../pi/artifacts.js";

export async function artifactRoutes(app: FastifyInstance) {
  app.get("/api/artifacts", async () => ({ artifacts: await getArtifactStore().list() }));

  // Serve artifact HTML. Rendered by the browser in a sandboxed iframe.
  app.get("/api/artifacts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const html = await getArtifactStore().get(id);
    if (html == null) return reply.code(404).send({ error: "artifact not found" });
    reply.type("text/html");
    return reply.send(html);
  });
}
