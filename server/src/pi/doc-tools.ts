import path from "node:path";
import fs from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent/dist/core/extensions/types.js";
import type { PresentedFile } from "../event-schema.js";

/**
 * Document-creation tools + present_files. These run server-side in the
 * session workspace and write files to <cwd>/outputs/. Each generator returns
 * a PresentedFile; `present_files` emits them to the UI as clickable chips.
 *
 * Content models are intentionally simple and structured (not full layout
 * engines) — they cover the common knowledge-worker deliverables. The agent
 * can always fall back to `bash` + a library for complex cases.
 */

export interface DocToolDeps {
  cwd: string;
  /** Emit a present_files event to subscribers. */
  emitFiles: (files: PresentedFile[]) => void;
}

const FORMAT_EXT: Record<string, PresentedFile["format"]> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  pdf: "pdf",
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
  txt: "txt",
};

function formatFor(name: string): PresentedFile["format"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_EXT[ext] ?? "other";
}

async function ensureOutputsDir(cwd: string): Promise<string> {
  const dir = path.join(cwd, "outputs");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function sanitizeFilename(name: string): string {
  // Strip path separators and dangerous chars; ensure an extension.
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return clean || "output";
}

async function presentFile(
  deps: DocToolDeps,
  fullPath: string,
): Promise<PresentedFile> {
  const stat = await fs.stat(fullPath);
  const rel = path.relative(deps.cwd, fullPath);
  const file: PresentedFile = {
    name: path.basename(fullPath),
    path: rel,
    format: formatFor(fullPath),
    sizeBytes: stat.size,
  };
  deps.emitFiles([file]);
  return file;
}

export function createDocTools(deps: DocToolDeps): ToolDefinition[] {
  const writeAndPresent = async (
    filename: string,
    data: Buffer | string,
  ): Promise<{ file: PresentedFile; resultText: string }> => {
    const outDir = await ensureOutputsDir(deps.cwd);
    const safe = sanitizeFilename(filename);
    const fullPath = path.join(outDir, safe);
    await fs.writeFile(fullPath, data);
    const file = await presentFile(deps, fullPath);
    return {
      file,
      resultText: `Created ${file.name} (${file.sizeBytes} bytes) at ${file.path}.`,
    };
  };

  // ---------- DOCX ----------
  const createDocx = defineTool({
    name: "create_docx",
    label: "Create Word document",
    description:
      "Create a .docx Word document from an array of blocks (paragraphs and headings) " +
      "and save it to the workspace. The file is surfaced to the user. " +
      "blocks: [{type:'heading'|'paragraph', text, level?(1-6 for headings)}].",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Output filename, e.g. 'report.docx'." },
        title: { type: "string", description: "Optional document title." },
        blocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph"] },
              text: { type: "string" },
              level: { type: "number", description: "Heading level 1-6 (headings only)." },
            },
            required: ["type", "text"],
          },
        },
      },
      required: ["filename", "blocks"],
    },
    async execute(_id, params) {
      const { filename, title, blocks } = params as {
        filename: string;
        title?: string;
        blocks: { type: "heading" | "paragraph"; text: string; level?: number }[];
      };
      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
      const children: InstanceType<typeof Paragraph>[] = [];
      if (title) {
        children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
      }
      for (const b of blocks) {
        if (b.type === "heading") {
          const levels = [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
            HeadingLevel.HEADING_4,
            HeadingLevel.HEADING_5,
            HeadingLevel.HEADING_6,
          ];
          const lvl = levels[(b.level ?? 1) - 1] ?? HeadingLevel.HEADING_1;
          children.push(new Paragraph({ text: b.text, heading: lvl }));
        } else {
          children.push(new Paragraph({ children: [new TextRun(b.text)] }));
        }
      }
      const doc = new Document({ sections: [{ children }] });
      const buf = await Packer.toBuffer(doc);
      const { resultText } = await writeAndPresent(filename, buf);
      return { content: [{ type: "text", text: resultText }], details: { blocks: blocks.length } };
    },
  });

  // ---------- XLSX ----------
  const createXlsx = defineTool({
    name: "create_xlsx",
    label: "Create Excel spreadsheet",
    description:
      "Create a .xlsx spreadsheet from one or more sheets of row data and save it. " +
      "sheets: [{name, headers: string[], rows: (string|number)[][]}]. First row is bold.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string" },
        sheets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: {} } },
            },
            required: ["name", "headers", "rows"],
          },
        },
      },
      required: ["filename", "sheets"],
    },
    async execute(_id, params) {
      const { filename, sheets } = params as {
        filename: string;
        sheets: { name: string; headers: string[]; rows: any[][] }[];
      };
      const ExcelJS = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      for (const s of sheets) {
        const ws = wb.addWorksheet(s.name || "Sheet");
        ws.addRow(s.headers);
        if (ws.getRow(1)) ws.getRow(1).font = { bold: true };
        for (const row of s.rows) ws.addRow(row);
      }
      const buf = await wb.xlsx.writeBuffer();
      const { resultText } = await writeAndPresent(filename, Buffer.from(buf));
      return {
        content: [{ type: "text", text: resultText }],
        details: { sheets: sheets.length },
      };
    },
  });

  // ---------- PPTX ----------
  const createPptx = defineTool({
    name: "create_pptx",
    label: "Create PowerPoint deck",
    description:
      "Create a .pptx deck from an array of slides and save it. " +
      "slides: [{title, bullets?: string[], notes?: string}]. Each slide has a title " +
      "and an optional bullet list.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
            },
            required: ["title"],
          },
        },
      },
      required: ["filename", "slides"],
    },
    async execute(_id, params) {
      const { filename, slides } = params as {
        filename: string;
        slides: { title: string; bullets?: string[]; notes?: string }[];
      };
      const PptxGenJS = (await import("pptxgenjs")).default;
      const pptx = new PptxGenJS();
      for (const s of slides) {
        const slide = pptx.addSlide();
        slide.addText(s.title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true });
        if (s.bullets && s.bullets.length) {
          slide.addText(
            s.bullets.map((b) => ({ text: b, options: { bullet: true } })),
            { x: 0.5, y: 1.5, w: 9, h: 4, fontSize: 18 },
          );
        }
        if (s.notes) slide.addNotes(s.notes);
      }
      const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
      const { resultText } = await writeAndPresent(filename, buf);
      return {
        content: [{ type: "text", text: resultText }],
        details: { slides: slides.length },
      };
    },
  });

  // ---------- PDF ----------
  const createPdf = defineTool({
    name: "create_pdf",
    label: "Create PDF",
    description:
      "Create a .pdf from an array of text blocks (paragraphs/headings) and save it. " +
      "blocks: [{type:'heading'|'paragraph', text, size?}]. Uses PDFKit.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string" },
        title: { type: "string" },
        blocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph"] },
              text: { type: "string" },
              size: { type: "number", description: "Font size (paragraph default 12, heading 16)." },
            },
            required: ["type", "text"],
          },
        },
      },
      required: ["filename", "blocks"],
    },
    async execute(_id, params) {
      const { filename, title, blocks } = params as {
        filename: string;
        title?: string;
        blocks: { type: "heading" | "paragraph"; text: string; size?: number }[];
      };
      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));
      if (title) {
        doc.fontSize(22).font("Helvetica-Bold").text(title, { align: "center" });
        doc.moveDown();
      }
      for (const b of blocks) {
        if (b.type === "heading") {
          doc.fontSize(b.size ?? 16).font("Helvetica-Bold").text(b.text);
        } else {
          doc.fontSize(b.size ?? 12).font("Helvetica").text(b.text, { paragraphGap: 6 });
        }
        doc.moveDown(0.3);
      }
      doc.end();
      await done;
      const buf = Buffer.concat(chunks);
      const { resultText } = await writeAndPresent(filename, buf);
      return { content: [{ type: "text", text: resultText }], details: { blocks: blocks.length } };
    },
  });

  // ---------- Markdown / Text ----------
  const createTextFile = defineTool({
    name: "create_file",
    label: "Create text/markdown/html file",
    description:
      "Create a plain-text file (.md, .html, .txt, .json, etc.) from a content string " +
      "and save it to the workspace. Use for markdown reports, HTML, config, etc.",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "e.g. 'summary.md', 'page.html'." },
        content: { type: "string" },
      },
      required: ["filename", "content"],
    },
    async execute(_id, params) {
      const { filename, content } = params as { filename: string; content: string };
      const { resultText } = await writeAndPresent(filename, content);
      return { content: [{ type: "text", text: resultText }], details: { bytes: content.length } };
    },
  });

  // ---------- present_files (surface existing workspace files) ----------
  const presentFiles = defineTool({
    name: "present_files",
    label: "Present files to user",
    description:
      "Surface one or more existing files in the workspace to the user as clickable " +
      "deliverables. Use after generating files, or to highlight existing files. " +
      "paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Workspace-relative paths to present.",
        },
      },
      required: ["paths"],
    },
    async execute(_id, params) {
      const { paths } = params as { paths: string[] };
      const files: PresentedFile[] = [];
      for (const p of paths) {
        const full = path.resolve(deps.cwd, p);
        try {
          const stat = await fs.stat(full);
          files.push({
            name: path.basename(full),
            path: path.relative(deps.cwd, full),
            format: formatFor(full),
            sizeBytes: stat.size,
          });
        } catch {
          return {
            content: [{ type: "text", text: `File not found: ${p}` }],
            details: {},
            isError: true,
          };
        }
      }
      deps.emitFiles(files);
      return {
        content: [
          { type: "text", text: `Presented ${files.length} file(s): ${files.map((f) => f.name).join(", ")}.` },
        ],
        details: { files },
      };
    },
  });

  return [createDocx, createXlsx, createPptx, createPdf, createTextFile, presentFiles];
}

export const DOC_TOOL_NAMES = [
  "create_docx",
  "create_xlsx",
  "create_pptx",
  "create_pdf",
  "create_file",
  "present_files",
];
