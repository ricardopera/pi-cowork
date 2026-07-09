import type { PresentedFile } from "../lib/events";

const FORMAT_ICON: Record<PresentedFile["format"], string> = {
  docx: "📄",
  xlsx: "📊",
  pptx: "📑",
  pdf: "📕",
  md: "📝",
  html: "🌐",
  txt: "📃",
  other: "📎",
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileChips({ files }: { files: PresentedFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="filechips">
      <div className="filechips-label">Deliverables</div>
      <div className="filechips-list">
        {files.map((f) => (
          <a
            key={f.path}
            className="filechip"
            href={`/api/files/${encodeURI(f.path)}`}
            download={f.name}
            title={`Download ${f.name} (${humanSize(f.sizeBytes)})`}
          >
            <span className="filechip-icon">{FORMAT_ICON[f.format]}</span>
            <span className="filechip-name">{f.name}</span>
            <span className="filechip-size">{humanSize(f.sizeBytes)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
