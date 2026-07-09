import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getHandle } from "./pi/sessions.js";

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let unsubscribe: (() => void) | null = null;

    ws.on("message", (data) => {
      let cmd: any;
      try {
        cmd = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (cmd.type === "subscribe" && cmd.sessionId) {
        const handle = getHandle(cmd.sessionId);
        if (!handle) {
          ws.send(
            JSON.stringify({
              type: "error",
              sessionId: cmd.sessionId,
              message: "session not found",
            }),
          );
          return;
        }
        unsubscribe?.();
        unsubscribe = handle.onEvent((e) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
        });
        // ack
        ws.send(JSON.stringify({ type: "agent_start", sessionId: cmd.sessionId }));
      }
      if (cmd.type === "abort" && cmd.sessionId) {
        getHandle(cmd.sessionId)?.abort().catch(() => {});
      }
    });

    ws.on("close", () => {
      unsubscribe?.();
    });
  });
}
