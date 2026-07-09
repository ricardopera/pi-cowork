import path from "node:path";
import os from "node:os";

export const config = {
  port: Number(process.env.PORT ?? 5174),
  // Pi agent data dir (keys, models, sessions). Defaults to ~/.pi/agent
  agentDir: process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  // Where Pi-Cowork stores its own data (default workspace roots, artifacts)
  dataDir: process.env.PI_COWORK_DATA_DIR ?? path.join(os.homedir(), ".pi-cowork"),
  // Dev: serve web dev server if set; else serve built web/
  webUrl: process.env.WEB_URL ?? null,
  isProd: process.env.NODE_ENV === "production",
};
