import { test, expect } from "@playwright/test";

const FOUR = ["openrouter", "zai", "minimax", "opencode"];

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test("providers endpoint returns the four target providers", async ({ request }) => {
  const res = await request.get("/api/providers");
  const body = await res.json();
  const ids = body.providers.map((p: any) => p.id);
  for (const id of FOUR) expect(ids).toContain(id);
});

test("each provider exposes a non-empty model catalog", async ({ request }) => {
  for (const id of FOUR) {
    const res = await request.get(`/api/providers/${id}/models`);
    const body = await res.json();
    expect(body.models.length, `${id} models`).toBeGreaterThan(0);
  }
});

test("setting and clearing a key is reflected in provider status", async ({ request }) => {
  await request.put("/api/providers/zai/key", { data: { key: "sk-test" } });
  let body = await (await request.get("/api/providers")).json();
  expect(body.providers.find((p: any) => p.id === "zai").hasKey).toBe(true);

  await request.delete("/api/providers/zai/key");
  body = await (await request.get("/api/providers")).json();
  expect(body.providers.find((p: any) => p.id === "zai").hasKey).toBe(false);
});

test("creating a session returns an id", async ({ request }) => {
  const res = await request.post("/api/sessions", { data: {} });
  const body = await res.json();
  expect(body.id).toBeTruthy();
  expect(typeof body.id).toBe("string");
});
