import { useState, useEffect } from "react";

interface ConsoleMsg { id: string; level: string; message: string; source?: string; line_number?: number; timestamp: string; }

const levelColor: Record<string, string> = { log: "#ddd", warn: "#facc15", error: "#f87171", debug: "#888", info: "#7c9ef8" };

export default function ConsolePage({ sessionId }: { sessionId: string | null }) {
  const [messages, setMessages] = useState<ConsoleMsg[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!sessionId) return;
    const load = () => fetch(`/api/console-log/${sessionId}`).then(r => r.json()).then(d => setMessages(d.messages ?? [])).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [sessionId]);

  if (!sessionId) return <div style={{ color: "#555" }}>Select a session from Sessions tab.</div>;

  const filtered = filter ? messages.filter(m => m.level === filter) : messages;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Console</h1>
        <select style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "4px 8px", fontSize: 12 }} value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="">All levels</option>
          {["log", "warn", "error", "debug", "info"].map(l => <option key={l}>{l}</option>)}
        </select>
      </div>
      {filtered.length === 0 && <p style={{ color: "#555" }}>No console messages captured yet.</p>}
      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        {filtered.map(m => (
          <div key={m.id} style={{ padding: "4px 0", borderBottom: "1px solid #1a1a1a", color: levelColor[m.level] ?? "#ddd" }}>
            <span style={{ color: "#555", marginRight: 8 }}>[{m.level.toUpperCase()}]</span>
            {m.message}
            {m.source && <span style={{ color: "#444", marginLeft: 8 }}> {m.source}:{m.line_number}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
