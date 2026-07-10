import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sandboxExec,
  isBwrapAvailable,
  buildBwrapArgs,
  sandboxBashOperations,
  getPinnedRootfs,
} from "../src/pi/sandbox.js";

let ws: string;
let hostSecret: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "sb-unit-"));
  fs.writeFileSync(path.join(ws, "hello.txt"), "from-workspace");
  hostSecret = path.join(os.tmpdir(), `host-secret-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(hostSecret, "TOPSECRET");
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(hostSecret, { force: true });
});

// Skip isolation assertions when bwrap isn't present (CI without bubblewrap),
// but always run the structure + fallback tests.
const have = isBwrapAvailable();

describe("sandbox — availability + structure", () => {
  it("reports bwrap availability consistently", () => {
    expect(typeof isBwrapAvailable()).toBe("boolean");
    expect(isBwrapAvailable()).toBe(isBwrapAvailable());
  });

  it("buildBwrapArgs produces a bind + unshare invocation", () => {
    const args = buildBwrapArgs("echo hi", { workspace: ws });
    expect(args).toContain("--bind");
    expect(args).toContain(ws);
    expect(args).toContain("/workspace");
    expect(args).toContain("--unshare-all");
    expect(args).toContain("/workspace");
    // command runs via sh -c
    expect(args).toContain("/bin/sh");
    expect(args).toContain("-c");
  });

  it("buildBwrapArgs shares net when network is allowed", () => {
    const args = buildBwrapArgs("x", { workspace: ws, network: true });
    expect(args).toContain("--share-net");
  });

  it("buildBwrapArgs omits share-net when network disabled", () => {
    const args = buildBwrapArgs("x", { workspace: ws, network: false });
    expect(args).not.toContain("--share-net");
  });
});

describe("sandbox — isolation (bubblewrap)", () => {
  it.skipIf(!have)("reads workspace files from /workspace", async () => {
    const r = await sandboxExec("cat hello.txt", { workspace: ws, network: false });
    expect(r.stdout.trim()).toBe("from-workspace");
    expect(r.exitCode).toBe(0);
  });

  it.skipIf(!have)("cannot see host /tmp (private tmpfs)", async () => {
    const r = await sandboxExec(`cat '${hostSecret}' 2>&1; echo "exit:$?"`, {
      workspace: ws,
      network: false,
    });
    // The host secret path must not be readable inside the sandbox.
    expect(r.stdout).not.toContain("TOPSECRET");
  });

  it.skipIf(!have)("cannot write to host system paths (/etc)", async () => {
    const r = await sandboxExec("echo x > /etc/pwned 2>/dev/null; echo done:$?", {
      workspace: ws,
      network: false,
    });
    // Either the write failed (non-zero) or the file isn't on the host.
    expect(fs.existsSync("/etc/pwned")).toBe(false);
  });

  it.skipIf(!have)("writes to /workspace persist to the host", async () => {
    await sandboxExec("echo created > out.txt", { workspace: ws, network: false });
    expect(fs.readFileSync(path.join(ws, "out.txt"), "utf8").trim()).toBe("created");
  });

  it.skipIf(!have)("cwd is /workspace inside the sandbox", async () => {
    const r = await sandboxExec("pwd", { workspace: ws, network: false });
    expect(r.stdout.trim()).toBe("/workspace");
  });
});

describe("sandbox — bash operations adapter", () => {
  it("exposes an exec compatible with Pi BashOperations", async () => {
    const ops = sandboxBashOperations(ws, false);
    expect(typeof ops.exec).toBe("function");
    const chunks: Buffer[] = [];
    const res = await ops.exec("echo streamed", ws, {
      onData: (d) => chunks.push(d),
      timeout: 10000,
    });
    expect(res).toHaveProperty("exitCode");
    // The streamed output should contain the echoed text (best-effort).
    const combined = Buffer.concat(chunks).toString();
    if (have) expect(combined).toContain("streamed");
  });
});

const pinned = getPinnedRootfs();

describe("sandbox — pinned toolchain rootfs", () => {
  it("detects the bundled pinned rootfs when present", () => {
    // The repo ships sandbox-rootfs/rootfs (Alpine 3.20 + toolchain).
    expect(pinned).toBeTruthy();
    expect(fs.existsSync(path.join(pinned!, "sbin", "apk"))).toBe(true);
  });

  it("buildBwrapArgs uses the pinned rootfs as / (not host /usr)", () => {
    const args = buildBwrapArgs("echo hi", { workspace: ws, mode: "pinned" });
    // The rootfs is bound as the new root.
    const rootBindIdx = args.indexOf("--bind");
    expect(rootBindIdx).toBeGreaterThan(-1);
    expect(args[rootBindIdx + 1]).toBe(pinned);
    expect(args[rootBindIdx + 2]).toBe("/");
    // Host toolchain dirs must NOT be ro-bound (only resolv.conf may be).
    const roBound = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--ro-bind") roBound.add(args[i + 2]);
    }
    for (const ht of ["/usr", "/bin", "/lib", "/lib64", "/sbin"]) {
      expect(roBound.has(ht)).toBe(false);
    }
  });

  it("buildBwrapArgs falls back to host userspace when mode=host", () => {
    const args = buildBwrapArgs("echo hi", { workspace: ws, mode: "host" });
    // Host mode ro-binds host paths; does not bind the rootfs as /.
    const asStr = args.join(" ");
    expect(asStr).not.toContain(`--bind ${pinned} /`);
  });

  it.skipIf(!have || !pinned)("runs commands against the PINNED OS, not the host", async () => {
    // Alpine has /etc/alpine-release; the host does not. If this file is
    // readable, the command ran inside the pinned rootfs.
    const r = await sandboxExec("cat /etc/alpine-release 2>/dev/null", {
      workspace: ws,
      mode: "pinned",
      network: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^3\.20\./);
  }, 20000);

  it.skipIf(!have || !pinned)("pinned toolchain has its own python3/node (not host)", async () => {
    const r = await sandboxExec("python3 --version; node --version", {
      workspace: ws,
      mode: "pinned",
      network: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Python 3\./);
    expect(r.stdout).toMatch(/v\d+\.\d+\.\d+/);
  }, 20000);
});
