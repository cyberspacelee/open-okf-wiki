import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  addSource,
  cloneSource,
  deleteSource,
  getWorkspace,
  probeSources,
  type GitProbe,
  type SourceProbeResult,
  type WorkspaceConfig,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { workspaceHref } from "../lib/workspace-path";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function probeLabel(probe: GitProbe | undefined): string {
  if (!probe) {
    return "—";
  }
  if (!probe.isGit) {
    return probe.error ? `Not git: ${probe.error}` : "Not a git checkout";
  }
  const parts = [
    probe.branch ?? "detached",
    probe.head ? probe.head.slice(0, 8) : null,
    probe.dirty ? "dirty" : "clean",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function WorkspaceSourcesPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [path, setPath] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [cloneId, setCloneId] = useState("");
  const [cloneRef, setCloneRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [probing, setProbing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, GitProbe>>({});

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

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!id || !path.trim()) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await addSource(
        id,
        {
          path: path.trim(),
          id: sourceId.trim() || undefined,
        },
        workspace?.rootPath ?? rootPathHint,
      );
      setWorkspace(result.workspace);
      setProbes((prev) => ({ ...prev, [result.source.id]: result.probe }));
      setPath("");
      setSourceId("");
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleClone(event: FormEvent) {
    event.preventDefault();
    if (!id || !remoteUrl.trim()) {
      return;
    }
    setCloning(true);
    setError(null);
    try {
      const result = await cloneSource(
        id,
        {
          remoteUrl: remoteUrl.trim(),
          id: cloneId.trim() || undefined,
          ref: cloneRef.trim() || undefined,
        },
        workspace?.rootPath ?? rootPathHint,
      );
      setWorkspace(result.workspace);
      setProbes((prev) => ({ ...prev, [result.source.id]: result.probe }));
      setRemoteUrl("");
      setCloneId("");
      setCloneRef("");
    } catch (err) {
      setError(err);
    } finally {
      setCloning(false);
    }
  }

  async function handleDelete(sourceIdToDelete: string) {
    if (!id) {
      return;
    }
    setDeletingId(sourceIdToDelete);
    setError(null);
    try {
      const result = await deleteSource(
        id,
        sourceIdToDelete,
        workspace?.rootPath ?? rootPathHint,
      );
      setWorkspace(result.workspace);
      setProbes((prev) => {
        const next = { ...prev };
        delete next[sourceIdToDelete];
        return next;
      });
    } catch (err) {
      setError(err);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleProbeAll() {
    if (!id) {
      return;
    }
    setProbing(true);
    setError(null);
    try {
      const result = await probeSources(id, workspace?.rootPath ?? rootPathHint);
      const map: Record<string, GitProbe> = {};
      for (const item of result.probes as SourceProbeResult[]) {
        map[item.sourceId] = item.probe;
      }
      setProbes(map);
    } catch (err) {
      setError(err);
    } finally {
      setProbing(false);
    }
  }

  return (
    <Layout>
      <div data-testid="sources-page" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">Workspaces</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Sources</span>
          </p>
          <h1>Sources</h1>
          <p>
            Link an existing local Git checkout (absolute path, may be outside the workspace root)
            or clone a remote into this workspace under{" "}
            <code className="mono">sources/&lt;id&gt;</code>. Clone uses host git credentials; tokens
            are never stored in workspace config.
          </p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label="Loading sources…" />
        ) : workspace ? (
          <>
            <Card>
              <CardHeader className="row-between items-center">
                <CardTitle>Registered sources</CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleProbeAll()}
                  disabled={probing || workspace.sources.length === 0}
                  data-testid="source-probe-all"
                >
                  {probing ? "Probing…" : "Probe all"}
                </Button>
              </CardHeader>
              <CardContent>
                {workspace.sources.length === 0 ? (
                  <div className="empty-inline">
                    <p className="muted">
                      No sources yet. Add an absolute path to an existing local Git checkout.
                    </p>
                  </div>
                ) : (
                  <Table data-testid="source-list">
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>Origin</TableHead>
                        <TableHead>Path</TableHead>
                        <TableHead>Probe</TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspace.sources.map((source) => (
                        <TableRow key={source.id} data-source-id={source.id}>
                          <TableCell className="mono">{source.id}</TableCell>
                          <TableCell className="muted small">
                            {source.origin?.type === "clone"
                              ? `clone · ${source.origin.remoteUrl}`
                              : "path"}
                          </TableCell>
                          <TableCell className="mono whitespace-normal">{source.path}</TableCell>
                          <TableCell className="muted small whitespace-normal">
                            {probeLabel(probes[source.id])}
                          </TableCell>
                          <TableCell className="actions-cell">
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={deletingId === source.id}
                              onClick={() => void handleDelete(source.id)}
                            >
                              {deletingId === source.id ? "Removing…" : "Delete"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Link existing path</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="form" onSubmit={(e) => void handleAdd(e)}>
                  <div className="field">
                    <Label htmlFor="source-path">Path (absolute)</Label>
                    <Input
                      id="source-path"
                      type="text"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="D:/src/repo"
                      required
                      className="font-mono"
                      data-testid="source-path-input"
                    />
                  </div>
                  <div className="field">
                    <Label htmlFor="source-id">
                      Source id <span className="muted font-normal">(optional slug)</span>
                    </Label>
                    <Input
                      id="source-id"
                      type="text"
                      value={sourceId}
                      onChange={(e) => setSourceId(e.target.value)}
                      placeholder="app"
                      pattern="[a-z][a-z0-9-]{0,62}"
                      className="font-mono"
                      data-testid="source-id-input"
                    />
                    <span className="field-hint">
                      Lowercase slug. Leave blank to derive from the path.
                    </span>
                  </div>
                  <div className="form-actions">
                    <Button
                      type="submit"
                      disabled={submitting || !path.trim()}
                      data-testid="source-add-submit"
                    >
                      {submitting ? "Adding…" : "Add source"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Clone into workspace</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="muted small mb-4">
                  Clones into{" "}
                  <code className="mono">
                    {workspace.rootPath}/sources/&lt;id&gt;
                  </code>{" "}
                  using the host <code className="mono">git</code> binary. Auth uses your local
                  credential helper or SSH agent.
                </p>
                <form className="form" onSubmit={(e) => void handleClone(e)}>
                  <div className="field">
                    <Label htmlFor="source-remote">Remote URL</Label>
                    <Input
                      id="source-remote"
                      type="text"
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                      placeholder="https://github.com/org/repo.git"
                      required
                      className="font-mono"
                      data-testid="source-remote-input"
                    />
                  </div>
                  <div className="field">
                    <Label htmlFor="source-clone-id">
                      Source id <span className="muted font-normal">(optional)</span>
                    </Label>
                    <Input
                      id="source-clone-id"
                      type="text"
                      value={cloneId}
                      onChange={(e) => setCloneId(e.target.value)}
                      placeholder="repo"
                      pattern="[a-z][a-z0-9-]{0,62}"
                      className="font-mono"
                      data-testid="source-clone-id-input"
                    />
                  </div>
                  <div className="field">
                    <Label htmlFor="source-clone-ref">
                      Ref <span className="muted font-normal">(optional branch/tag)</span>
                    </Label>
                    <Input
                      id="source-clone-ref"
                      type="text"
                      value={cloneRef}
                      onChange={(e) => setCloneRef(e.target.value)}
                      placeholder="main"
                      className="font-mono"
                      data-testid="source-clone-ref-input"
                    />
                  </div>
                  <div className="form-actions">
                    <Button
                      type="submit"
                      disabled={cloning || !remoteUrl.trim()}
                      data-testid="source-clone-submit"
                    >
                      {cloning ? "Cloning…" : "Clone source"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </Layout>
  );
}
