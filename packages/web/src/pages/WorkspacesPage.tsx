import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createWorkspace,
  deleteWorkspace,
  getProvider,
  listWorkspaces,
  type ModelProfilePublic,
  type WorkspaceSummary,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { formatMessage, useI18n } from "../i18n";
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
  const { t } = useI18n();
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceSummary | null>(null);
  const [deleteMeta, setDeleteMeta] = useState(false);

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

  async function handleDeleteConfirm() {
    if (!deleteTarget) {
      return;
    }
    setDeletingId(deleteTarget.id);
    setError(null);
    try {
      await deleteWorkspace(deleteTarget.id, {
        rootPath: deleteTarget.rootPath,
        deleteFiles: deleteMeta,
      });
      setDeleteTarget(null);
      setDeleteMeta(false);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Layout>
      <div data-testid="workspaces-page" className="flex flex-col gap-5">
        <header className="page-header row-between">
          <div>
            <h1>{t.workspaces.title}</h1>
            <p>
              {t.workspaces.descriptionBefore}
              <Link to="/settings">{t.workspaces.settingsLink}</Link>
              {t.workspaces.descriptionAfter}
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
            {showForm ? t.workspaces.cancel : t.workspaces.create}
          </Button>
        </header>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {deleteTarget ? (
          <Card data-testid="workspace-delete-dialog">
            <CardHeader>
              <CardTitle>{t.workspaces.deleteConfirmTitle}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="muted">
                {formatMessage(t.workspaces.deleteConfirmBody, {
                  name: deleteTarget.name,
                })}
              </p>
              <label className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={deleteMeta}
                  onChange={(e) => setDeleteMeta(e.target.checked)}
                  data-testid="workspace-delete-meta"
                />
                <span>{t.workspaces.deleteMetaLabel}</span>
              </label>
              <div className="form-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDeleteTarget(null);
                    setDeleteMeta(false);
                  }}
                >
                  {t.common.cancel}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deletingId === deleteTarget.id}
                  onClick={() => void handleDeleteConfirm()}
                  data-testid="workspace-delete-confirm"
                >
                  {deletingId === deleteTarget.id
                    ? t.workspaces.deleting
                    : t.workspaces.deleteSubmit}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {showForm ? (
          <Card data-testid="workspace-create-form">
            <CardHeader>
              <CardTitle>{t.workspaces.createTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="form" onSubmit={(e) => void handleCreate(e)}>
                <div className="field">
                  <Label htmlFor="workspace-name">{t.workspaces.nameLabel}</Label>
                  <Input
                    id="workspace-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t.workspaces.namePlaceholder}
                    required
                    maxLength={120}
                    autoFocus
                    data-testid="workspace-name-input"
                  />
                </div>
                <div className="field">
                  <Label htmlFor="workspace-root">{t.workspaces.rootLabel}</Label>
                  <Input
                    id="workspace-root"
                    type="text"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    placeholder={t.workspaces.rootPlaceholder}
                    required
                    className="font-mono"
                    data-testid="workspace-root-input"
                  />
                  <span className="field-hint">{t.workspaces.rootHint}</span>
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
                    {submitting ? t.workspaces.creating : t.workspaces.createSubmit}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : null}

        {loading ? (
          <LoadingState label={t.workspaces.loading} />
        ) : workspaces.length === 0 ? (
          <Card data-testid="workspaces-empty">
            <CardContent className="pt-0">
              <Empty className="border-0 p-6">
                <EmptyHeader>
                  <EmptyTitle className="text-base">{t.workspaces.emptyTitle}</EmptyTitle>
                  <EmptyDescription>{t.workspaces.emptyDescription}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <ul className="checklist text-left">
                    <li>
                      {t.workspaces.checklistModels}{" "}
                      <Link to="/settings">{t.workspaces.settingsLink}</Link>
                    </li>
                    <li>{t.workspaces.checklistSources}</li>
                    <li>{t.workspaces.checklistRun}</li>
                  </ul>
                  {!showForm ? (
                    <Button type="button" onClick={() => setShowForm(true)}>
                      {t.workspaces.createSubmit}
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
                    <TableHead>{t.workspaces.colName}</TableHead>
                    <TableHead>{t.workspaces.colRoot}</TableHead>
                    <TableHead>{t.workspaces.colSources}</TableHead>
                    <TableHead>{t.workspaces.colLastOpened}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t.workspaces.colActions}</span>
                    </TableHead>
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
                        <TableCell className="mono muted whitespace-normal">
                          {ws.rootPath}
                        </TableCell>
                        <TableCell>{ws.sourceCount}</TableCell>
                        <TableCell className="muted">
                          {ws.lastOpenedAt
                            ? new Date(ws.lastOpenedAt).toLocaleString()
                            : "—"}
                        </TableCell>
                        <TableCell className="actions-cell">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            data-testid="workspace-delete"
                            disabled={deletingId === ws.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteTarget(ws);
                              setDeleteMeta(false);
                            }}
                          >
                            {t.workspaces.delete}
                          </Button>
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
