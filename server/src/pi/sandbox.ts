import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

/**
 * Sandboxed execution layer (mirrors Claude Cowork's pinned-toolchain VM model).
 *
 * Two sandbox modes:
 *
 *  1. PINNED ROOTFS (default when available): a self-contained Linux rootfs
 *     (Alpine 3.20 + python3/node/git/... — the "pinned toolchain") is bundled
 *     under sandbox-rootfs/rootfs. Commands run with that rootfs as `/`, so
 *     bash/file tools execute against a FIXED, REPRODUCIBLE OS image — not the
 *     host's userspace. The workspace is the only host path mounted (rw at
 *     /workspace). This matches Cowork's sandboxed-VM-with-pinned-toolchain
 *     model.
 *
 *  2. HOST USERSPACE (fallback): if the pinned rootfs isn't present, bwrap
 *     read-only-binds the host's /usr, /bin, /lib, /lib64, /sbin. Less
 *     reproducible (depends on the host) but still namespace-isolated.
 *
 * Both modes: /proc and /dev fresh, private tmpfs /tmp (host /tmp hidden),
 * user/PID/IPC/net namespaces unshared (--unshare-all), cwd=/workspace.
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

/**
 * Resolve the pinned rootfs directory. Looks for a bundled Alpine rootfs at
 * <repo>/sandbox-rootfs/rootfs (shipped with Pi-Cowork). Returns null if absent
 * (caller falls back to host-userspace mode).
 */
export function getPinnedRootfs(): string | null {
  // sandbox-rootfs/ lives at the repo root. Resolve from this module's location
  // (works for tsx src/pi/ and built dist/pi/) plus cwd (dev from repo root).
  const here =
    typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
  // Check by looking for the rootfs marker without following symlinks: the
  // rootfs's /bin/sh is a symlink whose absolute target only resolves *inside*
  // the rootfs, so existsSync (which follows) returns false from the host.
  // Use lstatSync on the rootfs dir + check bin/busybox (a real file) instead.
  const isRootfs = (dir: string): boolean =>
    fs.existsSync(path.join(dir, "sbin", "apk")) &&
    (fs.existsSync(path.join(dir, "bin", "busybox")) ||
      fs.existsSync(path.join(dir, "usr", "bin", "busybox")));
  for (const up of ["../../..", ".."]) {
    const candidate = path.join(here, up, "sandbox-rootfs", "rootfs");
    if (isRootfs(candidate)) return path.resolve(candidate);
  }
  const cwdCandidate = path.resolve("sandbox-rootfs", "rootfs");
  if (isRootfs(cwdCandidate)) return cwdCandidate;
  return null;
}

// Host paths used only in HOST USERSPACE fallback mode.
const HOST_RO_BINDS: string[] = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc/alternatives"];

export interface SandboxOptions {
  /** Absolute host path of the session workspace (bind-mounted at /workspace). */
  workspace: string;
  /** Allow network egress inside the sandbox (default true). */
  network?: boolean;
  /** Extra read-only host dirs to expose inside the sandbox. */
  roBinds?: string[];
  /** Timeout ms (passed through to the runner). */
  timeoutMs?: number;
  /**
   * Force a specific mode: "pinned" uses the bundled rootfs, "host" uses the
   * host's userspace. Default: auto (pinned if available, else host).
   */
  mode?: "pinned" | "host" | "auto";
}

/** Resolve effective mode: pinned if rootfs present (unless explicitly host). */
function resolveMode(mode?: "pinned" | "host" | "auto"): "pinned" | "host" {
  if (mode === "host") return "host";
  if (mode === "pinned") return getPinnedRootfs() ? "pinned" : "host";
  return getPinnedRootfs() ? "pinned" : "host";
}

/**
 * Build the bwrap argv for a command. The user's command runs via `sh -c`
 * INSIDE the container, with cwd=/workspace.
 */
export function buildBwrapArgs(command: string, opts: SandboxOptions): string[] {
  const args: string[] = [];
  const mode = resolveMode(opts.mode);
  const rootfs = getPinnedRootfs();

  if (mode === "pinned" && rootfs) {
    // PINNED ROOTFS: the bundled Alpine rootfs becomes `/`. Its own pinned
    // toolchain (sh, coreutils, python3, node, git, ...) is used — NOT host.
    args.push("--bind", rootfs, "/");
    args.push("--dev", "/dev", "--proc", "/proc");
    // Private tmpfs /tmp (the rootfs has no /tmp content anyway).
    args.push("--tmpfs", "/tmp");
    // DNS for network egress (apk/curl/git work) — copy host resolv.conf in.
    if (fs.existsSync("/etc/resolv.conf")) {
      args.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf");
    }
    // ca-certificates from the rootfs handle TLS.
  } else {
    // HOST USERSPACE fallback: read-only host toolchain.
    for (const dir of HOST_RO_BINDS) {
      if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
    }
    args.push("--proc", "/proc", "--dev", "/dev");
    args.push("--tmpfs", "/tmp");
  }

  // Extra read-only binds (host dirs the caller wants exposed).
  for (const dir of opts.roBinds ?? []) {
    if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  // Workspace bind-mounted read-write at /workspace (the only writable host path).
  args.push("--bind", opts.workspace, "/workspace");
  // Namespace isolation: own user/pid/ipc/net namespace.
  args.push("--unshare-all");
  if (opts.network !== false) args.push("--share-net");
  args.push("--die-with-parent", "--new-session");
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
