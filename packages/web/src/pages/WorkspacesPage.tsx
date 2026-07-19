import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createWorkspace,
  getProvider,
  listWorkspaces,
  type ModelProfilePublic,
  type WorkspaceSummary,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function WorkspacesPage() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [modelProfileId, setModelProfileId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wsData, providerData] = await Promise.all([
        listWorkspaces(),
        getProvider().catch(() => null),
      ]);
      setWorkspaces(wsData.workspaces);
      const catalog = providerData?.provider;
      const catalogModels = catalog?.models ?? [];
      setModels(catalogModels);
      setDefaultModelProfileId(catalog?.defaultModelProfileId);
      // Prefer default, else first model.
      const preferred =
        catalog?.defaultModelProfileId &&
        catalogModels.some((m) => m.id === catalog.defaultModelProfileId)
          ? catalog.defaultModelProfileId
          : catalogModels[0]?.id ?? "";
      setModelProfileId((prev) => prev || preferred);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { workspace } = await createWorkspace({
        name: name.trim(),
        rootPath: rootPath.trim(),
        ...(modelProfileId ? { modelProfileId } : {}),
      });
      setName("");
      setRootPath("");
      setShowForm(false);
      navigate(`/workspaces/${encodeURIComponent(workspace.id)}`);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout>
      <div data-testid="workspaces-page" className="flex flex-col gap-5">
        <header className="page-header row-between">
          <div>
            <h1>Workspaces</h1>
            <p>
              A Workspace is a local project: Git sources, selected model, and wiki output path.
              Models and credentials are managed in{" "}
              <Link to="/settings">Settings</Link>.
            </p>
          </div>
          <Button
            type="button"
            variant={showForm ? "outline" : "default"}
            onClick={() => {
              setShowForm((open) => !open);
              setError(null);
            }}
          >
            {showForm ? "Cancel" : "Create"}
          </Button>
        </header>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {showForm ? (
          <Card data-testid="workspace-create-form">
            <CardHeader>
              <CardTitle>Create workspace</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="form" onSubmit={(e) => void handleCreate(e)}>
                <div className="field">
                  <Label htmlFor="workspace-name">Name</Label>
                  <Input
                    id="workspace-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My project"
                    required
                    maxLength={120}
                    autoFocus
                    data-testid="workspace-name-input"
                  />
                </div>
                <div className="field">
                  <Label htmlFor="workspace-root">Root path (absolute)</Label>
                  <Input
                    id="workspace-root"
                    type="text"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    placeholder="D:/src/app"
                    required
                    className="font-mono"
                    data-testid="workspace-root-input"
                  />
                  <span className="field-hint">
                    Absolute path on this machine. The server creates the directory and{" "}
                    <code>.okf-wiki/</code> if needed.
                  </span>
                </div>
                <ModelSelect
                  models={models}
                  value={modelProfileId}
                  onChange={setModelProfileId}
                  defaultModelProfileId={defaultModelProfileId}
                  required={models.length > 0}
                  allowEmpty={models.length === 0}
                />
                <div className="form-actions">
                  <Button
                    type="submit"
                    disabled={
                      submitting ||
                      !name.trim() ||
                      !rootPath.trim() ||
                      (models.length > 0 && !modelProfileId)
                    }
                    data-testid="workspace-create-submit"
                  >
                    {submitting ? "Creating…" : "Create workspace"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : null}

        {loading ? (
          <LoadingState label="Loading workspaces…" />
        ) : workspaces.length === 0 ? (
          <Card data-testid="workspaces-empty">
            <CardContent className="pt-0">
              <Empty className="border-0 p-6">
                <EmptyHeader>
                  <EmptyTitle className="text-base">No workspaces yet</EmptyTitle>
                  <EmptyDescription>
                    Create a workspace with an absolute root path (for example{" "}
                    <code className="mono">D:/src/app</code>). Then add local Git checkouts as sources.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <ul className="checklist text-left">
                    <li>
                      Configure models in <Link to="/settings">Settings</Link>
                    </li>
                    <li>Add local Git checkout paths (no clone / no credentials)</li>
                    <li>Run Wiki generation with HITL publish</li>
                  </ul>
                  {!showForm ? (
                    <Button type="button" onClick={() => setShowForm(true)}>
                      Create workspace
                    </Button>
                  ) : null}
                </EmptyContent>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <Card className="py-0" data-testid="workspace-list">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Root path</TableHead>
                    <TableHead>Sources</TableHead>
                    <TableHead>Last opened</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workspaces.map((ws) => {
                    const params = new URLSearchParams({ rootPath: ws.rootPath });
                    const href = `/workspaces/${encodeURIComponent(ws.id)}?${params.toString()}`;
                    return (
                      <TableRow
                        key={ws.id}
                        className="cursor-pointer"
                        tabIndex={0}
                        role="link"
                        data-testid="workspace-row"
                        data-workspace-id={ws.id}
                        onClick={() => navigate(href)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            navigate(href);
                          }
                        }}
                      >
                        <TableCell>
                          <Link
                            to={href}
                            className="row-link"
                            data-workspace-id={ws.id}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {ws.name}
                          </Link>
                        </TableCell>
                        <TableCell className="mono muted whitespace-normal">{ws.rootPath}</TableCell>
                        <TableCell>{ws.sourceCount}</TableCell>
                        <TableCell className="muted">
                          {ws.lastOpenedAt
                            ? new Date(ws.lastOpenedAt).toLocaleString()
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
