import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getWorkspace, type WorkspaceConfig } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function WorkspaceDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getWorkspace(id, rootPathHint);
      setWorkspace(data.workspace);
    } catch (err) {
      setError(err);
      setWorkspace(null);
    } finally {
      setLoading(false);
    }
  }, [id, rootPathHint]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Layout>
      <div data-testid="workspace-detail" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">Workspaces</Link>
            <span aria-hidden="true"> / </span>
            <span>{workspace?.name ?? id}</span>
          </p>
          <h1>{workspace?.name ?? "Workspace"}</h1>
          <p>Overview of this local project configuration.</p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label="Loading workspace…" />
        ) : workspace ? (
          <Card>
            <CardContent className="flex flex-col gap-6">
              <dl className="kv kv-grid">
                <div>
                  <dt>Name</dt>
                  <dd>{workspace.name}</dd>
                </div>
                <div>
                  <dt>ID</dt>
                  <dd className="mono muted">{workspace.id}</dd>
                </div>
                <div>
                  <dt>Root path</dt>
                  <dd className="mono">{workspace.rootPath}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd className="mono">{workspace.model.id}</dd>
                </div>
                <div>
                  <dt>Publication path</dt>
                  <dd className="mono">{workspace.publicationPath}</dd>
                </div>
                <div>
                  <dt>Adaptive</dt>
                  <dd>
                    <Badge variant={workspace.adaptive ? "secondary" : "outline"}>
                      {workspace.adaptive ? "On" : "Off"}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt>Reviewer</dt>
                  <dd>
                    <Badge variant={workspace.reviewer ? "secondary" : "outline"}>
                      {workspace.reviewer ? "On" : "Off"}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt>Sources</dt>
                  <dd>
                    {workspace.sources.length}{" "}
                    <Link
                      to={`/workspaces/${encodeURIComponent(workspace.id)}/sources`}
                      className="inline-link"
                    >
                      Manage sources
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd className="muted">
                    {new Date(workspace.createdAt).toLocaleString()}
                  </dd>
                </div>
                {workspace.lastOpenedAt ? (
                  <div>
                    <dt>Last opened</dt>
                    <dd className="muted">
                      {new Date(workspace.lastOpenedAt).toLocaleString()}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div className="form-actions">
                <Link
                  to={`/workspaces/${encodeURIComponent(workspace.id)}/settings`}
                  className={cn(buttonVariants({ variant: "outline" }))}
                >
                  Edit settings
                </Link>
                <Link
                  to={`/workspaces/${encodeURIComponent(workspace.id)}/sources`}
                  className={cn(buttonVariants())}
                >
                  Sources
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Layout>
  );
}
