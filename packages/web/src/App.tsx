import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AgentWorkspacePage } from "./pages/AgentWorkspacePage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspaceRunPage } from "./pages/WorkspaceRunPage";
import { WorkspaceSettingsPage } from "./pages/WorkspaceSettingsPage";
import { WorkspaceSourcesPage } from "./pages/WorkspaceSourcesPage";
import { WorkspaceWikiPage } from "./pages/WorkspaceWikiPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";

/** Redirect legacy `/workspaces/:id` and `/session` paths → `/w/:id` (preserve query). */
function LegacyWorkspaceRedirect() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();
  return (
    <Navigate
      to={`/w/${encodeURIComponent(id)}${location.search}`}
      replace
    />
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/workspaces" replace />} />
      <Route path="/workspaces" element={<WorkspacesPage />} />
      {/* Agent Workspace (ADR 0030) — primary operate surface */}
      <Route path="/w/:id" element={<AgentWorkspacePage />} />
      {/* Legacy workspace home / session → Agent Workspace */}
      <Route path="/workspaces/:id" element={<LegacyWorkspaceRedirect />} />
      <Route path="/workspaces/:id/session" element={<LegacyWorkspaceRedirect />} />
      <Route path="/workspaces/:id/sources" element={<WorkspaceSourcesPage />} />
      <Route path="/workspaces/:id/run" element={<WorkspaceRunPage />} />
      <Route path="/workspaces/:id/wiki/*" element={<WorkspaceWikiPage />} />
      <Route path="/workspaces/:id/wiki" element={<WorkspaceWikiPage />} />
      <Route path="/workspaces/:id/settings" element={<WorkspaceSettingsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}
