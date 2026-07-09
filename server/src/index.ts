import Fastify from "fastify";
import { config } from "./config.js";
import { initAuthStorage, seedFromEnv } from "./pi/providers.js";
import { providerRoutes } from "./routes/providers.js";
import { sessionRoutes } from "./routes/sessions.js";
import { messageRoutes } from "./routes/messages.js";
import { fileRoutes } from "./routes/files.js";
import { skillRoutes } from "./routes/skills.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { schedulerRoutes } from "./routes/scheduler.js";
import { attachWebSocket } from "./ws.js";
import { SkillsManager } from "./pi/skills.js";
import { getScheduler } from "./pi/scheduler.js";
import { createPiSession } from "./pi/engine.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  // Ensure data dirs exist.
  fs.mkdirSync(path.join(config.dataDir, "workspaces", "default"), {
    recursive: true,
  });
  fs.mkdirSync(config.agentDir, { recursive: true });

  initAuthStorage();
  seedFromEnv();

  const app = Fastify({ logger: true });

  app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));

  await app.register(providerRoutes);
  await app.register(sessionRoutes);
  await app.register(messageRoutes);
  await app.register(fileRoutes);
  await app.register(skillRoutes);
  await app.register(artifactRoutes);
  await app.register(schedulerRoutes);

  // Seed starter skills into the global library on first run.
  await new SkillsManager(path.join(config.dataDir, "workspaces", "default")).seedBuiltin();

  // Initialize the scheduler: load persisted tasks and set the runner to spin
  // up an in-memory Pi session for each scheduled prompt.
  const scheduler = getScheduler();
  await scheduler.load();
  scheduler.setRunner(async (prompt) => {
    const cwd = path.join(config.dataDir, "workspaces", "default");
    const handle = await createPiSession({
      sessionId: `scheduled-${Date.now()}`,
      cwd,
      inMemory: true,
    });
    try {
      await handle.prompt(prompt);
      return "completed";
    } finally {
      handle.dispose();
    }
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  attachWebSocket(app.server);
  app.log.info(`Pi-Cowork server on http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
