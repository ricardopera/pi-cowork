import type { FastifyInstance } from "fastify";
import { getMcpManager } from "../pi/mcp-connectors.js";

export async function connectorRoutes(app: FastifyInstance) {
  app.get("/api/connectors", async () => ({ connectors: getMcpManager().list() }));

  app.post("/api/connectors", async (req, reply) => {
    const body = req.body as {
      name: string;
      transport: "stdio" | "http" | "sse";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    };
    if (!body.name || !body.transport) {
      return reply.code(400).send({ error: "name and transport required" });
    }
    const config = await getMcpManager().add({
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: body.args,
      env: body.env,
      url: body.url,
      headers: body.headers,
    });
    return config;
  });

  app.post("/api/connectors/:id/connect", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const config = await getMcpManager().connect(id);
      return config;
    } catch (e: any) {
      return reply.code(404).send({ error: e?.message });
    }
  });

  app.post("/api/connectors/:id/disconnect", async (req) => {
    const { id } = req.params as { id: string };
    await getMcpManager().disconnect(id);
    return { ok: true };
  });

  app.delete("/api/connectors/:id", async (req) => {
    const { id } = req.params as { id: string };
    const ok = await getMcpManager().remove(id);
    return { ok };
  });
}
