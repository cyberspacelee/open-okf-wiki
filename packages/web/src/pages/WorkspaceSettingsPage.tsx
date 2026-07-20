import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  createWorkspaceSkillFork,
  deleteWorkspace,
  getProvider,
  getWorkspace,
  getWorkspaceSkill,
  listWorkspaceSkillFiles,
  patchWorkspace,
  readWorkspaceSkillFile,
  resetWorkspaceSkill,
  writeWorkspaceSkillFile,
  type ModelProfilePublic,
  type SkillInfo,
  type WikiLanguage,
  type WorkspaceConfig,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { formatMessage, useI18n } from "../i18n";
import { workspaceHref } from "../lib/workspace-path";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WorkspaceSettingsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMeta, setDeleteMeta] = useState(false);

  const [name, setName] = useState("");
  const [modelProfileId, setModelProfileId] = useState("");
  const [publicationPath, setPublicationPath] = useState("");
  const [adaptive, setAdaptive] = useState(false);
  const [reviewer, setReviewer] = useState(false);
  const [planConfirm, setPlanConfirm] = useState(false);
  const [wikiLanguage, setWikiLanguage] = useState<WikiLanguage>("en");
  const [skill, setSkill] = useState<SkillInfo | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillFilePath, setSkillFilePath] = useState("SKILL.md");
  const [skillFileContent, setSkillFileContent] = useState("");
  const [skillFileDirty, setSkillFileDirty] = useState(false);

  const applyWorkspace = useCallback(
    (ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => {
      setWorkspace(ws);
      setName(ws.name);
      setPublicationPath(ws.publicationPath);
      setAdaptive(ws.adaptive);
      setReviewer(ws.reviewer);
      setPlanConfirm(Boolean(ws.planConfirm));
      setWikiLanguage(ws.wikiLanguage ?? "en");

      // Prefer profileId; else match denormalized model id; else keep empty.
      if (ws.model.profileId && catalog.some((m) => m.id === ws.model.profileId)) {
        setModelProfileId(ws.model.profileId);
      } else {
        const byModelId = catalog.find((m) => m.modelId === ws.model.id);
        setModelProfileId(byModelId?.id ?? ws.model.profileId ?? "");
      }
    },
    [],
  );

  const loadSkill = useCallback(
    async (ws: WorkspaceConfig) => {
      try {
        const data = await getWorkspaceSkill(ws.id, ws.rootPath ?? rootPathHint);
        setSkill(data.skill);
        // Prefetch SKILL.md for editor when fork is active.
        if (data.skill.kind === "fork") {
          try {
            const file = await readWorkspaceSkillFile(
              ws.id,
              "SKILL.md",
              ws.rootPath ?? rootPathHint,
            );
            setSkillFilePath("SKILL.md");
            setSkillFileContent(file.file.content);
            setSkillFileDirty(false);
          } catch {
            // Editor is optional if read fails.
          }
        }
      } catch {
        setSkill(null);
      }
    },
    [rootPathHint],
  );

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const [wsData, providerData] = await Promise.all([
        getWorkspace(id, rootPathHint),
        getProvider().catch(() => null),
      ]);
      const catalog = providerData?.provider.models ?? [];
      setModels(catalog);
      setDefaultModelProfileId(providerData?.provider.defaultModelProfileId);
      applyWorkspace(wsData.workspace, catalog);
      await loadSkill(wsData.workspace);
    } catch (err) {
      setError(err);
      setWorkspace(null);
      setSkill(null);
    } finally {
      setLoading(false);
    }
  }, [id, rootPathHint, applyWorkspace, loadSkill]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!id) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const result = await patchWorkspace(
        id,
        {
          name: name.trim(),
          ...(modelProfileId ? { modelProfileId } : {}),
          publicationPath: publicationPath.trim(),
          adaptive,
          reviewer,
          planConfirm,
          wikiLanguage,
        },
        workspace?.rootPath ?? rootPathHint,
      );
      applyWorkspace(result.workspace, models);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedModel = models.find((m) => m.id === modelProfileId);
  const orphanModelId =
    workspace &&
    !selectedModel &&
    workspace.model.id &&
    !models.some((m) => m.modelId === workspace.model.id)
      ? workspace.model.id
      : null;

  async function handleDeleteWorkspace() {
    if (!id || !workspace) {
      return;
    }
    const ok = window.confirm(
      formatMessage(t.settings.deleteConfirm, { name: workspace.name }),
    );
    if (!ok) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkspace(id, {
        rootPath: workspace.rootPath ?? rootPathHint,
        deleteFiles: deleteMeta,
      });
      navigate("/workspaces");
    } catch (err) {
      setError(err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Layout>
      <div data-testid="settings-page" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">{t.settings.breadcrumbWorkspaces}</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>{t.settings.breadcrumbSettings}</span>
          </p>
          <h1>{t.settings.title}</h1>
          <p>
            {t.settings.descriptionPrefix}{" "}
            <Link to="/settings">{t.settings.descriptionLink}</Link>
            {t.settings.descriptionSuffix}
          </p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label={t.settings.loading} />
        ) : workspace ? (
          <Card>
            <CardContent className="flex flex-col gap-6">
              <form className="form" onSubmit={(e) => void handleSubmit(e)}>
                <div className="field">
                  <Label htmlFor="settings-name">{t.settings.name}</Label>
                  <Input
                    id="settings-name"
                    type="text"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setSaved(false);
                    }}
                    required
                    maxLength={120}
                    data-testid="settings-name-input"
                  />
                </div>

                <ModelSelect
                  models={models}
                  value={modelProfileId}
                  onChange={(next) => {
                    setModelProfileId(next);
                    setSaved(false);
                  }}
                  defaultModelProfileId={defaultModelProfileId}
                  required={models.length > 0}
                  data-testid="settings-model-select"
                />
                {/* Keep a stable test id for e2e that assert selection */}
                <input
                  type="hidden"
                  data-testid="settings-model-input"
                  value={selectedModel?.modelId ?? orphanModelId ?? ""}
                  readOnly
                />
                {orphanModelId ? (
                  <p className="muted small" data-testid="settings-model-orphan">
                    Previous model id <code className="mono">{orphanModelId}</code> is no longer in
                    Settings. Pick a configured model above.
                  </p>
                ) : null}

                <div className="field">
                  <Label htmlFor="settings-publication">{t.settings.publicationPath}</Label>
                  <Input
                    id="settings-publication"
                    type="text"
                    value={publicationPath}
                    onChange={(e) => {
                      setPublicationPath(e.target.value);
                      setSaved(false);
                    }}
                    placeholder="D:/src/app/wiki"
                    required
                    className="font-mono"
                  />
                </div>
                <div className="field">
                  <Label htmlFor="settings-wiki-language">{t.settings.wikiLanguage}</Label>
                  <select
                    id="settings-wiki-language"
                    className="flex h-9 w-full max-w-xs rounded-md border bg-background px-3 text-sm"
                    value={wikiLanguage}
                    onChange={(e) => {
                      setWikiLanguage(e.target.value as WikiLanguage);
                      setSaved(false);
                    }}
                    data-testid="settings-wiki-language"
                  >
                    <option value="en">{t.settings.langEn}</option>
                    <option value="zh">{t.settings.langZh}</option>
                  </select>
                  <span className="field-hint">{t.settings.wikiLanguageHint}</span>
                </div>
                <label className="field checkbox-field">
                  <input
                    type="checkbox"
                    checked={adaptive}
                    onChange={(e) => {
                      setAdaptive(e.target.checked);
                      setSaved(false);
                    }}
                  />
                  <span>
                    <strong>{t.settings.adaptive}</strong>
                    <span className="field-hint">{t.settings.adaptiveHint}</span>
                  </span>
                </label>
                <label className="field checkbox-field">
                  <input
                    type="checkbox"
                    checked={reviewer}
                    onChange={(e) => {
                      setReviewer(e.target.checked);
                      setSaved(false);
                    }}
                  />
                  <span>
                    <strong>{t.settings.reviewer}</strong>
                    <span className="field-hint">{t.settings.reviewerHint}</span>
                  </span>
                </label>
                <label className="field checkbox-field">
                  <input
                    type="checkbox"
                    checked={planConfirm}
                    onChange={(e) => {
                      setPlanConfirm(e.target.checked);
                      setSaved(false);
                    }}
                    data-testid="settings-plan-confirm"
                  />
                  <span>
                    <strong>{t.settings.planConfirm}</strong>
                    <span className="field-hint">{t.settings.planConfirmHint}</span>
                  </span>
                </label>

                <div className="form-actions">
                  <Button
                    type="submit"
                    disabled={
                      submitting ||
                      !name.trim() ||
                      !publicationPath.trim() ||
                      (models.length > 0 && !modelProfileId)
                    }
                    data-testid="settings-save"
                  >
                    {submitting ? t.settings.saving : t.settings.save}
                  </Button>
                  {saved ? (
                    <span className="success-text" role="status">
                      {t.settings.saved}
                    </span>
                  ) : null}
                </div>
              </form>

              <section className="flex flex-col gap-3" data-testid="settings-skill-panel">
                <h2 className="text-base font-semibold">{t.settings.skillTitle}</h2>
                <p className="muted small">{t.settings.skillDescription}</p>
                {skill ? (
                  <dl className="kv">
                    <div>
                      <dt>{t.settings.skillKind}</dt>
                      <dd data-testid="settings-skill-kind">{skill.kind}</dd>
                    </div>
                    <div>
                      <dt>{t.settings.skillDigest}</dt>
                      <dd className="mono small" data-testid="settings-skill-digest">
                        {skill.digest.slice(0, 16)}…
                      </dd>
                    </div>
                    <div>
                      <dt>{t.settings.skillPath}</dt>
                      <dd className="mono small whitespace-normal">{skill.path}</dd>
                    </div>
                    {skill.name ? (
                      <div>
                        <dt>{t.settings.skillName}</dt>
                        <dd>{skill.name}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p className="muted small">{t.settings.skillUnavailable}</p>
                )}
                <div className="row-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={skillBusy}
                    data-testid="settings-skill-fork"
                    onClick={() => {
                      void (async () => {
                        if (!id) {
                          return;
                        }
                        setSkillBusy(true);
                        setError(null);
                        try {
                          const result = await createWorkspaceSkillFork(
                            id,
                            workspace.rootPath ?? rootPathHint,
                          );
                          applyWorkspace(result.workspace, models);
                          setSkill(result.skill);
                          const file = await readWorkspaceSkillFile(
                            id,
                            "SKILL.md",
                            result.workspace.rootPath ?? rootPathHint,
                          );
                          setSkillFilePath("SKILL.md");
                          setSkillFileContent(file.file.content);
                          setSkillFileDirty(false);
                        } catch (err) {
                          setError(err);
                        } finally {
                          setSkillBusy(false);
                        }
                      })();
                    }}
                  >
                    {skillBusy ? t.settings.skillWorking : t.settings.skillFork}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={skillBusy || skill?.kind !== "fork"}
                    data-testid="settings-skill-reset"
                    onClick={() => {
                      void (async () => {
                        if (!id) {
                          return;
                        }
                        setSkillBusy(true);
                        setError(null);
                        try {
                          const result = await resetWorkspaceSkill(
                            id,
                            workspace.rootPath ?? rootPathHint,
                          );
                          applyWorkspace(result.workspace, models);
                          setSkill(result.skill);
                          setSkillFileContent("");
                          setSkillFileDirty(false);
                        } catch (err) {
                          setError(err);
                        } finally {
                          setSkillBusy(false);
                        }
                      })();
                    }}
                  >
                    {t.settings.skillBundled}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={skillBusy || skill?.kind !== "fork"}
                    data-testid="settings-skill-load-file"
                    onClick={() => {
                      void (async () => {
                        if (!id || !skillFilePath.trim()) {
                          return;
                        }
                        setSkillBusy(true);
                        setError(null);
                        try {
                          const file = await readWorkspaceSkillFile(
                            id,
                            skillFilePath.trim(),
                            workspace.rootPath ?? rootPathHint,
                          );
                          setSkillFileContent(file.file.content);
                          setSkillFileDirty(false);
                        } catch (err) {
                          setError(err);
                        } finally {
                          setSkillBusy(false);
                        }
                      })();
                    }}
                  >
                    {t.settings.skillLoadFile}
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      skillBusy || skill?.kind !== "fork" || !skillFileDirty || !skillFilePath.trim()
                    }
                    data-testid="settings-skill-save-file"
                    onClick={() => {
                      void (async () => {
                        if (!id) {
                          return;
                        }
                        setSkillBusy(true);
                        setError(null);
                        try {
                          const result = await writeWorkspaceSkillFile(
                            id,
                            {
                              path: skillFilePath.trim(),
                              content: skillFileContent,
                            },
                            workspace.rootPath ?? rootPathHint,
                          );
                          setSkill(result.skill);
                          setSkillFileDirty(false);
                        } catch (err) {
                          setError(err);
                        } finally {
                          setSkillBusy(false);
                        }
                      })();
                    }}
                  >
                    {t.settings.skillSaveFile}
                  </Button>
                </div>
                {skill?.kind === "fork" ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="settings-skill-file-path">{t.settings.skillFileLabel}</Label>
                    <Input
                      id="settings-skill-file-path"
                      className="font-mono"
                      value={skillFilePath}
                      onChange={(e) => setSkillFilePath(e.target.value)}
                      data-testid="settings-skill-file-path"
                    />
                    <textarea
                      className="min-h-48 w-full rounded-md border bg-background p-3 font-mono text-sm"
                      value={skillFileContent}
                      onChange={(e) => {
                        setSkillFileContent(e.target.value);
                        setSkillFileDirty(true);
                      }}
                      data-testid="settings-skill-file-editor"
                      spellCheck={false}
                    />
                    <p className="muted small">
                      Files:{" "}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => {
                          void (async () => {
                            if (!id) {
                              return;
                            }
                            try {
                              const listed = await listWorkspaceSkillFiles(
                                id,
                                "",
                                workspace.rootPath ?? rootPathHint,
                              );
                              const firstMd = listed.entries.find(
                                (e) => e.kind === "file" && e.path.endsWith(".md"),
                              );
                              if (firstMd) {
                                setSkillFilePath(firstMd.path);
                              }
                            } catch (err) {
                              setError(err);
                            }
                          })();
                        }}
                      >
                        {t.settings.skillListRoot}
                      </button>
                      {skill.files.length > 0
                        ? ` · ${skill.files.slice(0, 8).join(", ")}${skill.files.length > 8 ? "…" : ""}`
                        : null}
                    </p>
                  </div>
                ) : null}
              </section>

              <dl className="kv muted-block">
                <div>
                  <dt>{t.settings.rootPath}</dt>
                  <dd className="mono">{workspace.rootPath}</dd>
                </div>
                <div>
                  <dt>{t.common.id}</dt>
                  <dd className="mono">{workspace.id}</dd>
                </div>
                <div>
                  <dt>{t.settings.selectedModelId}</dt>
                  <dd className="mono">{workspace.model.id}</dd>
                </div>
                {workspace.model.profileId ? (
                  <div>
                    <dt>{t.settings.modelProfile}</dt>
                    <dd className="mono">{workspace.model.profileId}</dd>
                  </div>
                ) : null}
              </dl>

              <section
                className="flex flex-col gap-3 rounded-md border border-destructive/30 p-4"
                data-testid="settings-danger-zone"
              >
                <h2 className="text-base font-semibold text-destructive">
                  {t.settings.dangerTitle}
                </h2>
                <p className="muted small">{t.settings.dangerDescription}</p>
                <label className="field checkbox-field">
                  <input
                    type="checkbox"
                    checked={deleteMeta}
                    onChange={(e) => setDeleteMeta(e.target.checked)}
                    data-testid="settings-delete-meta"
                  />
                  <span>{t.settings.deleteMeta}</span>
                </label>
                <div className="form-actions">
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={deleting}
                    onClick={() => void handleDeleteWorkspace()}
                    data-testid="settings-delete-workspace"
                  >
                    {deleting ? t.common.deleting : t.settings.deleteWorkspace}
                  </Button>
                </div>
              </section>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Layout>
  );
}
