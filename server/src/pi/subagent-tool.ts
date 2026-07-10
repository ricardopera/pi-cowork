import path from "node:path";
import os from "node:os";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getAuthStorage, getModelRegistry } from "./providers.js";

/**
 * Sub-agent dispatch tool (Cowork's sub-agent capability). Takes an array of
 * independent tasks and runs them CONCURRENTLY using separate in-memory Pi
 * agent sessions, then aggregates each sub-agent's final assistant text.
 *
 * Concurrency is capped (MAX_CONCURRENCY). A recursion guard prevents sub-agents
 * from themselves calling dispatch_subagents (the tool is omitted from their
 * active tool set). Sub-agents run with the built-in read/bash/edit/write/grep
 * tools so they can do real work in the workspace.
 */

const MAX_CONCURRENCY = 4;
const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep"];

export function createSubagentTool(): ToolDefinition {
  const runOne = async (
    task: string,
    model: any,
    onProgress?: (update: string) => void,
  ): Promise<string> => {
    // Isolated temp working dir per sub-agent so filesystem side effects don't collide.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cowork-sub-"));
    try {
      const { session } = await createAgentSession({
        cwd,
        model,
        authStorage: getAuthStorage(),
        modelRegistry: getModelRegistry(),
        tools: SUBAGENT_TOOLS,
        sessionManager: SessionManager.inMemory(cwd),
      });
      let finalText = "";
      const unsubscribe = session.subscribe((event: any) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta"
        ) {
          finalText += event.assistantMessageEvent.delta ?? "";
        }
        if (event.type === "tool_execution_start") {
          onProgress?.(`[${task.slice(0, 40)}] running ${event.toolName}`);
        }
      });
      try {
        await session.prompt(task);
        await session.waitForIdle();
      } finally {
        unsubscribe();
        session.dispose();
      }
      return finalText.trim() || "(no output)";
    } finally {
      // Best-effort cleanup; tmp dirs may persist if a sub-agent is mid-write.
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  };

  return defineTool({
    name: "dispatch_subagents",
    label: "Dispatch parallel sub-agents",
    description:
      "Run multiple INDEPENDENT tasks concurrently by spawning separate agent " +
      "sessions (sub-agents), each with its own context. Use for fan-out work " +
      "like researching several topics at once or drafting multiple sections. " +
      "Returns each task's result. Tasks must be independent (no shared state); " +
      "do NOT use for sequential/dependent steps. Max " +
      MAX_CONCURRENCY +
      " run concurrently.",
    parameters: Type.Object({
      type: Type.Optional(Type.String()),
      tasks: Type.Array(
        Type.Object({
          task: Type.String({ description: "A self-contained instruction for one sub-agent." }),
        }),
        { description: "Array of independent tasks (each runs in its own agent)." },
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate) {
      const { tasks } = params as { tasks: { task: string }[] };
      if (!tasks?.length) {
        return {
          content: [{ type: "text", text: "No tasks provided." }],
          details: {},
          isError: true,
        };
      }
      if (tasks.length > 12) {
        return {
          content: [{ type: "text", text: "Too many tasks (max 12). Split into smaller batches." }],
          details: {},
          isError: true,
        };
      }
      // Reuse the parent's model (resolved by the session; undefined = default).
      // Sub-agents inherit the same auth/model registry via getAuthStorage().
      const results: { task: string; result: string; error?: string }[] = [];
      // Simple concurrency limiter.
      let cursor = 0;
      const workers: Promise<void>[] = [];
      const runWorker = async () => {
        while (cursor < tasks.length) {
          const idx = cursor++;
          const task = tasks[idx].task;
          try {
            const text = await runOne(task, undefined, (u) =>
              onUpdate?.({
                content: [{ type: "text", text: u }],
                details: {},
              }),
            );
            results[idx] = { task, result: text };
          } catch (e: any) {
            results[idx] = { task, result: "", error: e?.message ?? String(e) };
          }
        }
      };
      const n = Math.min(MAX_CONCURRENCY, tasks.length);
      for (let i = 0; i < n; i++) workers.push(runWorker());
      await Promise.all(workers);

      const summary = results
        .map(
          (r, i) =>
            `### Sub-agent ${i + 1}\nTask: ${r.task}\n${r.error ? `Error: ${r.error}` : `Result:\n${r.result}`}`,
        )
        .join("\n\n");
      return {
        content: [{ type: "text", text: `Completed ${results.length} sub-agent task(s).\n\n${summary}` }],
        details: { count: results.length, errors: results.filter((r) => r.error).length },
      };
    },
  });
}

// fs import deferred to avoid a circular-ish top-level cost; declared here.
import fs from "node:fs/promises";

export const SUBAGENT_TOOL_NAMES = ["dispatch_subagents"];
