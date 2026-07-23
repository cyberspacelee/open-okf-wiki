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
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { formatMessage, useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

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
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [name, setName] = useState("");
  const [modelProfileId, setModelProfileId] = useState("");
  const [publicationPath, setPublicationPath] = useState("");
  const [planConfirm, setPlanConfirm] = useState(false);
  const [wikiLanguage, setWikiLanguage] = useState<WikiLanguage>("en");
  /** Empty string means unset (derive from model max context). */
  const [contextTargetTokens, setContextTargetTokens] = useState("");
  const [maxDomainFanOut, setMaxDomainFanOut] = useState("4");
  const [maxLeafFanOut, setMaxLeafFanOut] = useState("6");
  const [reviewCouncilSize, setReviewCouncilSize] = useState("1");
  const [plannerProfileId, setPlannerProfileId] = useState("");
  const [workerProfileId, setWorkerProfileId] = useState("");
  const [writerProfileId, setWriterProfileId] = useState("");
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
      setPlanConfirm(Boolean(ws.planConfirm));
      setWikiLanguage(ws.wikiLanguage ?? "en");
      setContextTargetTokens(
        ws.limits?.contextTargetTokens !== undefined
          ? String(ws.limits.contextTargetTokens)
          : "",
      );
      setMaxDomainFanOut(String(ws.orchestration?.maxDomainFanOut ?? 4));
      setMaxLeafFanOut(String(ws.orchestration?.maxLeafFanOut ?? 6));
      setReviewCouncilSize(String(ws.orchestration?.reviewCouncilSize ?? 1));
      setPlannerProfileId(ws.roleModels?.planner?.profileId ?? "");
      setWorkerProfileId(ws.roleModels?.worker?.profileId ?? "");
      setWriterProfileId(ws.roleModels?.writer?.profileId ?? "");

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
      const contextRaw = contextTargetTokens.trim();
      let nextContextTarget: number | undefined;
      if (contextRaw !== "") {
        const parsed = Number(contextRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          setError(new Error("contextTargetTokens must be a positive integer"));
          setSubmitting(false);
          return;
        }
        nextContextTarget = parsed;
      }
      const baseLimits = workspace?.limits ?? { requestTimeoutSeconds: 120 };
      const {
        contextTargetTokens: _drop,
        ...limitsWithoutContext
      } = baseLimits;
      void _drop;
      const nextLimits = {
        ...limitsWithoutContext,
        ...(nextContextTarget !== undefined
          ? { contextTargetTokens: nextContextTarget }
          : {}),
      };
      const profileToRef = (profileId: string) => {
        const m = models.find((x) => x.id === profileId);
        if (!m) return undefined;
        return { id: m.modelId, profileId: m.id };
      };
      const roleModels = {
        ...(profileToRef(plannerProfileId)
          ? { planner: profileToRef(plannerProfileId) }
          : {}),
        ...(profileToRef(workerProfileId)
          ? { worker: profileToRef(workerProfileId) }
          : {}),
        ...(profileToRef(writerProfileId)
          ? { writer: profileToRef(writerProfileId) }
          : {}),
        reviewers: workspace?.roleModels?.reviewers ?? [],
      };
      const baseOrch = workspace?.orchestration;
      const orchestration = {
        maxDepth: baseOrch?.maxDepth ?? 2,
        maxDomainFanOut: Math.max(1, Number(maxDomainFanOut) || 4),
        maxLeafFanOut: Math.max(1, Number(maxLeafFanOut) || 6),
        rootMaxSteps: baseOrch?.rootMaxSteps ?? 96,
        domainMaxSteps: baseOrch?.domainMaxSteps ?? 12,
        leafMaxSteps: baseOrch?.leafMaxSteps ?? 8,
        reviewerMaxSteps: baseOrch?.reviewerMaxSteps ?? 8,
        planMaxSteps: baseOrch?.planMaxSteps ?? 24,
        reviewCouncilSize: Math.min(
          4,
          Math.max(1, Number(reviewCouncilSize) || 1),
        ),
      };
      const result = await patchWorkspace(
        id,
        {
          name: name.trim(),
          ...(modelProfileId ? { modelProfileId } : {}),
          publicationPath: publicationPath.trim(),
          planConfirm,
          wikiLanguage,
          limits: nextLimits,
          roleModels,
          orchestration,
        },
        workspace?.rootPath ?? rootPathHint,
      );
      applyWorkspace(result.workspace, models);
      setSaved(true);
      toast.success(t.settings.saved);
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
  /** 85% of model max when workspace target is blank (matches agent CONTEXT_COMPACTION_RATIO). */
  const derivedContextTarget =
    !contextTargetTokens.trim() &&
    selectedModel?.maxContextTokens !== undefined
      ? Math.floor(selectedModel.maxContextTokens * 0.85)
      : undefined;

  async function handleDeleteWorkspace() {
    if (!id || !workspace) {
      return;
    }
    const deleteFiles = deleteMeta;
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkspace(id, {
        rootPath: workspace.rootPath ?? rootPathHint,
        deleteFiles,
      });
      navigate("/workspaces");
    } catch (err) {
      setError(err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <WorkspaceShell
      workspaceId={id}
      workspaceName={workspace?.name}
      breadcrumbLabel={t.settings.breadcrumbSettings}
      title={t.settings.title}
      description={
        <>
          {t.settings.descriptionPrefix}{" "}
          <Link to="/settings">{t.settings.descriptionLink}</Link>
          {t.settings.descriptionSuffix}
        </>
      }
      error={error}
      onDismissError={() => setError(null)}
      testId="settings-page"
    >
        {loading ? (
          <LoadingState label={t.settings.loading} />
        ) : workspace ? (
          <Tabs defaultValue="general" className="w-full">
            <TabsList variant="line" className="mb-2 w-full justify-start">
              <TabsTrigger value="general" data-testid="settings-tab-general">
                {t.settings.tabGeneral}
              </TabsTrigger>
              <TabsTrigger value="skill" data-testid="settings-tab-skill">
                {t.settings.tabSkill}
              </TabsTrigger>
              <TabsTrigger value="danger" data-testid="settings-tab-danger">
                {t.settings.tabDanger}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="flex flex-col gap-6 outline-none">
              <Card>
                <CardContent className="flex flex-col gap-6">
                  <form className="form" onSubmit={(e) => void handleSubmit(e)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="settings-name">{t.settings.name}</FieldLabel>
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
                  </Field>

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
                      Previous model id <code className="mono">{orphanModelId}</code> is no
                      longer in Settings. Pick a configured model above.
                    </p>
                  ) : null}

                  <Field>
                    <FieldLabel htmlFor="settings-publication">
                      {t.settings.publicationPath}
                    </FieldLabel>
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
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="settings-wiki-language">
                      {t.settings.wikiLanguage}
                    </FieldLabel>
                    <Select
                      value={wikiLanguage}
                      onValueChange={(next) => {
                        if (next === "en" || next === "zh") {
                          setWikiLanguage(next);
                          setSaved(false);
                        }
                      }}
                      items={[
                        { value: "en", label: t.settings.langEn },
                        { value: "zh", label: t.settings.langZh },
                      ]}
                    >
                      <SelectTrigger
                        id="settings-wiki-language"
                        className="w-full max-w-xs"
                        data-testid="settings-wiki-language"
                        data-value={wikiLanguage}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">{t.settings.langEn}</SelectItem>
                        <SelectItem value="zh">{t.settings.langZh}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {t.settings.wikiLanguageHint}
                    </FieldDescription>
                  </Field>

                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="settings-plan-confirm">
                        {t.settings.planConfirm}
                      </FieldLabel>
                      <FieldDescription>
                        {t.settings.planConfirmHint}
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="settings-plan-confirm"
                      checked={planConfirm}
                      onCheckedChange={(checked) => {
                        setPlanConfirm(checked);
                        setSaved(false);
                      }}
                      data-testid="settings-plan-confirm"
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="settings-context-target">
                      {t.settings.contextTargetTokens}
                    </FieldLabel>
                    <Input
                      id="settings-context-target"
                      type="number"
                      min={1}
                      step={1}
                      value={contextTargetTokens}
                      onChange={(e) => {
                        setContextTargetTokens(e.target.value);
                        setSaved(false);
                      }}
                      placeholder={t.settings.contextTargetTokensPlaceholder}
                      className="font-mono max-w-xs"
                      data-testid="settings-context-target"
                    />
                    <FieldDescription>
                      {t.settings.contextTargetTokensHint}
                      {derivedContextTarget !== undefined ? (
                        <>
                          {" "}
                          {formatMessage(t.settings.contextTargetDerived, {
                            n: derivedContextTarget.toLocaleString(),
                          })}
                        </>
                      ) : null}
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel>{t.settings.orchestrationTitle}</FieldLabel>
                    <FieldDescription>
                      {t.settings.orchestrationHint}
                    </FieldDescription>
                    <div className="mt-2 flex flex-wrap gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {t.settings.maxDomainFanOut}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={16}
                          value={maxDomainFanOut}
                          onChange={(e) => {
                            setMaxDomainFanOut(e.target.value);
                            setSaved(false);
                          }}
                          className="font-mono w-24"
                          data-testid="settings-max-domain-fanout"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {t.settings.maxLeafFanOut}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={16}
                          value={maxLeafFanOut}
                          onChange={(e) => {
                            setMaxLeafFanOut(e.target.value);
                            setSaved(false);
                          }}
                          className="font-mono w-24"
                          data-testid="settings-max-leaf-fanout"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {t.settings.reviewCouncilSize}
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={4}
                          value={reviewCouncilSize}
                          onChange={(e) => {
                            setReviewCouncilSize(e.target.value);
                            setSaved(false);
                          }}
                          className="font-mono w-24"
                          data-testid="settings-review-council-size"
                        />
                      </div>
                    </div>
                  </Field>

                  <Field>
                    <FieldLabel>{t.settings.roleModelsTitle}</FieldLabel>
                    <FieldDescription>
                      {t.settings.roleModelsHint}
                    </FieldDescription>
                    <div className="mt-2 flex flex-col gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {t.settings.rolePlanner}
                        </span>
                        <ModelSelect
                          models={models}
                          value={plannerProfileId}
                          onChange={(next) => {
                            setPlannerProfileId(next);
                            setSaved(false);
                          }}
                          defaultModelProfileId={defaultModelProfileId}
                          data-testid="settings-role-planner"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {t.settings.roleWorker}
                        </span>
                        <ModelSelect
                          models={models}
                          value={workerProfileId}
                          onChange={(next) => {
                            setWorkerProfileId(next);
                            setSaved(false);
                          }}
                          defaultModelProfileId={defaultModelProfileId}
                          data-testid="settings-role-worker"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                          {t.settings.roleWriter}
                        </span>
                        <ModelSelect
                          models={models}
                          value={writerProfileId}
                          onChange={(next) => {
                            setWriterProfileId(next);
                            setSaved(false);
                          }}
                          defaultModelProfileId={defaultModelProfileId}
                          data-testid="settings-role-writer"
                        />
                      </div>
                    </div>
                  </Field>

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
                      {submitting ? <Spinner data-icon="inline-start" /> : null}
                      {submitting ? t.settings.saving : t.settings.save}
                    </Button>
                    {saved ? (
                      <span
                        className="text-sm font-medium text-primary"
                        role="status"
                      >
                        {t.settings.saved}
                      </span>
                    ) : null}
                  </div>
                </FieldGroup>
              </form>
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
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="skill" className="outline-none">
              <Card>
                <CardContent className="flex flex-col gap-6">
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
                          toast.success(t.settings.skillForked);
                        } catch (err) {
                          setError(err);
                        } finally {
                          setSkillBusy(false);
                        }
                      })();
                    }}
                  >
                    {skillBusy ? <Spinner data-icon="inline-start" /> : null}
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
                          toast.success(t.settings.skillSaved);
                        } catch (err) {
                          setError(err);
                        } finally {
                          setSkillBusy(false);
                        }
                      })();
                    }}
                  >
                    {skillBusy ? <Spinner data-icon="inline-start" /> : null}
                    {t.settings.skillSaveFile}
                  </Button>
                </div>
                {skill?.kind === "fork" ? (
                  <FieldGroup className="gap-2">
                    <Field>
                      <FieldLabel htmlFor="settings-skill-file-path">
                        {t.settings.skillFileLabel}
                      </FieldLabel>
                      <Input
                        id="settings-skill-file-path"
                        className="font-mono"
                        value={skillFilePath}
                        onChange={(e) => setSkillFilePath(e.target.value)}
                        data-testid="settings-skill-file-path"
                      />
                    </Field>
                    <Field>
                      <Textarea
                        className="min-h-48 font-mono text-sm"
                        value={skillFileContent}
                        onChange={(e) => {
                          setSkillFileContent(e.target.value);
                          setSkillFileDirty(true);
                        }}
                        data-testid="settings-skill-file-editor"
                        spellCheck={false}
                      />
                    </Field>
                    <p className="muted small">
                      {t.settings.skillFiles}{" "}
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
                  </FieldGroup>
                ) : null}
              </section>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="danger" className="outline-none">
              <Card>
                <CardContent className="flex flex-col gap-6">
                  <section
                className="flex flex-col gap-3 rounded-md border border-destructive/30 p-4"
                data-testid="settings-danger-zone"
              >
                <h2 className="text-base font-semibold text-destructive">
                  {t.settings.dangerTitle}
                </h2>
                <p className="muted small">{t.settings.dangerDescription}</p>
                <div className="form-actions">
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={deleting}
                    onClick={() => {
                      setDeleteMeta(false);
                      setDeleteDialogOpen(true);
                    }}
                    data-testid="settings-delete-workspace"
                  >
                    {deleting ? <Spinner data-icon="inline-start" /> : null}
                    {deleting ? t.common.deleting : t.settings.deleteWorkspace}
                  </Button>
                </div>
              </section>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        ) : null}

        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            setDeleteDialogOpen(open);
            if (!open) {
              setDeleteMeta(false);
            }
          }}
          title={t.settings.deleteConfirmTitle}
          description={
            workspace
              ? formatMessage(t.settings.deleteConfirm, {
                  name: workspace.name,
                })
              : undefined
          }
          confirmLabel={
            deleting ? t.common.deleting : t.settings.deleteWorkspace
          }
          cancelLabel={t.common.cancel}
          onConfirm={() => void handleDeleteWorkspace()}
          confirmDisabled={deleting}
          data-testid="settings-delete-dialog"
          confirmTestId="settings-delete-confirm"
          metaChecked={deleteMeta}
          onMetaCheckedChange={setDeleteMeta}
          metaLabel={t.settings.deleteMeta}
          metaTestId="settings-delete-meta"
        />
    </WorkspaceShell>
  );
}
