import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const WORKSPACE_ROOT = path.join(config.dataDir, "workspaces", "default");

export async function fileRoutes(app: FastifyInstance) {
  // Download a file from the default workspace. Path is validated to stay
  // within the workspace root (no traversal).
  app.get("/api/files/*", async (req, reply) => {
    const reqPath = decodeURIComponent(req.url.replace("/api/files/", ""));
    const resolved = path.resolve(WORKSPACE_ROOT, reqPath);
    // Prevent path traversal outside the workspace.
    if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
      return reply.code(400).send({ error: "invalid path" });
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return reply.code(404).send({ error: "not a file" });
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    const stream = fs.createReadStream(resolved);
    const name = path.basename(resolved);
    reply.header(
      "Content-Disposition",
      `attachment; filename="${name.replace(/"/g, "_")}"`,
    );
    return reply.send(stream);
  });
}
