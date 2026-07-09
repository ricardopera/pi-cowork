import { useState } from "react";

export interface Artifact {
  artifactId: string;
  title: string;
}

export function ArtifactPanel({ artifacts }: { artifacts: Artifact[] }) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(true);
  if (artifacts.length === 0) return null;
  const current = artifacts[Math.min(active, artifacts.length - 1)];
  return (
    <div className={`artifactpanel${open ? "" : " collapsed"}`}>
      <div className="artifact-head">
        <span className="artifact-title">◆ {current.title}</span>
        <div className="artifact-tabs">
          {artifacts.length > 1 &&
            artifacts.map((a, i) => (
              <button
                key={a.artifactId}
                className={i === active ? "active" : ""}
                onClick={() => {
                  setActive(i);
                  setOpen(true);
                }}
                title={a.title}
              >
                {i + 1}
              </button>
            ))}
          <button className="ghost" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {open && (
        <iframe
          className="artifact-frame"
          // sandbox allows scripts but blocks same-origin access to the app.
          sandbox="allow-scripts"
          src={`/api/artifacts/${current.artifactId}`}
          title={current.title}
        />
      )}
    </div>
  );
}
