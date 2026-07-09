import type { FastifyInstance } from "fastify";
import { getScheduler } from "../pi/scheduler.js";

export async function schedulerRoutes(app: FastifyInstance) {
  app.get("/api/tasks", async () => ({ tasks: getScheduler().list() }));

  app.post("/api/tasks", async (req, reply) => {
    const { name, prompt, cronExpression, fireAt } = req.body as {
      name?: string;
      prompt?: string;
      cronExpression?: string;
      fireAt?: string;
    };
    try {
      const task = await getScheduler().create({
        name: name ?? "",
        prompt: prompt ?? "",
        cronExpression,
        fireAt,
      });
      return task;
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? "invalid task" });
    }
  });

  app.patch("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status?: "active" | "paused" };
    const task = await getScheduler().update(id, { status });
    if (!task) return reply.code(404).send({ error: "not found" });
    return task;
  });

  app.delete("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    const ok = await getScheduler().remove(id);
    return { ok };
  });
}
