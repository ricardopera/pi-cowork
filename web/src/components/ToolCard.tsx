import { useState } from "react";
import type { ToolRecord } from "./types";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function ToolCard({ tool }: { tool: ToolRecord }) {
  const [open, setOpen] = useState(false);
  const resultText =
    tool.result == null
      ? ""
      : typeof tool.result === "string"
        ? tool.result
        : JSON.stringify(tool.result, null, 2);
  return (
    <div className={`toolcard ${tool.isError ? "err" : ""}`}>
      <button className="toolhead" onClick={() => setOpen(!open)}>
        <span className={`dot ${tool.status}`} /> {tool.toolName}
        {tool.status === "running" && <span className="runhint">running…</span>}
        {tool.result != null && (
          <span className="reshint">{truncate(resultText.replace(/\s+/g, " "), 60)}</span>
        )}
      </button>
      {open && (
        <div className="toolbody">
          <div className="label">args</div>
          <pre className="args">{JSON.stringify(tool.args, null, 2)}</pre>
          {tool.result != null && (
            <>
              <div className="label">result</div>
              <pre className={`result ${tool.isError ? "err" : ""}`}>{resultText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
