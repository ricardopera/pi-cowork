import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import cron from "node-cron";
import { config } from "../config.js";

/**
 * Scheduled tasks (Cowork's scheduled-tasks feature). Each task has a prompt
 * and either a cron expression (recurring) or a one-shot fireAt (ISO time).
 * On each tick, the scheduler spins up an in-memory Pi session and runs the
 * prompt autonomously. Tasks persist to <dataDir>/scheduler/tasks.json so they
 * survive restarts.
 */

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule?: { type: "cron"; expression: string };
  fireAt?: string; // ISO timestamp for one-shot
  status: "active" | "paused" | "done";
  lastRunAt?: string;
  lastRunResult?: string;
  createdAt: string;
}

export interface SchedulerRunFn {
  (prompt: string): Promise<string>;
}

const TASKS_FILE = () => path.join(config.dataDir, "scheduler", "tasks.json");

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private jobs = new Map<string, cron.ScheduledTask>();
  private loaded = false;
  private runner: SchedulerRunFn | null = null;
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? config.dataDir;
  }

  private tasksFile(): string {
    return path.join(this.dataDir, "scheduler", "tasks.json");
  }

  /** Provide the function that runs a prompt in a fresh agent session. */
  setRunner(fn: SchedulerRunFn): void {
    this.runner = fn;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.tasksFile(), "utf8");
      const arr: ScheduledTask[] = JSON.parse(raw);
      for (const t of arr) {
        this.tasks.set(t.id, t);
        if (t.status === "active") this.scheduleJob(t);
        // One-shot tasks whose time has passed while offline: mark done (no
        // catch-up backlog to avoid surprise runs).
        if (t.fireAt && t.status === "active" && new Date(t.fireAt) <= new Date()) {
          t.status = "done";
        }
      }
    } catch {
      /* no tasks file yet */
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.tasksFile()), { recursive: true });
    await fs.writeFile(this.tasksFile(), JSON.stringify([...this.tasks.values()], null, 2));
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  async create(input: {
    name: string;
    prompt: string;
    cronExpression?: string;
    fireAt?: string;
  }): Promise<ScheduledTask> {
    if (!input.prompt) throw new Error("prompt required");
    const id = crypto.randomUUID();
    let task: ScheduledTask;
    if (input.fireAt) {
      const when = new Date(input.fireAt);
      if (isNaN(when.getTime())) throw new Error("invalid fireAt (use ISO 8601)");
      task = {
        id,
        name: input.name || `Run at ${when.toISOString()}`,
        prompt: input.prompt,
        fireAt: when.toISOString(),
        status: "active",
        createdAt: new Date().toISOString(),
      };
      this.scheduleOneShot(task);
    } else if (input.cronExpression) {
      if (!cron.validate(input.cronExpression)) {
        throw new Error(`invalid cron expression: ${input.cronExpression}`);
      }
      task = {
        id,
        name: input.name || `Cron ${input.cronExpression}`,
        prompt: input.prompt,
        schedule: { type: "cron", expression: input.cronExpression },
        status: "active",
        createdAt: new Date().toISOString(),
      };
      this.scheduleJob(task);
    } else {
      throw new Error("provide either cronExpression or fireAt");
    }
    this.tasks.set(id, task);
    await this.persist();
    return task;
  }

  async update(id: string, patch: { status?: "active" | "paused" }): Promise<ScheduledTask | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (patch.status) {
      t.status = patch.status;
      if (patch.status === "paused") {
        this.jobs.get(id)?.stop();
      } else if (patch.status === "active" && t.schedule) {
        this.scheduleJob(t);
      }
    }
    await this.persist();
    return t;
  }

  async remove(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
    const existed = this.tasks.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  private scheduleJob(task: ScheduledTask): void {
    this.jobs.get(task.id)?.stop();
    if (!task.schedule) return;
    const job = cron.schedule(task.schedule.expression, () => this.runTask(task.id));
    this.jobs.set(task.id, job);
  }

  private scheduleOneShot(task: ScheduledTask): void {
    if (!task.fireAt) return;
    const delay = new Date(task.fireAt).getTime() - Date.now();
    if (delay <= 0) {
      task.status = "done";
      return;
    }
    const timer = setTimeout(() => this.runTask(task.id), delay);
    // Keep the timer from keeping the process alive indefinitely; allow exit.
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    this.jobs.set(task.id, { stop: () => clearTimeout(timer) } as any);
  }

  private async runTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "active" || !this.runner) return;
    task.lastRunAt = new Date().toISOString();
    try {
      const result = await this.runner(task.prompt);
      task.lastRunResult = `ok: ${result.slice(0, 200)}`;
      if (task.fireAt) task.status = "done"; // one-shot completes
    } catch (e: any) {
      task.lastRunResult = `error: ${e?.message ?? String(e)}`;
    }
    await this.persist();
  }

  /** Stop all scheduled jobs (for clean shutdown / tests). */
  dispose(): void {
    for (const [, job] of this.jobs) {
      try {
        job.stop();
      } catch {
        /* ignore */
      }
    }
    this.jobs.clear();
  }
}

// Module-level singleton.
let scheduler: Scheduler | null = null;
export function getScheduler(): Scheduler {
  if (!scheduler) scheduler = new Scheduler();
  return scheduler;
}
