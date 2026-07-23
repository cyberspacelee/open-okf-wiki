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
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { formatMessage, useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
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

  function openCreateForm() {
    setShowForm(true);
    setError(null);
  }

  function closeCreateForm() {
    setShowForm(false);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const root = rootPath.trim();
      const { workspace } = await createWorkspace({
        name: name.trim(),
        rootPath: root,
        ...(modelProfileId ? { modelProfileId } : {}),
      });
      setName("");
      setRootPath("");
      setShowForm(false);
      // Keep rootPath in the URL so Agent Workspace can load without a second lookup race.
      const params = new URLSearchParams({ rootPath: root });
      navigate(
        `/w/${encodeURIComponent(workspace.id)}?${params.toString()}`,
      );
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
    // Capture before dialog close clears controlled state.
    const target = deleteTarget;
    const deleteFiles = deleteMeta;
    setDeletingId(target.id);
    setError(null);
    try {
      await deleteWorkspace(target.id, {
        rootPath: target.rootPath,
        deleteFiles,
      });
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
          <Button type="button" onClick={openCreateForm}>
            {t.workspaces.create}
          </Button>
        </header>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        <Dialog
          open={showForm}
          onOpenChange={(open) => {
            if (open) {
              openCreateForm();
            } else {
              closeCreateForm();
            }
          }}
        >
          <DialogContent
            className="sm:max-w-lg"
            data-testid="workspace-create-form"
          >
            <DialogHeader>
              <DialogTitle>{t.workspaces.createTitle}</DialogTitle>
              <DialogDescription>{t.workspaces.rootHint}</DialogDescription>
            </DialogHeader>
            <form className="form" onSubmit={(e) => void handleCreate(e)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="workspace-name">
                    {t.workspaces.nameLabel}
                  </FieldLabel>
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
                </Field>
                <Field>
                  <FieldLabel htmlFor="workspace-root">
                    {t.workspaces.rootLabel}
                  </FieldLabel>
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
                  <FieldDescription>{t.workspaces.rootHint}</FieldDescription>
                </Field>
                <ModelSelect
                  models={models}
                  value={modelProfileId}
                  onChange={setModelProfileId}
                  defaultModelProfileId={defaultModelProfileId}
                  required={models.length > 0}
                  allowEmpty={models.length === 0}
                />
              </FieldGroup>
              <DialogFooter className="mt-4 px-0 pb-0">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeCreateForm}
                >
                  {t.workspaces.cancel}
                </Button>
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
                  {submitting ? <Spinner data-icon="inline-start" /> : null}
                  {submitting
                    ? t.workspaces.creating
                    : t.workspaces.createSubmit}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleteTarget != null}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteTarget(null);
              setDeleteMeta(false);
            }
          }}
          title={t.workspaces.deleteConfirmTitle}
          description={
            deleteTarget
              ? formatMessage(t.workspaces.deleteConfirmBody, {
                  name: deleteTarget.name,
                })
              : undefined
          }
          confirmLabel={
            deletingId != null ? t.workspaces.deleting : t.workspaces.deleteSubmit
          }
          cancelLabel={t.common.cancel}
          onConfirm={() => void handleDeleteConfirm()}
          confirmDisabled={deletingId != null}
          data-testid="workspace-delete-dialog"
          confirmTestId="workspace-delete-confirm"
          metaChecked={deleteMeta}
          onMetaCheckedChange={setDeleteMeta}
          metaLabel={t.workspaces.deleteMetaLabel}
          metaTestId="workspace-delete-meta"
        />

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
                  <Button type="button" onClick={openCreateForm}>
                    {t.workspaces.createSubmit}
                  </Button>
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
                    const href = `/w/${encodeURIComponent(ws.id)}?${params.toString()}`;
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
