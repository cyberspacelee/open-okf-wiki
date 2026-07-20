import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  createWorkspaceSkillFork,
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
  type WorkspaceConfig,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { workspaceHref } from "../lib/workspace-path";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WorkspaceSettingsPage() {
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

  const [name, setName] = useState("");
  const [modelProfileId, setModelProfileId] = useState("");
  const [publicationPath, setPublicationPath] = useState("");
  const [adaptive, setAdaptive] = useState(false);
  const [reviewer, setReviewer] = useState(false);
  const [planConfirm, setPlanConfirm] = useState(false);
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

  return (
    <Layout>
      <div data-testid="settings-page" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">Workspaces</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Settings</span>
          </p>
          <h1>Workspace settings</h1>
          <p>
            Project options for this workspace. Models and credentials are configured only under{" "}
            <Link to="/settings">Settings</Link>.
          </p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label="Loading settings…" />
        ) : workspace ? (
          <Card>
            <CardContent className="flex flex-col gap-6">
              <form className="form" onSubmit={(e) => void handleSubmit(e)}>
                <div className="field">
                  <Label htmlFor="settings-name">Name</Label>
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
                  <Label htmlFor="settings-publication">Publication path (absolute)</Label>
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
                    <strong>Adaptive</strong>
                    <span className="field-hint">
                      Enable adaptive orchestration for this workspace.
                    </span>
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
                    <strong>Reviewer</strong>
                    <span className="field-hint">
                      Enable wiki reviewer inspection before publication.
                    </span>
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
                    <strong>Plan confirm</strong>
                    <span className="field-hint">
                      Pause interactive runs for operator approval of the intended page set.
                    </span>
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
                    {submitting ? "Saving…" : "Save changes"}
                  </Button>
                  {saved ? (
                    <span className="success-text" role="status">
                      Saved
                    </span>
                  ) : null}
                </div>
              </form>

              <section className="flex flex-col gap-3" data-testid="settings-skill-panel">
                <h2 className="text-base font-semibold">Producer Skill</h2>
                <p className="muted small">
                  Global method package for wiki generation. Create a workspace fork to customize
                  templates and guidance; each Wiki Run freezes the skill content digest.
                </p>
                {skill ? (
                  <dl className="kv">
                    <div>
                      <dt>Kind</dt>
                      <dd data-testid="settings-skill-kind">{skill.kind}</dd>
                    </div>
                    <div>
                      <dt>Digest</dt>
                      <dd className="mono small" data-testid="settings-skill-digest">
                        {skill.digest.slice(0, 16)}…
                      </dd>
                    </div>
                    <div>
                      <dt>Path</dt>
                      <dd className="mono small whitespace-normal">{skill.path}</dd>
                    </div>
                    {skill.name ? (
                      <div>
                        <dt>Name</dt>
                        <dd>{skill.name}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p className="muted small">Skill info unavailable.</p>
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
                    {skillBusy ? "Working…" : "Create / refresh fork"}
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
                    Use bundled
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
                    Load file
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
                    Save file
                  </Button>
                </div>
                {skill?.kind === "fork" ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="settings-skill-file-path">Skill file (fork editor)</Label>
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
                        list root
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
                  <dt>Root path</dt>
                  <dd className="mono">{workspace.rootPath}</dd>
                </div>
                <div>
                  <dt>ID</dt>
                  <dd className="mono">{workspace.id}</dd>
                </div>
                <div>
                  <dt>Selected model id</dt>
                  <dd className="mono">{workspace.model.id}</dd>
                </div>
                {workspace.model.profileId ? (
                  <div>
                    <dt>Model profile</dt>
                    <dd className="mono">{workspace.model.profileId}</dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Layout>
  );
}
