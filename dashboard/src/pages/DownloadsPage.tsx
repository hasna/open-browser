import { useState, useEffect } from "react";

interface DownloadedFile {
  id: string; filename: string; type: string; size_bytes: number;
  source_url?: string; session_id?: string; created_at: string;
}

const TYPE_COLOR: Record<string, string> = {
  screenshot: "#7c9ef8", pdf: "#f87171", har: "#facc15",
  data: "#4ade80", video: "#a78bfa", file: "#888",
};

export default function DownloadsPage() {
  const [files, setFiles] = useState<DownloadedFile[]>([]);
  const [days, setDays] = useState(7);
  const [cleaning, setCleaning] = useState(false);

  const load = () => fetch("/api/downloads").then(r => r.json()).then(d => setFiles(d.downloads ?? [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const del = async (id: string) => {
    await fetch(`/api/downloads/${id}`, { method: "DELETE" });
    load();
  };

  const clean = async () => {
    setCleaning(true);
    await fetch(`/api/downloads/clean?days=${days}`, { method: "DELETE" });
    setCleaning(false);
    load();
  };

  const totalSize = files.reduce((acc, f) => acc + f.size_bytes, 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Downloads</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#666" }}>{files.length} files · {(totalSize / 1024 / 1024).toFixed(2)} MB</span>
          <input
            type="number" min={1} max={365} value={days}
            onChange={e => setDays(parseInt(e.target.value))}
            style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "4px 8px", fontSize: 12, width: 60 }}
          />
          <span style={{ fontSize: 12, color: "#666" }}>days</span>
          <button
            onClick={clean}
            disabled={cleaning}
            style={{ background: "#f87171", color: "#000", border: "none", borderRadius: 4, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          >{cleaning ? "Cleaning..." : "Clean old"}</button>
        </div>
      </div>

      {files.length === 0 && <p style={{ color: "#555" }}>No downloads yet. Screenshots, PDFs, and HARs are saved here automatically.</p>}

      {files.map(f => (
        <div key={f.id} style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: "12px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ background: TYPE_COLOR[f.type] + "22", color: TYPE_COLOR[f.type] ?? "#888", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>{f.type}</span>
              <span style={{ fontFamily: "monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{f.filename}</span>
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
              <span style={{ fontSize: 11, color: "#666" }}>{(f.size_bytes / 1024).toFixed(1)} KB</span>
              {f.source_url && <span style={{ fontSize: 11, color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, maxWidth: 300 }}>{f.source_url}</span>}
              <span style={{ fontSize: 11, color: "#444" }}>{f.created_at.split("T")[0]}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginLeft: 16 }}>
            <a
              href={`/api/downloads/${f.id}/raw`}
              target="_blank"
              rel="noreferrer"
              style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#aaa", padding: "4px 8px", fontSize: 11, textDecoration: "none" }}
            >Download</a>
            <button
              onClick={() => del(f.id)}
              style={{ background: "#f87c7c22", color: "#f87c7c", border: "1px solid #f87c7c44", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}
            >Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
