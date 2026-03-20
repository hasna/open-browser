import { useState, useEffect } from "react";

interface Recording { id: string; name: string; start_url?: string; steps: unknown[]; created_at: string; }

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[]>([]);

  const load = () => fetch("/api/recordings").then(r => r.json()).then(d => setRecordings(d.recordings ?? [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const del = async (id: string) => { await fetch(`/api/recordings/${id}`, { method: "DELETE" }); load(); };

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Recordings</h1>
      {recordings.length === 0 && <p style={{ color: "#555" }}>No recordings yet. Use CLI: browser record start &lt;name&gt;</p>}
      {recordings.map(r => (
        <div key={r.id} style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              <span style={{ marginLeft: 8, background: "#2a2a2a", color: "#888", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>{r.steps.length} steps</span>
            </div>
            <button onClick={() => del(r.id)} style={{ background: "#f87c7c22", color: "#f87c7c", border: "1px solid #f87c7c44", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>Delete</button>
          </div>
          {r.start_url && <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>{r.start_url}</div>}
          <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>{r.created_at}</div>
        </div>
      ))}
    </div>
  );
}
