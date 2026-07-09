import type { FastifyInstance } from "fastify";
import path from "node:path";
import { SkillsManager } from "../pi/skills.js";
import { config } from "../config.js";

// Skills operate on the default workspace (where chat sessions run).
function manager(): SkillsManager {
  return new SkillsManager(path.join(config.dataDir, "workspaces", "default"));
}

export async function skillRoutes(app: FastifyInstance) {
  app.get("/api/skills", async () => ({ skills: await manager().list() }));

  app.post("/api/skills/:file/enable", async (req, reply) => {
    const { file } = req.params as { file: string };
    try {
      await manager().enable(file);
      return { ok: true };
    } catch (e: any) {
      return reply.code(404).send({ error: e?.message ?? "not found" });
    }
  });

  app.post("/api/skills/:file/disable", async (req) => {
    const { file } = req.params as { file: string };
    await manager().disable(file);
    return { ok: true };
  });

  app.put("/api/skills/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const { content } = req.body as { content: string };
    if (!content) return reply.code(400).send({ error: "content required" });
    await manager().install(file, content);
    return { ok: true };
  });

  app.delete("/api/skills/:file", async (req) => {
    const { file } = req.params as { file: string };
    await manager().uninstall(file);
    return { ok: true };
  });
}
