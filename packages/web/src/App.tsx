import { Navigate, Route, Routes } from "react-router-dom";
import { AgentWorkspacePage } from "./pages/AgentWorkspacePage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspaceSettingsPage } from "./pages/WorkspaceSettingsPage";
import { WorkspaceSourcesPage } from "./pages/WorkspaceSourcesPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { WorkspaceWikiPage } from "./pages/WorkspaceWikiPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/workspaces" replace />} />
      <Route path="/workspaces" element={<WorkspacesPage />} />
      {/* Agent Workspace (ADR 0032) — sole operate surface */}
      <Route path="/w/:id" element={<AgentWorkspacePage />} />
      <Route path="/workspaces/:id/sources" element={<WorkspaceSourcesPage />} />
      <Route path="/workspaces/:id/wiki/*" element={<WorkspaceWikiPage />} />
      <Route path="/workspaces/:id/wiki" element={<WorkspaceWikiPage />} />
      <Route path="/workspaces/:id/settings" element={<WorkspaceSettingsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}
