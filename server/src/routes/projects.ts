import type { FastifyInstance } from "fastify";
import { getProjectManager } from "../pi/projects.js";

export async function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects", async () => ({ projects: getProjectManager().list() }));

  app.get("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProjectManager().get(id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return p;
  });

  app.post("/api/projects", async (req) => {
    const { name, instructions } = req.body as { name?: string; instructions?: string };
    return getProjectManager().create(name ?? "Untitled project", instructions);
  });

  app.patch("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name, instructions } = req.body as { name?: string; instructions?: string };
    const pm = getProjectManager();
    if (name) await pm.rename(id, name);
    if (instructions != null) await pm.writeInstructions(id, instructions);
    const p = pm.get(id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return p;
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const ok = await getProjectManager().remove(id);
      return { ok };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message });
    }
  });
}
