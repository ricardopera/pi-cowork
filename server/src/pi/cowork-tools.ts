import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TodoItem } from "../event-schema.js";

/**
 * Cowork-specific custom tools, layered on top of Pi Agent's built-in tools.
 *
 * - `ask_question`: pauses the agent until the user answers a clarifying question.
 *   Implemented by having execute() await a deferred promise resolved when the
 *   browser POSTs an answer to /api/sessions/:id/answers.
 * - `todo_write`: pushes the current task list to the UI (full replacement).
 *
 * The factory receives a `deps` object so the engine can wire the tools to the
 * session's WS event stream and answer resolver without the tools knowing about
 * HTTP or WebSockets.
 */
export interface CoworkToolDeps {
  /** Emit a wire event to all subscribers of this session. */
  emit: (event: AskQuestionEvent | TodoUpdateEvent) => void;
  /**
   * Register a pending question and return a promise that resolves with the
   * user's answer when `resolveAnswer(questionId, answer)` is called.
   * The promise rejects if aborted.
   */
  registerQuestion: (questionId: string) => Promise<string>;
}

export interface AskQuestionEvent {
  kind: "ask_question";
  questionId: string;
  question: string;
  options?: string[];
}
export interface TodoUpdateEvent {
  kind: "todo_update";
  todos: TodoItem[];
}

export function createCoworkTools(deps: CoworkToolDeps): ToolDefinition[] {
  const askQuestion = defineTool({
    name: "ask_question",
    label: "Ask clarifying question",
    description:
      "Ask the user a clarifying question before doing real work. Use this when " +
      "the user's request is ambiguous (e.g. audience, length, tone, format). " +
      "Provide 2-4 concrete options when possible; the user picks one (or types " +
      "their own). Returns the user's answer as text. The agent pauses until answered.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The clarifying question to ask the user.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "2-4 concrete multiple-choice options. Omit for an open-ended question.",
        },
      },
      required: ["question"],
    },
    promptGuidelines: [
      "Ask before starting non-trivial work when requirements are ambiguous.",
      "Prefer offering concrete options over open-ended questions.",
    ],
    async execute(toolCallId, params) {
      const questionId = toolCallId;
      const { question, options } = params as { question: string; options?: string[] };
      deps.emit({ kind: "ask_question", questionId, question, options });
      // Block until the user answers. The answer flows in via the REST endpoint.
      const answer = await deps.registerQuestion(questionId);
      return {
        content: [
          {
            type: "text",
            text: `The user answered: ${answer}`,
          },
        ],
        details: { question, options, answer },
      };
    },
  });

  const todoWrite = defineTool({
    name: "todo_write",
    label: "Update task list",
    description:
      "Create or update the task list shown to the user. Use this when breaking a " +
      "request into steps, and to mark steps in_progress/completed as you work. " +
      "Pass the FULL list each time (this replaces the existing list). Set exactly " +
      "one item to in_progress at a time.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Short description of the task." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "pending = not started, in_progress = working on it now, completed = done.",
              },
              priority: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "Optional priority.",
              },
            },
            required: ["content", "status"],
          },
          description: "The complete, updated task list (replaces the previous list).",
        },
      },
      required: ["todos"],
    },
    promptGuidelines: [
      "Break non-trivial work into steps and track them with todo_write.",
      "Keep exactly one task in_progress at a time; mark completed as soon as done.",
      "Pass the full list on every call (it replaces the previous one).",
    ],
    async execute(_toolCallId, params) {
      const { todos } = params as { todos: TodoItem[] };
      deps.emit({ kind: "todo_update", todos });
      return {
        content: [
          {
            type: "text",
            text: `Task list updated (${todos.length} item${todos.length === 1 ? "" : "s"}).`,
          },
        ],
        details: { todos },
      };
    },
  });

  return [askQuestion, todoWrite];
}
