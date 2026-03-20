import { useState, useEffect } from "react";

const API = "/api";
const S: Record<string, React.CSSProperties> = {
  h1: { fontSize: 20, fontWeight: 700, marginBottom: 16 },
  card: { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 12, cursor: "pointer" },
  badge: { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, marginLeft: 8 },
  form: { display: "flex", gap: 8, marginBottom: 16 },
  input: { background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "6px 10px", fontSize: 13 },
  btn: { background: "#7c9ef8", color: "#000", border: "none", borderRadius: 4, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  btnDanger: { background: "#f87c7c", color: "#000", border: "none", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 12 },
};

interface Session { id: string; engine: string; status: string; start_url?: string; created_at: string; }

export default function SessionsPage({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [engine, setEngine] = useState("auto");
  const [url, setUrl] = useState("");

  const load = () => fetch(`${API}/sessions`).then(r => r.json()).then(d => setSessions(d.sessions ?? [])).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);

  const create = async () => {
    await fetch(`${API}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine, start_url: url || undefined }) });
    load();
  };

  const close = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`${API}/sessions/${id}`, { method: "DELETE" });
    load();
  };

  const statusColor: Record<string, string> = { active: "#4ade80", closed: "#6b7280", error: "#f87171" };

  return (
    <div>
      <h1 style={S.h1}>Sessions</h1>
      <div style={S.form}>
        <select style={S.input} value={engine} onChange={e => setEngine(e.target.value)}>
          {["auto", "playwright", "cdp", "lightpanda"].map(e => <option key={e}>{e}</option>)}
        </select>
        <input style={{ ...S.input, flex: 1 }} placeholder="Start URL (optional)" value={url} onChange={e => setUrl(e.target.value)} />
        <button style={S.btn} onClick={create}>+ New Session</button>
      </div>
      {sessions.length === 0 && <p style={{ color: "#555" }}>No sessions. Create one above.</p>}
      {sessions.map(s => (
        <div key={s.id} style={S.card} onClick={() => onSelectSession(s.id)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontFamily: "monospace", fontSize: 13 }}>{s.id.slice(0, 8)}...</span>
              <span style={{ ...S.badge, background: statusColor[s.status] + "33", color: statusColor[s.status] }}>{s.status}</span>
              <span style={{ ...S.badge, background: "#2a2a2a", color: "#aaa" }}>{s.engine}</span>
            </div>
            {s.status === "active" && <button style={S.btnDanger} onClick={e => close(s.id, e)}>Close</button>}
          </div>
          {s.start_url && <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>{s.start_url}</div>}
          <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>{s.created_at}</div>
        </div>
      ))}
    </div>
  );
}
