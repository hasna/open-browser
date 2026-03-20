import { useState, useEffect } from "react";

interface Agent { id: string; name: string; description?: string; last_seen: string; project_id?: string; created_at: string; }

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  const load = () => fetch("/api/agents").then(r => r.json()).then(d => setAgents(d.agents ?? [])).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const register = async () => {
    if (!name) return;
    await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description: desc }) });
    setName(""); setDesc(""); load();
  };

  const heartbeat = async (id: string) => {
    await fetch(`/api/agents/${id}/heartbeat`, { method: "PUT" });
    load();
  };

  const isStale = (lastSeen: string) => Date.now() - new Date(lastSeen).getTime() > 5 * 60 * 1000;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Agents</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "6px 10px", fontSize: 13 }} placeholder="Agent name" value={name} onChange={e => setName(e.target.value)} />
        <input style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "6px 10px", fontSize: 13, flex: 1 }} placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} />
        <button onClick={register} style={{ background: "#7c9ef8", color: "#000", border: "none", borderRadius: 4, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Register</button>
      </div>
      {agents.length === 0 && <p style={{ color: "#555" }}>No agents registered.</p>}
      {agents.map(a => (
        <div key={a.id} style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontWeight: 600, color: "#7c9ef8" }}>{a.name}</span>
              {a.description && <span style={{ marginLeft: 8, fontSize: 12, color: "#888" }}>{a.description}</span>}
              <span style={{ marginLeft: 8, fontSize: 11, color: isStale(a.last_seen) ? "#f87171" : "#4ade80" }}>● {isStale(a.last_seen) ? "stale" : "active"}</span>
            </div>
            <button onClick={() => heartbeat(a.id)} style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#aaa", padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>Heartbeat</button>
          </div>
          <div style={{ fontSize: 11, color: "#444", marginTop: 6 }}>Last seen: {a.last_seen}</div>
        </div>
      ))}
    </div>
  );
}
