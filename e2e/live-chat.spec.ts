import { test, expect } from "@playwright/test";
import { WebSocket } from "ws";

/**
 * LIVE end-to-end chat test: asserts real assistant text_delta tokens stream
 * from an LLM through the server's WebSocket. Uses the keyless OpenCode Zen free
 * provider (no API key required), so this runs without credentials.
 *
 * Skipped when PLAYWRIGHT_SKIP_LIVE is set (offline CI) — the pipeline plumbing
 * is otherwise covered by the unit + e2e suites.
 */
const SKIP = !!process.env.PLAYWRIGHT_SKIP_LIVE;

test.skip(SKIP, "PLAYWRIGHT_SKIP_LIVE set");

test("real model text_delta tokens stream over the websocket", async ({ request }) => {
  // 1. create a session (engine defaults to the keyless Zen free model)
  const session = await (
    await request.post("/api/sessions", { data: {} })
  ).json();
  expect(session.id).toBeTruthy();

  // 2. open the WS and subscribe
  const ws = new WebSocket("ws://localhost:5174/ws");
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("ws open timeout")), 8000);
  });
  ws.on("message", (d) => {
    try {
      events.push(JSON.parse(d.toString()));
    } catch {
      /* ignore */
    }
  });
  ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }));
  await new Promise((r) => setTimeout(r, 400));

  // 3. send a prompt that requires a genuine generation
  await request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: "Reply with exactly these three words: cowork is live" },
  });

  // 4. wait for the turn to finish (or error), with a generous timeout
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (events.some((e) => e.type === "agent_end" || e.type === "error")) break;
  }
  ws.close();

  // 5. assert real streamed tokens
  const textDeltas = events.filter((e) => e.type === "text_delta");
  const assembled = textDeltas.map((e) => e.delta).join("");
  const error = events.find((e) => e.type === "error");

  expect(error, `no error expected, got: ${error?.message}`).toBeUndefined();
  expect(textDeltas.length, "at least one text_delta event").toBeGreaterThan(0);
  expect(assembled.trim().length, "non-empty streamed text").toBeGreaterThan(0);
  // The model should produce the requested words (case-insensitive).
  expect(assembled.toLowerCase()).toContain("cowork");
}, 45000);
