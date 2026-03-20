import { useState, useEffect } from "react";

interface Metrics { fcp?: number; lcp?: number; cls?: number; ttfb?: number; dom_interactive?: number; dom_complete?: number; load_event?: number; js_heap_size_used?: number; js_heap_size_total?: number; }

const METRICS: Array<{ key: keyof Metrics; label: string; unit: string; good: number; bad: number }> = [
  { key: "fcp", label: "First Contentful Paint", unit: "ms", good: 1800, bad: 3000 },
  { key: "ttfb", label: "Time to First Byte", unit: "ms", good: 200, bad: 500 },
  { key: "dom_interactive", label: "DOM Interactive", unit: "ms", good: 2000, bad: 5000 },
  { key: "dom_complete", label: "DOM Complete", unit: "ms", good: 3000, bad: 8000 },
  { key: "load_event", label: "Load Event", unit: "ms", good: 3000, bad: 8000 },
];

function scoreColor(val: number, good: number, bad: number) {
  if (val <= good) return "#4ade80";
  if (val <= bad) return "#facc15";
  return "#f87171";
}

export default function PerformancePage({ sessionId }: { sessionId: string | null }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const load = () => {
    if (!sessionId) return;
    fetch(`/api/performance/${sessionId}`).then(r => r.json()).then(d => setMetrics(d.metrics ?? null)).catch(() => {});
  };

  useEffect(() => { load(); }, [sessionId]);

  if (!sessionId) return <div style={{ color: "#555" }}>Select a session from Sessions tab.</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Performance</h1>
        <button onClick={load} style={{ background: "#2a2a2a", border: "1px solid #444", borderRadius: 4, color: "#aaa", padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>Refresh</button>
      </div>
      {!metrics && <p style={{ color: "#555" }}>Navigate to a page to see metrics.</p>}
      {metrics && METRICS.map(m => {
        const val = metrics[m.key];
        if (val == null) return null;
        return (
          <div key={m.key} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #222" }}>
            <span style={{ color: "#aaa", fontSize: 14 }}>{m.label}</span>
            <span style={{ color: scoreColor(val, m.good, m.bad), fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>{val.toFixed(0)}{m.unit}</span>
          </div>
        );
      })}
      {metrics?.js_heap_size_used != null && (
        <div style={{ marginTop: 16, padding: 12, background: "#1a1a1a", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>JS Heap</div>
          <div style={{ color: "#facc15", fontFamily: "monospace" }}>
            {((metrics.js_heap_size_used ?? 0) / 1024 / 1024).toFixed(1)} MB used / {((metrics.js_heap_size_total ?? 0) / 1024 / 1024).toFixed(1)} MB total
          </div>
        </div>
      )}
    </div>
  );
}
