import Fastify from "fastify";
import { config } from "./config.js";
import { initAuthStorage, seedFromEnv } from "./pi/providers.js";
import { providerRoutes } from "./routes/providers.js";
import { sessionRoutes } from "./routes/sessions.js";
import { messageRoutes } from "./routes/messages.js";
import { fileRoutes } from "./routes/files.js";
import { attachWebSocket } from "./ws.js";
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

  await app.listen({ port: config.port, host: "0.0.0.0" });
  attachWebSocket(app.server);
  app.log.info(`Pi-Cowork server on http://localhost:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
