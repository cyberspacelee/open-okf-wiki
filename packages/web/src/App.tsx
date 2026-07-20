import { Navigate, Route, Routes } from "react-router-dom";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspaceDetailPage } from "./pages/WorkspaceDetailPage";
import { WorkspaceRunPage } from "./pages/WorkspaceRunPage";
import { WorkspaceSessionPage } from "./pages/WorkspaceSessionPage";
import { WorkspaceSettingsPage } from "./pages/WorkspaceSettingsPage";
import { WorkspaceSourcesPage } from "./pages/WorkspaceSourcesPage";
import { WorkspaceWikiPage } from "./pages/WorkspaceWikiPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/workspaces" replace />} />
      <Route path="/workspaces" element={<WorkspacesPage />} />
      <Route path="/workspaces/:id" element={<WorkspaceDetailPage />} />
      <Route path="/workspaces/:id/sources" element={<WorkspaceSourcesPage />} />
      <Route path="/workspaces/:id/session" element={<WorkspaceSessionPage />} />
      <Route path="/workspaces/:id/run" element={<WorkspaceRunPage />} />
      <Route path="/workspaces/:id/wiki/*" element={<WorkspaceWikiPage />} />
      <Route path="/workspaces/:id/wiki" element={<WorkspaceWikiPage />} />
      <Route path="/workspaces/:id/settings" element={<WorkspaceSettingsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}
