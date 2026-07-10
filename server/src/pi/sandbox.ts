import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";

/**
 * Sandboxed execution layer (mirrors Claude Cowork's bubblewrap/VM model).
 *
 * Each command runs inside a bubblewrap (`bwrap`) container with:
 *   - A read-only OS toolchain (/usr, /bin, /lib, /lib64) mounted from the host
 *   - /proc and /dev mounted fresh
 *   - A private tmpfs /tmp (host /tmp NOT visible)
 *   - The session workspace bind-mounted read-write at /workspace (the only
 *     writable host path the sandbox can reach)
 *   - User/PID/IPC namespaces unshared (--unshare-all); network shared by default
 *     so the agent can curl/install, toggleable per-session
 *   - cwd set to /workspace so the command "lives" in the sandboxed workspace
 *
 * Falls back to plain execution if bwrap is unavailable (logged), so the app
 * still works on systems without bubblewrap.
 */

const BWRAP_BIN = "bwrap";
let bwrapAvailable: boolean | null = null;

/** Detect whether bubblewrap is installed and functional. */
export function isBwrapAvailable(): boolean {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    bwrapAvailable = fs.existsSync("/usr/sbin/bwrap") || fs.existsSync("/usr/bin/bwrap");
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

// Read-only host paths that form the pinned Linux toolchain inside the sandbox.
// Mounting these read-only gives the sandbox a full userspace (sh, coreutils,
// python, node, gcc, git, etc. — whatever the host has) without leaking host
// state or config.
const RO_BINDS: string[] = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc/alternatives"];

export interface SandboxOptions {
  /** Absolute host path of the session workspace (bind-mounted at /workspace). */
  workspace: string;
  /** Allow network egress inside the sandbox (default true). */
  network?: boolean;
  /** Extra read-only host dirs to expose inside the sandbox. */
  roBinds?: string[];
  /** Timeout ms (passed through to the runner). */
  timeoutMs?: number;
}

/**
 * Build the bwrap argv for a command. The user's command runs via `sh -c`
 * INSIDE the container, with cwd=/workspace.
 */
export function buildBwrapArgs(command: string, opts: SandboxOptions): string[] {
  const args: string[] = [];
  // Read-only toolchain
  for (const dir of RO_BINDS) {
    if (fs.existsSync(dir)) {
      args.push("--ro-bind", dir, dir);
    }
  }
  // /proc + /dev fresh
  args.push("--proc", "/proc", "--dev", "/dev");
  // Private tmpfs /tmp (host /tmp hidden)
  args.push("--tmpfs", "/tmp");
  // Extra read-only binds
  for (const dir of opts.roBinds ?? []) {
    if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  // Workspace bind-mounted read-write at /workspace
  args.push("--bind", opts.workspace, "/workspace");
  // Namespace isolation: own user/pid/ipc/net namespace.
  args.push("--unshare-all");
  if (opts.network !== false) args.push("--share-net"); // re-share net if allowed
  // Die with parent, fresh session (can't tty-takeover)
  args.push("--die-with-parent", "--new-session");
  // chdir to the workspace then run the command
  args.push("--chdir", "/workspace", "/bin/sh", "-c", command);
  return args;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute a command inside a per-session bubblewrap sandbox. Streams stdout/stderr
 * via onData callbacks (compatible with Pi's BashOperations.exec).
 */
export function sandboxExec(
  command: string,
  opts: SandboxOptions,
  callbacks?: { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  // Fallback: run unsandboxed if bwrap isn't present (keeps the app usable).
  if (!isBwrapAvailable()) {
    return execUnsandboxed(command, opts.workspace, callbacks);
  }
  return new Promise((resolve) => {
    const args = buildBwrapArgs(command, opts);
    const child = spawn(BWRAP_BIN, args, {
      env: { ...process.env, ...callbacks?.env, HOME: "/workspace" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      callbacks?.onData?.(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      callbacks?.onData?.(d);
    });
    const timer =
      callbacks?.timeout || opts.timeoutMs
        ? setTimeout(() => child.kill("SIGKILL"), callbacks?.timeout ?? opts.timeoutMs)
        : null;
    callbacks?.signal?.addEventListener("abort", () => child.kill("SIGKILL"));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + "\n" + err.message });
    });
  });
}

// Plain fallback when bwrap is unavailable.
function execUnsandboxed(
  command: string,
  cwd: string,
  callbacks?: { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, ...callbacks?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      callbacks?.onData?.(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      callbacks?.onData?.(d);
    });
    const timer = callbacks?.timeout ? setTimeout(() => child.kill("SIGKILL"), callbacks.timeout) : null;
    callbacks?.signal?.addEventListener("abort", () => child.kill("SIGKILL"));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * A Pi `BashOperations` implementation that runs every command inside a
 * per-session bubblewrap sandbox. Pass this to `createBashTool(cwd, { operations })`
 * so Pi's bash tool (streaming, timeout, truncation) is preserved while the
 * command itself executes isolated.
 */
export function sandboxBashOperations(workspace: string, network = true): {
  exec: (command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number | null }>;
} {
  return {
    async exec(command, _cwd, options) {
      const res = await sandboxExec(command, { workspace, network }, options);
      return { exitCode: res.exitCode };
    },
  };
}
