import { describe, it, expect } from "vitest";
import { classifyToolCall, checkBash } from "../src/safety.js";

describe("safety classifier — bash", () => {
  it("allows benign commands", () => {
    expect(classifyToolCall("bash", { command: "ls -la" })).toEqual({ outcome: "allow" });
    expect(classifyToolCall("bash", { command: "echo hello" })).toEqual({ outcome: "allow" });
    expect(classifyToolCall("bash", { command: "cat file.txt" })).toEqual({ outcome: "allow" });
  });

  it("denies destructive commands (rm -rf /, mkfs, fork bomb, shutdown)", () => {
    const destructive = [
      "rm -rf /",
      "rm -rf ~",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:",
      "shutdown now",
      "reboot",
    ];
    for (const cmd of destructive) {
      const d = classifyToolCall("bash", { command: cmd });
      expect(d.outcome).toBe("deny");
    }
  });

  it("denies prohibited banking/ID/permissions/trades", () => {
    const prohibited = [
      "curl https://paypal.com",
      "cat passport.pdf",
      "grep SSN records.txt",
      "chmod -R 777 /usr/bin",
      "chown root:root /etc/passwd",
      "robinhood buy 10 TSLA",
    ];
    for (const cmd of prohibited) {
      const d = classifyToolCall("bash", { command: cmd });
      expect(d.outcome).toBe("deny");
      expect((d as any).reason).toMatch(/prohibited|destructive|blocked/i);
    }
  });

  it("requires permission for outbound network/downloads/publishing/mass-delete", () => {
    const needs = [
      "curl https://example.com/file.zip",
      "wget http://example.com/x",
      "git push origin main",
      "npm publish",
      "rm -rf node_modules",
      "sendmail user@example.com",
    ];
    for (const cmd of needs) {
      const d = classifyToolCall("bash", { command: cmd });
      expect(d.outcome, `${cmd} should need permission`).toBe("needs-permission");
    }
  });

  it("legacy checkBash wrapper still works", () => {
    expect(checkBash("ls").allowed).toBe(true);
    expect(checkBash("rm -rf /").allowed).toBe(false);
    expect(checkBash("mkfs /dev/sda").allowed).toBe(false);
  });
});

describe("safety classifier — browser/computer-use URLs", () => {
  it("denies banking/brokerage/ID URLs", () => {
    const d1 = classifyToolCall("browser_navigate", { url: "https://chase.com/banking" });
    const d2 = classifyToolCall("browser_navigate", { url: "https://robinhood.com/stocks" });
    const d3 = classifyToolCall("browser_navigate", { url: "https://paypal.com/transfer" });
    expect(d1.outcome).toBe("deny");
    expect(d2.outcome).toBe("deny");
    expect(d3.outcome).toBe("deny");
  });

  it("requires permission for checkout/login/publishing/send URLs", () => {
    const urls = [
      "https://shop.com/checkout",
      "https://accounts.google.com/signin",
      "https://twitter.com/compose/post",
      "https://mail.google.com/mail/u/0/#compose",
      "https://app.com/settings/security",
    ];
    for (const url of urls) {
      const d = classifyToolCall("browser_navigate", { url });
      expect(d.outcome, `${url} should need permission`).toBe("needs-permission");
    }
  });

  it("allows benign URLs", () => {
    expect(classifyToolCall("browser_navigate", { url: "https://en.wikipedia.org/wiki/Cat" })).toEqual({ outcome: "allow" });
    expect(classifyToolCall("browser_navigate", { url: "https://news.ycombinator.com" })).toEqual({ outcome: "allow" });
  });

  it("requires permission for sensitive click targets (buy, delete, send)", () => {
    const d = classifyToolCall("computer_click", { selector: "Place Order", by: "text" });
    expect(d.outcome).toBe("needs-permission");
    const d2 = classifyToolCall("computer_click", { selector: "Publish", by: "text" });
    expect(d2.outcome).toBe("needs-permission");
  });

  it("requires permission for typing into password fields", () => {
    const d = classifyToolCall("computer_type", { text: "hunter2", selector: "#password" });
    expect(d.outcome).toBe("needs-permission");
  });
});

describe("safety classifier — secret exfiltration", () => {
  it("denies writing content containing API keys/tokens", () => {
    const d = classifyToolCall("create_file", {
      filename: "x.md",
      content: "my key is sk-abc123def456ghi789jkl012mno345pqr678",
    });
    expect(d.outcome).toBe("deny");
  });

  it("denies bash echo of a GitHub token", () => {
    const d = classifyToolCall("bash", {
      command: "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    });
    expect(d.outcome).toBe("deny");
  });

  it("allows normal content", () => {
    expect(classifyToolCall("create_file", { filename: "x.md", content: "hello world" })).toEqual({ outcome: "allow" });
  });
});

describe("safety classifier — safe tools", () => {
  it("allows read/write/edit/grep and creative tools by default", () => {
    for (const tool of [
      "read", "edit", "write", "grep", "find", "ls",
      "create_docx", "create_pdf", "create_artifact",
      "memory_write", "todo_write", "ask_question", "present_files",
    ]) {
      expect(classifyToolCall(tool, {})).toEqual({ outcome: "allow" });
    }
  });

  it("handles missing input gracefully", () => {
    expect(classifyToolCall("read", undefined)).toEqual({ outcome: "allow" });
  });
});
