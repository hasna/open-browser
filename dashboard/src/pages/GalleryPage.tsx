import { useState, useEffect, useRef } from "react";

interface GalleryEntry {
  id: string; url?: string; title?: string; path: string; thumbnail_path?: string;
  format?: string; width?: number; height?: number;
  original_size_bytes?: number; compressed_size_bytes?: number; compression_ratio?: number;
  tags: string[]; notes?: string; is_favorite: boolean; created_at: string;
}
interface Stats { total: number; total_size_bytes: number; favorites: number; by_format: Record<string, number>; }

const S: Record<string, React.CSSProperties> = {
  h1: { fontSize: 20, fontWeight: 700, marginBottom: 16 },
  toolbar: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" as const, alignItems: "center" },
  input: { background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#e0e0e0", padding: "6px 10px", fontSize: 12 },
  btn: { background: "#7c9ef8", color: "#000", border: "none", borderRadius: 4, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  btnSm: { background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#aaa", padding: "4px 8px", cursor: "pointer", fontSize: 11 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 },
  card: { background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, overflow: "hidden", cursor: "pointer", transition: "border-color .2s" },
  cardSel: { borderColor: "#7c9ef8" },
  thumb: { width: "100%", height: 140, objectFit: "cover" as const, background: "#111", display: "block" },
  cardBody: { padding: 10 },
  badge: { display: "inline-block", background: "#2a2a2a", color: "#7c9ef8", borderRadius: 3, padding: "1px 6px", fontSize: 10, marginRight: 4 },
  modal: { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modalImg: { maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8, border: "1px solid #444" },
  stats: { display: "flex", gap: 16, marginBottom: 16, padding: "10px 16px", background: "#1a1a1a", borderRadius: 8 },
  statItem: { textAlign: "center" as const },
  statVal: { fontSize: 22, fontWeight: 700, color: "#7c9ef8" },
  statLbl: { fontSize: 11, color: "#666" },
};

export default function GalleryPage() {
  const [entries, setEntries] = useState<GalleryEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fullscreen, setFullscreen] = useState<GalleryEntry | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [diffResult, setDiffResult] = useState<string | null>(null);

  const loadEntries = () => {
    const params = new URLSearchParams();
    if (tag) params.set("tag", tag);
    if (favOnly) params.set("is_favorite", "true");
    params.set("limit", "100");
    fetch(`/api/gallery?${params}`).then(r => r.json()).then(d => setEntries(d.entries ?? [])).catch(() => {});
    fetch("/api/gallery/stats").then(r => r.json()).then(d => setStats(d)).catch(() => {});
  };

  useEffect(() => { loadEntries(); }, [tag, favOnly]);

  const filtered = search
    ? entries.filter(e => (e.url + e.title + e.tags.join(" ")).toLowerCase().includes(search.toLowerCase()))
    : entries;

  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const favorite = async (id: string, val: boolean) => {
    await fetch(`/api/gallery/${id}/favorite`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorited: val }) });
    loadEntries();
  };

  const addTag = async (id: string) => {
    if (!tagInput) return;
    await fetch(`/api/gallery/${id}/tag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: tagInput }) });
    setTagInput(""); loadEntries();
  };

  const diffSelected = async () => {
    const [id1, id2] = Array.from(selected);
    const res = await fetch("/api/gallery/diff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id1, id2 }) });
    const d = await res.json();
    setDiffResult(d.diff_base64 ? `data:image/webp;base64,${d.diff_base64}` : null);
  };

  const del = async (id: string) => {
    await fetch(`/api/gallery/${id}`, { method: "DELETE" });
    setSelected(new Set()); loadEntries();
  };

  return (
    <div>
      <h1 style={S.h1}>Gallery</h1>

      {stats && (
        <div style={S.stats}>
          <div style={S.statItem}><div style={S.statVal}>{stats.total}</div><div style={S.statLbl}>Total</div></div>
          <div style={S.statItem}><div style={S.statVal}>{stats.favorites}</div><div style={S.statLbl}>Favorites</div></div>
          <div style={S.statItem}><div style={S.statVal}>{(stats.total_size_bytes / 1024 / 1024).toFixed(1)}MB</div><div style={S.statLbl}>Size</div></div>
          <div style={S.statItem}><div style={{ fontSize: 12, color: "#aaa" }}>{Object.entries(stats.by_format).map(([f, c]) => `${f}:${c}`).join(" · ")}</div><div style={S.statLbl}>Formats</div></div>
        </div>
      )}

      <div style={S.toolbar}>
        <input style={S.input} placeholder="Search url/title/tags..." value={search} onChange={e => setSearch(e.target.value)} />
        <input style={{ ...S.input, width: 100 }} placeholder="Tag filter" value={tag} onChange={e => setTag(e.target.value)} />
        <button style={{ ...S.btnSm, color: favOnly ? "#facc15" : "#aaa" }} onClick={() => setFavOnly(!favOnly)}>★ Favorites</button>
        {selected.size === 2 && <button style={S.btn} onClick={diffSelected}>Diff selected</button>}
        {selected.size > 0 && <button style={{ ...S.btnSm, color: "#f87171" }} onClick={() => { selected.forEach(id => del(id)); }}>Delete selected</button>}
        {selected.size > 0 && <button style={S.btnSm} onClick={() => setSelected(new Set())}>Clear</button>}
      </div>

      {diffResult && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>Diff result (red = changed):</div>
          <img src={diffResult} alt="diff" style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid #444" }} />
          <button style={{ ...S.btnSm, marginTop: 8 }} onClick={() => setDiffResult(null)}>Close diff</button>
        </div>
      )}

      {filtered.length === 0 && <p style={{ color: "#555" }}>No gallery entries yet. Take a screenshot with browser_screenshot.</p>}

      <div style={S.grid}>
        {filtered.map(e => (
          <div key={e.id} style={{ ...S.card, ...(selected.has(e.id) ? S.cardSel : {}) }} onClick={() => toggleSelect(e.id)}>
            <div style={{ position: "relative" as const }}>
              {e.thumbnail_path
                ? <img src={`/api/gallery/${e.id}/thumbnail`} style={S.thumb} alt={e.title} onError={(ev) => { (ev.target as HTMLImageElement).style.display = "none"; }} />
                : <div style={{ ...S.thumb, background: "#111", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" }}>No thumb</div>
              }
              <button
                onClick={(ev) => { ev.stopPropagation(); favorite(e.id, !e.is_favorite); }}
                style={{ position: "absolute" as const, top: 6, right: 6, background: "rgba(0,0,0,.6)", border: "none", cursor: "pointer", fontSize: 16, color: e.is_favorite ? "#facc15" : "#666", borderRadius: 4, padding: "2px 6px" }}
              >★</button>
            </div>
            <div style={S.cardBody}>
              <div style={{ fontSize: 11, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, marginBottom: 4 }}>
                {e.url?.replace(/^https?:\/\//, "").slice(0, 40) ?? "—"}
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const, marginBottom: 4 }}>
                {e.format && <span style={S.badge}>{e.format}</span>}
                {e.compression_ratio != null && <span style={{ ...S.badge, color: "#4ade80" }}>{(e.compression_ratio * 100).toFixed(0)}%</span>}
                {e.tags.map(t => <span key={t} style={{ ...S.badge, color: "#facc15" }}>{t}</span>)}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  style={{ ...S.input, flex: 1, padding: "3px 6px", fontSize: 11 }}
                  placeholder="Add tag..."
                  value={fullscreen?.id === e.id ? tagInput : ""}
                  onClick={(ev) => { ev.stopPropagation(); setFullscreen(e); }}
                  onChange={ev => setTagInput(ev.target.value)}
                  onKeyDown={async (ev) => { if (ev.key === "Enter") { ev.stopPropagation(); await addTag(e.id); } }}
                />
                <button style={{ ...S.btnSm, fontSize: 10 }} onClick={(ev) => { ev.stopPropagation(); setFullscreen(e); }}>View</button>
              </div>
              <div style={{ fontSize: 10, color: "#444", marginTop: 4 }}>{e.created_at.split(" ")[0]}</div>
            </div>
          </div>
        ))}
      </div>

      {fullscreen && (
        <div style={S.modal} onClick={() => setFullscreen(null)}>
          <img src={`/api/gallery/${fullscreen.id}/image`} style={S.modalImg} alt={fullscreen.title} onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
