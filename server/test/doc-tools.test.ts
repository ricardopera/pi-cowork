import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDocTools, DOC_TOOL_NAMES } from "../src/pi/doc-tools.js";
import type { PresentedFile } from "../src/pi/event-schema.js";

let tmpdir: string;
let emitted: PresentedFile[];

function tools() {
  emitted = [];
  return createDocTools({
    cwd: tmpdir,
    emitFiles: (files) => emitted.push(...files),
  });
}
function byName(t: any[], name: string) {
  const found = t.find((x) => x.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(async () => {
  tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cowork-doc-"));
});
afterEach(async () => {
  await fs.rm(tmpdir, { recursive: true, force: true });
});

describe("doc tools", () => {
  it("exports the expected tool names", () => {
    expect(DOC_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "create_docx",
        "create_xlsx",
        "create_pptx",
        "create_pdf",
        "create_file",
        "present_files",
      ]),
    );
  });

  it("create_docx writes a valid .docx and presents it", async () => {
    const t = byName(tools(), "create_docx");
    const res = await t.execute(
      "tc1",
      {
        filename: "report.docx",
        title: "Q3 Report",
        blocks: [
          { type: "heading", text: "Overview", level: 1 },
          { type: "paragraph", text: "Sales grew 20%." },
        ],
      },
      undefined,
      undefined,
      {} as any,
    );
    const stat = await fs.stat(path.join(tmpdir, "outputs", "report.docx"));
    expect(stat.size).toBeGreaterThan(1000); // docx is a zip, non-trivial size
    expect(emitted[0].format).toBe("docx");
    expect(emitted[0].name).toBe("report.docx");
    expect((res.content[0] as any).text).toContain("report.docx");
  });

  it("create_xlsx writes a valid .xlsx and presents it", async () => {
    const t = byName(tools(), "create_xlsx");
    await t.execute(
      "tc1",
      {
        filename: "data.xlsx",
        sheets: [
          {
            name: "Sales",
            headers: ["Region", "Revenue"],
            rows: [
              ["North", 1000],
              ["South", 2000],
            ],
          },
        ],
      },
      undefined,
      undefined,
      {} as any,
    );
    const stat = await fs.stat(path.join(tmpdir, "outputs", "data.xlsx"));
    expect(stat.size).toBeGreaterThan(1000);
    expect(emitted[0].format).toBe("xlsx");
  });

  it("create_pptx writes a valid .pptx and presents it", async () => {
    const t = byName(tools(), "create_pptx");
    await t.execute(
      "tc1",
      {
        filename: "deck.pptx",
        slides: [
          { title: "Launch", bullets: ["Goal", "Timeline"], notes: "Q3" },
          { title: "Next Steps" },
        ],
      },
      undefined,
      undefined,
      {} as any,
    );
    const stat = await fs.stat(path.join(tmpdir, "outputs", "deck.pptx"));
    expect(stat.size).toBeGreaterThan(1000);
    expect(emitted[0].format).toBe("pptx");
  });

  it("create_pdf writes a valid .pdf and presents it", async () => {
    const t = byName(tools(), "create_pdf");
    await t.execute(
      "tc1",
      {
        filename: "memo.pdf",
        title: "Memo",
        blocks: [
          { type: "heading", text: "Subject" },
          { type: "paragraph", text: "This is a memo." },
        ],
      },
      undefined,
      undefined,
      {} as any,
    );
    const buf = await fs.readFile(path.join(tmpdir, "outputs", "memo.pdf"));
    // PDF magic bytes: %PDF
    expect(buf.slice(0, 4).toString()).toBe("%PDF");
    expect(emitted[0].format).toBe("pdf");
  });

  it("create_file writes text content and infers markdown format", async () => {
    const t = byName(tools(), "create_file");
    await t.execute(
      "tc1",
      { filename: "summary.md", content: "# Hello\n\nWorld." },
      undefined,
      undefined,
      {} as any,
    );
    const txt = await fs.readFile(path.join(tmpdir, "outputs", "summary.md"), "utf8");
    expect(txt).toContain("# Hello");
    expect(emitted[0].format).toBe("md");
  });

  it("present_files surfaces existing workspace files", async () => {
    // create a file in the workspace first
    await fs.writeFile(path.join(tmpdir, "notes.txt"), "hi");
    const t = byName(tools(), "present_files");
    await t.execute("tc1", { paths: ["notes.txt"] }, undefined, undefined, {} as any);
    expect(emitted[0].name).toBe("notes.txt");
    expect(emitted[0].format).toBe("txt");
    expect(emitted[0].sizeBytes).toBe(2);
  });

  it("present_files errors on a missing path", async () => {
    const t = byName(tools(), "present_files");
    const res = await t.execute("tc1", { paths: ["nope.txt"] }, undefined, undefined, {} as any);
    expect(res.isError).toBe(true);
  });

  it("filenames are sanitized (no path traversal)", async () => {
    const t = byName(tools(), "create_file");
    await t.execute(
      "tc1",
      { filename: "../evil.txt", content: "x" },
      undefined,
      undefined,
      {} as any,
    );
    // Must land inside outputs/, not escape the workspace.
    const escaped = path.join(tmpdir, "..", "evil.txt");
    await expect(fs.stat(escaped)).rejects.toBeDefined();
    expect(emitted[0].path).toContain("outputs");
  });
});
