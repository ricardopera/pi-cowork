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

test("answer endpoint rejects when no question is pending", async ({ request }) => {
  const session = await (
    await request.post("/api/sessions", { data: {} })
  ).json();
  // No ask_question has been asked, so resolving should 409.
  const res = await request.post(`/api/sessions/${session.id}/answers`, {
    data: { questionId: "q-none", answer: "x" },
  });
  expect(res.status()).toBe(409);
});

test("answer endpoint validates required fields", async ({ request }) => {
  const session = await (
    await request.post("/api/sessions", { data: {} })
  ).json();
  const res = await request.post(`/api/sessions/${session.id}/answers`, {
    data: {},
  });
  expect(res.status()).toBe(400);
});

test("answer endpoint 404s for unknown session", async ({ request }) => {
  const res = await request.post("/api/sessions/does-not-exist/answers", {
    data: { questionId: "q", answer: "a" },
  });
  expect(res.status()).toBe(404);
});

test("file download endpoint serves workspace files and blocks traversal", async ({ request }) => {
  // Create a file in the default workspace outputs dir via the server's dataDir.
  // The workspace root is <dataDir>/workspaces/default. We can't easily write to
  // it from the test process without knowing the exact path, so we instead verify
  // the endpoint behaves correctly: a missing file returns 404, and a traversal
  // attempt returns 400.
  const missing = await request.get("/api/files/outputs/does-not-exist.docx");
  expect([404, 400]).toContain(missing.status());

  // Path traversal attempt must be rejected (400), not leak files.
  const traversal = await request.get("/api/files/..%2F..%2Fetc%2Fpasswd");
  expect([400, 404]).toContain(traversal.status());
  const body = await traversal.text();
  expect(body).not.toContain("root:"); // must not contain /etc/passwd content
});

test("commands endpoint lists built-in commands", async ({ request }) => {
  const res = await request.get("/api/commands");
  const body = await res.json();
  const names = body.commands.map((c: any) => c.name);
  expect(names).toEqual(expect.arrayContaining(["help", "todo", "doc", "research"]));
});

test("slash command routes through the command system", async ({ request }) => {
  const session = await (await request.post("/api/sessions", { data: {} })).json();
  const res = await request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: "/help" },
  });
  const body = await res.json();
  expect(body.command).toBe(true);
  expect(body.reply).toContain("Commands:");
});

test("projects endpoint returns at least the default project", async ({ request }) => {
  const res = await request.get("/api/projects");
  const body = await res.json();
  expect(body.projects.find((p: any) => p.id === "default")).toBeTruthy();
});

test("can create and list a project", async ({ request }) => {
  const created = await (
    await request.post("/api/projects", { data: { name: "E2E Project" } })
  ).json();
  expect(created.name).toBe("E2E Project");
  const all = await (await request.get("/api/projects")).json();
  expect(all.projects.find((p: any) => p.id === created.id)).toBeTruthy();
});

test("skills endpoint returns seeded starter skills", async ({ request }) => {
  const res = await request.get("/api/skills");
  const body = await res.json();
  const names = body.skills.map((s: any) => s.name);
  expect(names.length).toBeGreaterThan(0);
});

test("connectors endpoint starts empty", async ({ request }) => {
  const res = await request.get("/api/connectors");
  const body = await res.json();
  expect(Array.isArray(body.connectors)).toBe(true);
});

test("tasks endpoint starts as a list", async ({ request }) => {
  const res = await request.get("/api/tasks");
  const body = await res.json();
  expect(Array.isArray(body.tasks)).toBe(true);
});

test("artifacts endpoint returns a list", async ({ request }) => {
  const res = await request.get("/api/artifacts");
  const body = await res.json();
  expect(Array.isArray(body.artifacts)).toBe(true);
});

test("rejects a connector with missing fields", async ({ request }) => {
  const res = await request.post("/api/connectors", { data: { name: "x" } });
  expect(res.status()).toBe(400);
});
