import { useState, useEffect } from "react";

const S: Record<string, React.CSSProperties> = {
  h1: { fontSize: 20, fontWeight: 700, marginBottom: 16 },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 },
  th: { textAlign: "left" as const, padding: "8px 10px", background: "#1a1a1a", color: "#888", borderBottom: "1px solid #333" },
  td: { padding: "6px 10px", borderBottom: "1px solid #222", fontFamily: "monospace" },
};

interface Request { id: string; method: string; url: string; status_code?: number; duration_ms?: number; resource_type?: string; timestamp: string; }

export default function NetworkLogPage({ sessionId }: { sessionId: string | null }) {
  const [requests, setRequests] = useState<Request[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    const load = () => fetch(`/api/network-log/${sessionId}`).then(r => r.json()).then(d => setRequests(d.requests ?? [])).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [sessionId]);

  if (!sessionId) return <div style={{ color: "#555" }}>Select a session from Sessions tab.</div>;

  const statusColor = (s?: number) => !s ? "#888" : s < 300 ? "#4ade80" : s < 400 ? "#facc15" : "#f87171";

  return (
    <div>
      <h1 style={S.h1}>Network Log</h1>
      {requests.length === 0 && <p style={{ color: "#555" }}>No requests captured yet. Navigate to a page.</p>}
      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>Method</th><th style={S.th}>Status</th><th style={S.th}>URL</th>
          <th style={S.th}>Type</th><th style={S.th}>Duration</th>
        </tr></thead>
        <tbody>
          {requests.map(r => (
            <tr key={r.id}>
              <td style={{ ...S.td, color: "#7c9ef8" }}>{r.method}</td>
              <td style={{ ...S.td, color: statusColor(r.status_code) }}>{r.status_code ?? "—"}</td>
              <td style={{ ...S.td, color: "#ddd", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.url}</td>
              <td style={{ ...S.td, color: "#888" }}>{r.resource_type ?? "—"}</td>
              <td style={{ ...S.td, color: "#aaa" }}>{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
