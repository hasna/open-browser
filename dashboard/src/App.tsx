import { useState } from "react";
import SessionsPage from "./pages/SessionsPage.js";
import NetworkLogPage from "./pages/NetworkLogPage.js";
import ConsolePage from "./pages/ConsolePage.js";
import ScreenshotsPage from "./pages/ScreenshotsPage.js";
import PerformancePage from "./pages/PerformancePage.js";
import RecordingsPage from "./pages/RecordingsPage.js";
import AgentsPage from "./pages/AgentsPage.js";
import ProjectsPage from "./pages/ProjectsPage.js";
import GalleryPage from "./pages/GalleryPage.js";
import DownloadsPage from "./pages/DownloadsPage.js";

const NAV = [
  { id: "sessions", label: "Sessions" },
  { id: "gallery", label: "Gallery" },
  { id: "downloads", label: "Downloads" },
  { id: "network", label: "Network" },
  { id: "console", label: "Console" },
  { id: "screenshots", label: "Screenshots" },
  { id: "performance", label: "Performance" },
  { id: "recordings", label: "Recordings" },
  { id: "agents", label: "Agents" },
  { id: "projects", label: "Projects" },
];

const S: Record<string, React.CSSProperties> = {
  app: { display: "flex", height: "100vh", overflow: "hidden" },
  sidebar: { width: 180, background: "#1a1a1a", borderRight: "1px solid #333", padding: "16px 0", flexShrink: 0 },
  logo: { padding: "0 16px 16px", borderBottom: "1px solid #333", marginBottom: 8, fontSize: 13, fontWeight: 700, color: "#7c9ef8", letterSpacing: "0.05em" },
  navItem: { display: "block", padding: "8px 16px", cursor: "pointer", fontSize: 13, color: "#aaa", background: "none", border: "none", width: "100%", textAlign: "left" as const, borderRadius: 0 },
  navActive: { color: "#fff", background: "#2a2a2a", borderLeft: "2px solid #7c9ef8", paddingLeft: 14 },
  main: { flex: 1, overflow: "auto", padding: 24 },
};

export default function App() {
  const [page, setPage] = useState("sessions");
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const pages: Record<string, React.ReactNode> = {
    sessions: <SessionsPage onSelectSession={setSelectedSession} />,
    gallery: <GalleryPage />,
    downloads: <DownloadsPage />,
    network: <NetworkLogPage sessionId={selectedSession} />,
    console: <ConsolePage sessionId={selectedSession} />,
    screenshots: <ScreenshotsPage sessionId={selectedSession} />,
    performance: <PerformancePage sessionId={selectedSession} />,
    recordings: <RecordingsPage />,
    agents: <AgentsPage />,
    projects: <ProjectsPage />,
  };

  return (
    <div style={S.app}>
      <div style={S.sidebar}>
        <div style={S.logo}>@hasna/browser</div>
        {NAV.map((n) => (
          <button
            key={n.id}
            style={{ ...S.navItem, ...(page === n.id ? S.navActive : {}) }}
            onClick={() => setPage(n.id)}
          >
            {n.label}
          </button>
        ))}
        {selectedSession && (
          <div style={{ padding: "12px 16px", marginTop: 16, borderTop: "1px solid #333", fontSize: 11, color: "#666" }}>
            Session:<br />
            <span style={{ color: "#7c9ef8", fontFamily: "monospace" }}>{selectedSession.slice(0, 8)}...</span>
          </div>
        )}
      </div>
      <div style={S.main}>{pages[page]}</div>
    </div>
  );
}
