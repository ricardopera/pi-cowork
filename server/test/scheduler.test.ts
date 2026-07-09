import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Scheduler } from "../src/pi/scheduler.js";

let tmpData: string;
let sched: Scheduler;

beforeEach(async () => {
  tmpData = await fs.mkdtemp(path.join(os.tmpdir(), "picw-sched-"));
  sched = new Scheduler(tmpData);
  await sched.load();
});
afterEach(async () => {
  sched.dispose();
  await fs.rm(tmpData, { recursive: true, force: true });
});

describe("scheduler", () => {
  it("creates a cron task with a valid expression", async () => {
    const t = await sched.create({ name: "Daily", prompt: "Summarize news", cronExpression: "0 9 * * *" });
    expect(t.id).toBeTruthy();
    expect(t.schedule?.expression).toBe("0 9 * * *");
    expect(t.status).toBe("active");
  });

  it("rejects an invalid cron expression", async () => {
    await expect(
      sched.create({ name: "bad", prompt: "x", cronExpression: "not a cron" }),
    ).rejects.toThrow(/invalid cron/);
  });

  it("requires either cron or fireAt", async () => {
    await expect(sched.create({ name: "x", prompt: "x" })).rejects.toThrow(/cronExpression or fireAt/);
  });

  it("requires a prompt", async () => {
    await expect(
      sched.create({ name: "x", prompt: "", cronExpression: "0 9 * * *" }),
    ).rejects.toThrow(/prompt required/);
  });

  it("creates a one-shot task with fireAt", async () => {
    const when = new Date(Date.now() + 60000).toISOString();
    const t = await sched.create({ name: "Once", prompt: "Do thing", fireAt: when });
    expect(t.fireAt).toBe(when);
    expect(t.status).toBe("active");
  });

  it("rejects an invalid fireAt", async () => {
    await expect(
      sched.create({ name: "x", prompt: "x", fireAt: "not-a-date" }),
    ).rejects.toThrow(/invalid fireAt/);
  });

  it("list returns created tasks", async () => {
    await sched.create({ name: "A", prompt: "x", cronExpression: "0 9 * * *" });
    await sched.create({ name: "B", prompt: "y", cronExpression: "0 10 * * *" });
    expect(sched.list().length).toBe(2);
  });

  it("update pauses a task", async () => {
    const t = await sched.create({ name: "A", prompt: "x", cronExpression: "0 9 * * *" });
    const updated = await sched.update(t.id, { status: "paused" });
    expect(updated?.status).toBe("paused");
  });

  it("remove deletes a task", async () => {
    const t = await sched.create({ name: "A", prompt: "x", cronExpression: "0 9 * * *" });
    const ok = await sched.remove(t.id);
    expect(ok).toBe(true);
    expect(sched.get(t.id)).toBeUndefined();
  });

  it("persists tasks to disk and reloads them", async () => {
    const t = await sched.create({ name: "Persist", prompt: "x", cronExpression: "0 9 * * *" });
    // New scheduler instance reading the same data dir.
    const sched2 = new Scheduler(tmpData);
    await sched2.load();
    expect(sched2.get(t.id)).toBeTruthy();
    expect(sched2.get(t.id)?.name).toBe("Persist");
  });

  it("runner is invoked and result recorded on a near-term one-shot", async () => {
    // Use a real (short) timer: fireAt ~1s in the future. Verify the runner
    // is called and the task records lastRunAt + result, then marks done.
    let calls = 0;
    sched.setRunner(async () => {
      calls++;
      return "ran";
    });
    const when = new Date(Date.now() + 1000).toISOString();
    const t = await sched.create({ name: "Soon", prompt: "tick", fireAt: when });
    // Wait long enough for the one-shot timer to fire + async runner to settle.
    await new Promise((r) => setTimeout(r, 2200));
    expect(calls).toBeGreaterThanOrEqual(1);
    const refreshed = sched.get(t.id);
    expect(refreshed?.lastRunAt).toBeTruthy();
    expect(refreshed?.lastRunResult).toContain("ran");
    // One-shot tasks complete after firing.
    expect(refreshed?.status).toBe("done");
  }, 10000);
});
