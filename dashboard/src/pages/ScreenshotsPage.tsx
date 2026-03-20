import { useState, useEffect } from "react";

interface Snapshot { id: string; url: string; title?: string; screenshot_path?: string; timestamp: string; }

export default function ScreenshotsPage({ sessionId }: { sessionId: string | null }) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/screenshots/${sessionId}`).then(r => r.json()).then(d => setSnapshots(d.snapshots ?? [])).catch(() => {});
  }, [sessionId]);

  if (!sessionId) return <div style={{ color: "#555" }}>Select a session from Sessions tab.</div>;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Screenshots</h1>
      {snapshots.length === 0 && <p style={{ color: "#555" }}>No screenshots taken yet.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {snapshots.filter(s => s.screenshot_path).map(s => (
          <div key={s.id} style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, overflow: "hidden" }}>
            <img src={`file://${s.screenshot_path}`} alt={s.title} style={{ width: "100%", display: "block" }} />
            <div style={{ padding: 10 }}>
              <div style={{ fontSize: 12, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{s.url}</div>
              <div style={{ fontSize: 11, color: "#555", marginTop: 4 }}>{s.timestamp}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
