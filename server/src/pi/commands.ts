import { getHandle } from "./sessions.js";

/**
 * Slash commands (Cowork's slash-command feature). Because our web UI is custom
 * (not Pi's TUI), we implement our own command registry + dispatch. Commands are
 * user-typed strings like "/new", "/model glm-4.7", "/todo Clear tasks".
 *
 * A command can perform a session action (inject a message, steer, abort) or
 * return text to display. Built-in commands cover common operations; the
 * registry is extensible.
 */

export interface CommandResult {
  /** Message to show the user (acknowledgement), if any. */
  reply?: string;
  /** A prompt to inject into the session as a user message, if any. */
  inject?: string;
  /** Whether to clear the chat view. */
  clear?: boolean;
}

export interface CommandDef {
  name: string;
  description: string;
  /** Usage hint shown in autocomplete. */
  usage?: string;
  /** Execute against a session. `args` is everything after the command name. */
  execute: (sessionId: string, args: string) => Promise<CommandResult>;
}

const registry = new Map<string, CommandDef>();

export function registerCommand(def: CommandDef): void {
  registry.set(def.name.toLowerCase(), def);
}

export function listCommands(): CommandDef[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getCommand(name: string): CommandDef | undefined {
  return registry.get(name.toLowerCase());
}

export async function executeCommand(
  sessionId: string,
  input: string,
): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { inject: trimmed };
  }
  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const def = registry.get(name);
  if (!def) {
    return { reply: `Unknown command: /${name}. Type / for available commands.` };
  }
  return def.execute(sessionId, args);
}

// ---- Built-in commands ----

registerCommand({
  name: "help",
  description: "List available commands",
  async execute() {
    const cmds = listCommands();
    return {
      reply: "Commands:\n" + cmds.map((c) => `  /${c.name} — ${c.description}`).join("\n"),
    };
  },
});

registerCommand({
  name: "todo",
  description: "Quickly set the task list (comma-separated)",
  async execute(_sid, args) {
    if (!args) return { reply: "Usage: /todo task one, task two, task three" };
    const tasks = args.split(",").map((t) => t.trim()).filter(Boolean);
    // Inject as an instruction so the agent updates the todo widget.
    return { inject: `Update the task list to these items: ${tasks.map((t, i) => `${i + 1}. ${t}`).join("; ")}` };
  },
});

registerCommand({
  name: "doc",
  description: "Start a document: /doc <format> <topic>",
  usage: "/doc pdf|docx|xlsx|pptx <topic>",
  async execute(_sid, args) {
    const parts = args.split(/\s+/);
    const format = parts[0];
    const topic = parts.slice(1).join(" ");
    if (!["pdf", "docx", "xlsx", "pptx", "md"].includes(format)) {
      return { reply: "Usage: /doc <pdf|docx|xlsx|pptx|md> <topic>" };
    }
    if (!topic) return { reply: "Please provide a topic. Usage: /doc pdf <topic>" };
    return {
      inject: `Create a ${format} document about: ${topic}. Ask clarifying questions if needed, plan with todo_write, then generate the file with the matching tool and present it.`,
    };
  },
});

registerCommand({
  name: "research",
  description: "Research a topic on the web",
  async execute(_sid, args) {
    if (!args) return { reply: "Usage: /research <topic>" };
    return {
      inject: `Research "${args}" thoroughly. Use the browser tools and/or memory. Summarize findings with citations, then offer to export as a document.`,
    };
  },
});

registerCommand({
  name: "memory",
  description: "Search memory: /memory <query>",
  async execute(_sid, args) {
    if (!args) return { reply: "Usage: /memory <query>" };
    return { inject: `Search memory for: "${args}" using the memory_search tool, then summarize what you find.` };
  },
});

registerCommand({
  name: "clear",
  description: "Clear the conversation view",
  async execute() {
    return { clear: true };
  },
});

registerCommand({
  name: "stop",
  description: "Stop the current generation",
  async execute(sid) {
    const handle = getHandle(sid);
    if (handle) await handle.abort();
    return { reply: "Stopped." };
  },
});
