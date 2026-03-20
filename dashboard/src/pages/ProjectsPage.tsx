import { useState, useEffect } from "react";

interface Project { id: string; name: string; path: string; description?: string; created_at: string; }

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [desc, setDesc] = useState("");

  const load = () => fetch("/api/projects").then(r => r.json()).then(d => setProjects(d.projects ?? [])).catch(() => {});
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name || !path) return;
    await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, path, description: desc }) });
    setName(""); setPath(""); setDesc(""); load();
  };

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Projects</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" as const }}>
        <input style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "6px 10px", fontSize: 13 }} placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
        <input style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "6px 10px", fontSize: 13, flex: 1 }} placeholder="Path (e.g. /Users/you/myapp)" value={path} onChange={e => setPath(e.target.value)} />
        <input style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "6px 10px", fontSize: 13, flex: 1 }} placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} />
        <button onClick={create} style={{ background: "#7c9ef8", color: "#000", border: "none", borderRadius: 4, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Create</button>
      </div>
      {projects.length === 0 && <p style={{ color: "#555" }}>No projects yet.</p>}
      {projects.map(p => (
        <div key={p.id} style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ fontWeight: 600, color: "#7c9ef8" }}>{p.name}</div>
          {p.description && <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{p.description}</div>}
          <div style={{ fontSize: 12, color: "#555", marginTop: 4, fontFamily: "monospace" }}>{p.path}</div>
          <div style={{ fontSize: 11, color: "#444", marginTop: 4 }}>{p.created_at}</div>
        </div>
      ))}
    </div>
  );
}
