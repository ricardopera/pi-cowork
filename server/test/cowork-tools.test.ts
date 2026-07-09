import { describe, it, expect, vi } from "vitest";
import { createCoworkTools, type CoworkToolDeps } from "../src/pi/cowork-tools.js";

// Build a deps harness that captures emitted events and lets us resolve
// pending questions on demand.
function harness(): CoworkToolDeps & {
  emitted: any[];
  resolvers: Map<string, (a: string) => void>;
  deliver: (id: string, answer: string) => void;
} {
  const emitted: any[] = [];
  const resolvers = new Map<string, (a: string) => void>();
  return {
    emitted,
    resolvers,
    deliver(id, answer) {
      resolvers.get(id)?.(answer);
    },
    emit(evt) {
      emitted.push(evt);
    },
    registerQuestion(questionId) {
      return new Promise<string>((resolve) => {
        resolvers.set(questionId, resolve);
      });
    },
  };
}

function toolByName(tools: any[], name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found in [${tools.map((t) => t.name).join(", ")}]`);
  return t;
}

describe("cowork tools", () => {
  it("creates ask_question and todo_write tools", () => {
    const tools = createCoworkTools(harness());
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask_question", "todo_write"]));
  });

  it("todo_write emits a todo_update event with the full list and returns a summary", async () => {
    const h = harness();
    const tools = createCoworkTools(h);
    const todoWrite = toolByName(tools, "todo_write");
    const todos = [
      { content: "Research the topic", status: "completed" as const },
      { content: "Write the draft", status: "in_progress" as const },
      { content: "Proofread", status: "pending" as const },
    ];
    const result = await todoWrite.execute("tc1", { todos }, undefined, undefined, {} as any);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toEqual({ kind: "todo_update", todos });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toContain("3 items");
    expect(result.details).toEqual({ todos });
  });

  it("ask_question emits an ask_question event and blocks until answered", async () => {
    const h = harness();
    const tools = createCoworkTools(h);
    const ask = toolByName(tools, "ask_question");
    const execPromise = ask.execute(
      "call-99",
      { question: "What length?", options: ["short", "long"] },
      undefined,
      undefined,
      {} as any,
    );
    // Must not resolve yet.
    let resolved = false;
    execPromise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    expect(h.emitted).toEqual([
      { kind: "ask_question", questionId: "call-99", question: "What length?", options: ["short", "long"] },
    ]);
    // Deliver the answer.
    h.deliver("call-99", "long");
    const result = await execPromise;
    expect(resolved).toBe(true);
    expect((result.content[0] as any).text).toContain("long");
    expect(result.details).toMatchObject({ answer: "long" });
  });

  it("ask_question works without options (open-ended)", async () => {
    const h = harness();
    const ask = toolByName(createCoworkTools(h), "ask_question");
    const p = ask.execute("q1", { question: "Who is the audience?" }, undefined, undefined, {} as any);
    await new Promise((r) => setTimeout(r, 5));
    h.deliver("q1", "engineers");
    const result = await p;
    expect(h.emitted[0].options).toBeUndefined();
    expect((result.content[0] as any).text).toContain("engineers");
  });
});
