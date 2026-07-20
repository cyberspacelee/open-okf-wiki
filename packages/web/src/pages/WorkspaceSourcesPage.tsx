import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { IGNORE_PRESETS } from "@okf-wiki/contract";
import {
  addSource,
  cloneSource,
  deleteSource,
  getWorkspace,
  probeSources,
  updateSource,
  type GitProbe,
  type SourceProbeResult,
  type WorkspaceConfig,
  type WorkspaceSource,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { formatMessage, useI18n } from "../i18n";
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

function patternsToText(patterns: readonly string[] | undefined): string {
  return (patterns ?? []).join("\n");
}

function textToPatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function WorkspaceSourcesPage() {
  const { t } = useI18n();
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
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editApplyDefaults, setEditApplyDefaults] = useState(true);
  const [editIgnoreText, setEditIgnoreText] = useState("");
  const [savingIgnores, setSavingIgnores] = useState(false);

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

  function openIgnoreEditor(source: WorkspaceSource) {
    setEditingSourceId(source.id);
    setEditApplyDefaults(source.applyDefaultIgnores !== false);
    setEditIgnoreText(patternsToText(source.ignore));
  }

  function applyPreset(presetId: string) {
    const preset = IGNORE_PRESETS[presetId];
    if (!preset) {
      return;
    }
    const existing = new Set(textToPatterns(editIgnoreText));
    for (const pattern of preset.patterns) {
      existing.add(pattern);
    }
    setEditIgnoreText([...existing].join("\n"));
  }

  async function handleSaveIgnores() {
    if (!id || !editingSourceId) {
      return;
    }
    setSavingIgnores(true);
    setError(null);
    try {
      const result = await updateSource(
        id,
        editingSourceId,
        {
          applyDefaultIgnores: editApplyDefaults,
          ignore: textToPatterns(editIgnoreText),
        },
        workspace?.rootPath ?? rootPathHint,
      );
      setWorkspace(result.workspace);
      setEditingSourceId(null);
    } catch (err) {
      setError(err);
    } finally {
      setSavingIgnores(false);
    }
  }

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
      if (editingSourceId === sourceIdToDelete) {
        setEditingSourceId(null);
      }
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

  function ignoreSummary(source: WorkspaceSource): string {
    const defaults =
      source.applyDefaultIgnores !== false ? t.sources.defaultsOn : t.sources.defaultsOff;
    const custom = formatMessage(t.sources.customCount, {
      n: source.ignore?.length ?? 0,
    });
    return `${defaults} · ${custom}`;
  }

  return (
    <Layout>
      <div data-testid="sources-page" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">{t.sources.breadcrumbWorkspaces}</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>{t.sources.breadcrumbSources}</span>
          </p>
          <h1>{t.sources.title}</h1>
          <p>{t.sources.description}</p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label={t.sources.loading} />
        ) : workspace ? (
          <>
            <Card>
              <CardHeader className="row-between items-center">
                <CardTitle>{t.sources.registered}</CardTitle>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleProbeAll()}
                  disabled={probing || workspace.sources.length === 0}
                  data-testid="source-probe-all"
                >
                  {probing ? t.sources.probing : t.sources.probeAll}
                </Button>
              </CardHeader>
              <CardContent>
                {workspace.sources.length === 0 ? (
                  <div className="empty-inline">
                    <p className="muted">{t.sources.empty}</p>
                  </div>
                ) : (
                  <Table data-testid="source-list">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.sources.colId}</TableHead>
                        <TableHead>{t.sources.colOrigin}</TableHead>
                        <TableHead>{t.sources.colPath}</TableHead>
                        <TableHead>{t.sources.colProbe}</TableHead>
                        <TableHead>{t.sources.colIgnores}</TableHead>
                        <TableHead>
                          <span className="sr-only">{t.common.actions}</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspace.sources.map((source) => (
                        <TableRow key={source.id} data-source-id={source.id}>
                          <TableCell className="mono">{source.id}</TableCell>
                          <TableCell className="muted small">
                            {source.origin?.type === "clone"
                              ? `${t.sources.originClone} · ${source.origin.remoteUrl}`
                              : t.sources.originPath}
                          </TableCell>
                          <TableCell className="mono whitespace-normal">{source.path}</TableCell>
                          <TableCell className="muted small whitespace-normal">
                            {probeLabel(probes[source.id])}
                          </TableCell>
                          <TableCell className="muted small whitespace-normal">
                            {ignoreSummary(source)}
                          </TableCell>
                          <TableCell className="actions-cell">
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-testid={`source-edit-ignores-${source.id}`}
                                onClick={() => openIgnoreEditor(source)}
                              >
                                {t.sources.editIgnores}
                              </Button>
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={deletingId === source.id}
                                onClick={() => void handleDelete(source.id)}
                              >
                                {deletingId === source.id
                                  ? t.sources.removing
                                  : t.sources.delete}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {editingSourceId ? (
              <Card data-testid="source-ignore-editor">
                <CardHeader className="row-between items-center">
                  <CardTitle>
                    {t.sources.ignoreTitle}: <code className="mono">{editingSourceId}</code>
                  </CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingSourceId(null)}
                  >
                    {t.sources.closeEditor}
                  </Button>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="muted small">{t.sources.ignoreDescription}</p>
                  <label className="field checkbox-field">
                    <input
                      type="checkbox"
                      checked={editApplyDefaults}
                      onChange={(e) => setEditApplyDefaults(e.target.checked)}
                      data-testid="source-apply-defaults"
                    />
                    <span>{t.sources.applyDefaults}</span>
                  </label>
                  <div className="field">
                    <Label htmlFor="source-ignore-text">{t.sources.ignorePatterns}</Label>
                    <textarea
                      id="source-ignore-text"
                      className="min-h-32 w-full rounded-md border bg-background p-3 font-mono text-sm"
                      value={editIgnoreText}
                      onChange={(e) => setEditIgnoreText(e.target.value)}
                      placeholder={t.sources.ignorePlaceholder}
                      spellCheck={false}
                      data-testid="source-ignore-text"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="muted small">{t.sources.presets}:</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="preset-java-tests"
                      onClick={() => applyPreset("java-tests")}
                    >
                      {t.sources.presetJava}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="preset-js-tests"
                      onClick={() => applyPreset("js-tests")}
                    >
                      {t.sources.presetJs}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="preset-python-tests"
                      onClick={() => applyPreset("python-tests")}
                    >
                      {t.sources.presetPython}
                    </Button>
                  </div>
                  <div className="form-actions">
                    <Button
                      type="button"
                      disabled={savingIgnores}
                      onClick={() => void handleSaveIgnores()}
                      data-testid="source-ignore-save"
                    >
                      {savingIgnores ? t.sources.savingIgnores : t.sources.saveIgnores}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>{t.sources.linkTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="form" onSubmit={(e) => void handleAdd(e)}>
                  <div className="field">
                    <Label htmlFor="source-path">{t.sources.pathLabel}</Label>
                    <Input
                      id="source-path"
                      type="text"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder={t.sources.pathPlaceholder}
                      required
                      className="font-mono"
                      data-testid="source-path-input"
                    />
                  </div>
                  <div className="field">
                    <Label htmlFor="source-id">
                      {t.sources.sourceIdLabel}{" "}
                      <span className="muted font-normal">{t.sources.sourceIdOptional}</span>
                    </Label>
                    <Input
                      id="source-id"
                      type="text"
                      value={sourceId}
                      onChange={(e) => setSourceId(e.target.value)}
                      placeholder={t.sources.sourceIdPlaceholder}
                      pattern="[a-z][a-z0-9-]{0,62}"
                      className="font-mono"
                      data-testid="source-id-input"
                    />
                    <span className="field-hint">{t.sources.sourceIdHint}</span>
                  </div>
                  <div className="form-actions">
                    <Button
                      type="submit"
                      disabled={submitting || !path.trim()}
                      data-testid="source-add-submit"
                    >
                      {submitting ? t.sources.adding : t.sources.addSource}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.sources.cloneTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="muted small mb-4">
                  {formatMessage(t.sources.cloneHint, { root: workspace.rootPath })}
                </p>
                <form className="form" onSubmit={(e) => void handleClone(e)}>
                  <div className="field">
                    <Label htmlFor="source-remote">{t.sources.remoteUrl}</Label>
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
                    <Label htmlFor="source-clone-id">{t.sources.cloneId}</Label>
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
                    <Label htmlFor="source-clone-ref">{t.sources.cloneRef}</Label>
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
                      {cloning ? t.sources.cloning : t.sources.cloneSubmit}
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
