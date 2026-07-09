import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createArtifactStore,
  createArtifactTools,
  ARTIFACT_TOOL_NAMES,
} from "../src/pi/artifacts.js";

let tmpData: string;
let store: ReturnType<typeof createArtifactStore>;

beforeEach(async () => {
  tmpData = await fs.mkdtemp(path.join(os.tmpdir(), "picw-art-"));
  store = createArtifactStore(tmpData);
});
afterEach(async () => {
  await fs.rm(tmpData, { recursive: true, force: true });
});

describe("artifacts", () => {
  it("exports the create_artifact tool", () => {
    expect(ARTIFACT_TOOL_NAMES).toEqual(["create_artifact"]);
  });

  it("save stores HTML and extracts the title", async () => {
    const { id, title } = await store.save(
      "<html><head><title>My Chart</title></head><body>hi</body></html>",
    );
    expect(id).toBeTruthy();
    expect(title).toBe("My Chart");
    const html = await store.get(id);
    expect(html).toContain("<title>My Chart</title>");
  });

  it("get returns null for unknown id", async () => {
    expect(await store.get("nonexistent")).toBeNull();
  });

  it("list returns saved artifacts", async () => {
    await store.save("<html><head><title>A</title></head></html>");
    await store.save("<html><head><title>B</title></head></html>");
    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list.map((a) => a.title).sort()).toEqual(["A", "B"]);
  });

  it("create_artifact tool saves + emits an artifact event", async () => {
    let emitted: any = null;
    const tools = createArtifactTools({
      emitArtifact: (artifactId, title) => (emitted = { artifactId, title }),
    });
    const create = tools.find((t) => t.name === "create_artifact")!;
    const res = await create.execute(
      "tc1",
      { html: "<html><head><title>Dashboard</title></head><body><div id='x'></div></body></html>" },
      undefined,
      undefined,
      {} as any,
    );
    expect(emitted).toBeTruthy();
    expect(emitted.title).toBe("Dashboard");
    expect((res.content[0] as any).text).toContain("Dashboard");
    expect((res.details as any).id).toBeTruthy();
  });

  it("falls back to 'Untitled artifact' when no title tag", async () => {
    const { title } = await store.save("<html><body>no title</body></html>");
    expect(title).toBe("Untitled artifact");
  });
});
