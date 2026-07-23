import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type AppSettingsPublic,
  createModelProfile,
  type DoctorResponse,
  deleteModelProfile,
  getApiBase,
  getAppSettings,
  getDoctor,
  getHealth,
  getProvider,
  type HealthResponse,
  type ModelProfilePublic,
  type ProviderApiShape,
  type ProviderPublic,
  type ProviderTestResult,
  patchAppSettings,
  setDefaultModelProfile,
  testProvider,
  updateModelProfile,
} from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { formatMessage, useI18n } from "../i18n";

type EditorMode = "closed" | "create" | "edit";

const emptyForm = {
  name: "",
  modelId: "",
  baseUrl: "",
  apiKey: "",
  apiShape: "completions" as ProviderApiShape,
  /** Empty string means unset; digits-only string when set. */
  maxContextTokens: "",
  /** Provider-level User-Agent (default node for gateway WAF). */
  userAgent: "node",
  /**
   * When true, allow OpenAI `developer` role (official OpenAI).
   * Default false — third-party gateways often reject it.
   */
  supportsDeveloperRole: false,
  /** When adding under an existing provider. */
  providerId: "",
  clearApiKey: false,
};

export function SettingsPage() {
  const { t } = useI18n();
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [provider, setProvider] = useState<ProviderPublic | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettingsPublic | null>(null);
  const [skillsSaving, setSkillsSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const [editorMode, setEditorMode] = useState<EditorMode>("closed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProfilePublic | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  function setStatus(message: string) {
    setStatusMsg(message);
    toast.success(message);
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [doctorData, providerData, settingsData] = await Promise.all([
        getDoctor(),
        getProvider(),
        getAppSettings(),
      ]);
      setDoctor(doctorData);
      setProvider(providerData.provider);
      setAppSettings(settingsData.settings);
    } catch (err) {
      setError(err);
      setDoctor(null);
      setProvider(null);
      setAppSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleToggleHomeSkills(next: boolean) {
    setSkillsSaving(true);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await patchAppSettings({ loadHomeSkills: next });
      setAppSettings(result.settings);
      setStatus(t.globalSettings.skillsSaved);
    } catch (err) {
      setError(err);
    } finally {
      setSkillsSaving(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function openCreate() {
    setEditorMode("create");
    setEditingId(null);
    setForm(emptyForm);
    setTestResult(null);
    setStatusMsg(null);
  }

  function openEdit(model: ModelProfilePublic) {
    setEditorMode("edit");
    setEditingId(model.id);
    setForm({
      name: model.name,
      modelId: model.modelId,
      baseUrl: model.baseUrl,
      apiKey: "",
      apiShape: model.apiShape,
      maxContextTokens: model.maxContextTokens !== undefined ? String(model.maxContextTokens) : "",
      userAgent: model.headers?.["User-Agent"] ?? model.headers?.["user-agent"] ?? "node",
      supportsDeveloperRole: model.supportsDeveloperRole === true,
      providerId: model.providerId ?? "",
      clearApiKey: false,
    });
    setTestResult(null);
    setStatusMsg(null);
  }

  function openCreateUnderProvider(
    providerId: string,
    baseUrl: string,
    apiShape: ProviderApiShape,
  ) {
    setEditorMode("create");
    setEditingId(null);
    setForm({
      ...emptyForm,
      providerId,
      baseUrl,
      apiShape,
    });
    setTestResult(null);
    setStatusMsg(null);
  }

  function closeEditor() {
    setEditorMode("closed");
    setEditingId(null);
    setForm(emptyForm);
    setTestResult(null);
  }

  async function handleHealthCheck() {
    setCheckingHealth(true);
    setError(null);
    try {
      setHealth(await getHealth());
    } catch (err) {
      setHealth(null);
      setError(err);
    } finally {
      setCheckingHealth(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatusMsg(null);
    setTestResult(null);
    try {
      const maxContextRaw = form.maxContextTokens.trim();
      let maxContextTokens: number | null | undefined;
      if (maxContextRaw === "") {
        // Create: omit (unset). Edit: clear stored value.
        maxContextTokens = editorMode === "edit" ? null : undefined;
      } else {
        const parsed = Number(maxContextRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          setError(new Error("maxContextTokens must be a positive integer"));
          setSaving(false);
          return;
        }
        maxContextTokens = parsed;
      }
      const ua = form.userAgent.trim();
      const headers = ua ? { "User-Agent": ua } : null;
      const payload = {
        name: form.name.trim(),
        modelId: form.modelId.trim(),
        baseUrl: form.baseUrl.trim(),
        apiShape: form.apiShape,
        ...(form.providerId.trim() ? { providerId: form.providerId.trim() } : {}),
        ...(form.clearApiKey
          ? { apiKey: null as null }
          : form.apiKey.trim()
            ? { apiKey: form.apiKey.trim() }
            : {}),
        ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
        headers,
        supportsDeveloperRole: form.supportsDeveloperRole,
      };
      const result =
        editorMode === "edit" && editingId
          ? await updateModelProfile(editingId, payload)
          : await createModelProfile(payload);
      setProvider(result.provider);
      setStatus(
        editorMode === "edit"
          ? t.globalSettings.statusModelUpdated
          : t.globalSettings.statusModelAdded,
      );
      closeEditor();
      try {
        setDoctor(await getDoctor());
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) {
      return;
    }
    const model = deleteTarget;
    setDeletingId(model.id);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await deleteModelProfile(model.id);
      setProvider(result.provider);
      if (editingId === model.id) {
        closeEditor();
      }
      setStatus(t.globalSettings.statusModelDeleted);
    } catch (err) {
      setError(err);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSetDefault(model: ModelProfilePublic) {
    setError(null);
    setStatusMsg(null);
    try {
      const result = await setDefaultModelProfile(model.id);
      setProvider(result.provider);
      setStatus(formatMessage(t.globalSettings.statusDefault, { name: model.name }));
    } catch (err) {
      setError(err);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const ua = form.userAgent.trim();
      const result = await testProvider({
        modelProfileId: editingId ?? undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.clearApiKey ? "" : form.apiKey.trim() || undefined,
        apiShape: form.apiShape,
        modelId: form.modelId.trim() || undefined,
        ...(ua ? { headers: { "User-Agent": ua } } : {}),
      });
      setTestResult(result.result);
    } catch (err) {
      setError(err);
    } finally {
      setTesting(false);
    }
  }

  const models = provider?.models ?? [];

  return (
    <Layout>
      <div data-testid="global-settings-page" className="flex flex-col gap-5">
        <header className="page-header row-between">
          <div>
            <h1>{t.globalSettings.title}</h1>
            <p>{t.globalSettings.description}</p>
          </div>
          <div className="row-actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadAll()}
              disabled={loading}
            >
              {t.globalSettings.refresh}
            </Button>
            <Button
              type="button"
              onClick={openCreate}
              disabled={loading || editorMode !== "closed"}
              data-testid="model-add"
            >
              {t.globalSettings.addModel}
            </Button>
          </div>
        </header>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        {statusMsg ? (
          <p
            className="text-sm font-medium text-primary"
            role="status"
            data-testid="settings-status"
          >
            {statusMsg}
          </p>
        ) : null}

        {loading ? (
          <LoadingState label={t.globalSettings.loading} />
        ) : (
          <>
            <Tabs defaultValue="models" className="w-full">
              <TabsList variant="line" className="mb-2 w-full justify-start">
                <TabsTrigger value="models" data-testid="settings-tab-models">
                  {t.globalSettings.tabModels}
                </TabsTrigger>
                <TabsTrigger value="app" data-testid="settings-tab-app">
                  {t.globalSettings.tabApp}
                </TabsTrigger>
                <TabsTrigger value="diagnostics" data-testid="settings-tab-diagnostics">
                  {t.globalSettings.tabDiagnostics}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="app" className="flex flex-col gap-4 outline-none">
                <Card data-testid="home-skills-panel">
                  <CardHeader>
                    <CardTitle>{t.globalSettings.skillsTitle}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <p className="muted small">{t.globalSettings.skillsDescription}</p>
                    {appSettings ? (
                      <>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="settings-load-home-skills">
                              {t.globalSettings.loadHomeSkills}
                            </FieldLabel>
                            <FieldDescription>
                              {t.globalSettings.loadHomeSkillsHint}
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="settings-load-home-skills"
                            checked={appSettings.loadHomeSkills}
                            disabled={skillsSaving}
                            data-testid="settings-load-home-skills"
                            onCheckedChange={(checked) => {
                              void handleToggleHomeSkills(checked);
                            }}
                          />
                        </Field>
                        <dl className="kv">
                          <div>
                            <dt>{t.globalSettings.homeSkillsPath}</dt>
                            <dd className="mono small whitespace-normal">
                              {appSettings.homeSkillsDir}
                            </dd>
                          </div>
                          <div>
                            <dt>{t.globalSettings.workspaceSkillsPath}</dt>
                            <dd className="mono small whitespace-normal">
                              {"{workspace}/"}
                              {appSettings.workspaceSkillsRelative}
                            </dd>
                          </div>
                        </dl>
                        {skillsSaving ? (
                          <p className="muted small">{t.globalSettings.skillsSaving}</p>
                        ) : null}
                      </>
                    ) : (
                      <p className="muted small">{t.globalSettings.appSettingsUnavailable}</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="models" className="flex flex-col gap-4 outline-none">
                <Card data-testid="provider-panel">
                  <CardHeader className="row-between items-center">
                    <div className="flex flex-col gap-1">
                      <CardTitle>{t.globalSettings.modelsTitle}</CardTitle>
                      <p className="muted small max-w-2xl">{t.globalSettings.providersHint}</p>
                    </div>
                    <span className="muted small shrink-0">
                      {formatMessage(t.globalSettings.modelsCount, { n: models.length })}
                      {provider?.defaultModelProfileId
                        ? ` · ${t.globalSettings.defaultSet}`
                        : models.length > 0
                          ? ` · ${t.globalSettings.noDefault}`
                          : ""}
                    </span>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    {models.length === 0 ? (
                      <p className="muted" data-testid="models-empty">
                        {t.globalSettings.modelsEmpty}
                      </p>
                    ) : (
                      <div className="flex flex-col gap-4" data-testid="providers-list">
                        {(provider?.providers?.length ? provider.providers : []).map((entry) => (
                          <Card
                            key={entry.id}
                            className="border-border/80"
                            data-testid="provider-card"
                            data-provider-id={entry.id}
                          >
                            <CardHeader className="row-between items-start py-3">
                              <div className="min-w-0 flex flex-col gap-0.5">
                                <CardTitle className="text-base">{entry.name}</CardTitle>
                                <p className="mono small muted truncate">{entry.baseUrl || "—"}</p>
                                <p className="small muted">
                                  {entry.apiShape}
                                  {" · "}
                                  {entry.apiKeySet
                                    ? (entry.apiKeyMasked ?? t.globalSettings.keySet)
                                    : "—"}
                                  {entry.headers?.["User-Agent"]
                                    ? ` · UA=${entry.headers["User-Agent"]}`
                                    : ""}
                                  {entry.supportsDeveloperRole
                                    ? ` · ${t.globalSettings.developerRoleOn}`
                                    : ""}
                                </p>
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  openCreateUnderProvider(entry.id, entry.baseUrl, entry.apiShape)
                                }
                                data-testid="provider-add-model"
                              >
                                {t.globalSettings.addModelUnderProvider}
                              </Button>
                            </CardHeader>
                            <CardContent className="pt-0">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>{t.globalSettings.colName}</TableHead>
                                    <TableHead>{t.globalSettings.colModelId}</TableHead>
                                    <TableHead>{t.globalSettings.colMaxContext}</TableHead>
                                    <TableHead className="text-right">
                                      {t.globalSettings.colActions}
                                    </TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {entry.models.map((m) => {
                                    const model = models.find((x) => x.id === m.id);
                                    if (!model) return null;
                                    const isDefault = provider?.defaultModelProfileId === model.id;
                                    return (
                                      <TableRow
                                        key={model.id}
                                        data-testid="model-row"
                                        data-model-id={model.id}
                                      >
                                        <TableCell>
                                          <span className="font-medium">{model.name}</span>
                                          {isDefault ? (
                                            <Badge variant="secondary" className="ml-2">
                                              {t.globalSettings.defaultBadge}
                                            </Badge>
                                          ) : null}
                                        </TableCell>
                                        <TableCell className="mono small">
                                          {model.modelId}
                                        </TableCell>
                                        <TableCell className="mono small">
                                          {model.maxContextTokens !== undefined
                                            ? model.maxContextTokens.toLocaleString()
                                            : "—"}
                                        </TableCell>
                                        <TableCell className="actions-cell">
                                          <div className="row-actions justify-end">
                                            {!isDefault ? (
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => void handleSetDefault(model)}
                                                data-testid="model-set-default"
                                              >
                                                {t.globalSettings.setDefault}
                                              </Button>
                                            ) : null}
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              onClick={() => openEdit(model)}
                                              data-testid="model-edit"
                                            >
                                              {t.globalSettings.edit}
                                            </Button>
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="destructive"
                                              disabled={deletingId === model.id}
                                              onClick={() => setDeleteTarget(model)}
                                              data-testid="model-delete"
                                            >
                                              {deletingId === model.id ? (
                                                <Spinner data-icon="inline-start" />
                                              ) : null}
                                              {deletingId === model.id
                                                ? "…"
                                                : t.globalSettings.delete}
                                            </Button>
                                          </div>
                                        </TableCell>
                                      </TableRow>
                                    );
                                  })}
                                </TableBody>
                              </Table>
                            </CardContent>
                          </Card>
                        ))}
                        {/* Fallback flat table if providers empty but models exist */}
                        {!provider?.providers?.length && models.length > 0 ? (
                          <Table data-testid="models-table">
                            <TableHeader>
                              <TableRow>
                                <TableHead>{t.globalSettings.colName}</TableHead>
                                <TableHead>{t.globalSettings.colModelId}</TableHead>
                                <TableHead>{t.globalSettings.colBaseUrl}</TableHead>
                                <TableHead className="text-right">
                                  {t.globalSettings.colActions}
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {models.map((model) => (
                                <TableRow key={model.id} data-testid="model-row">
                                  <TableCell>{model.name}</TableCell>
                                  <TableCell className="mono small">{model.modelId}</TableCell>
                                  <TableCell className="mono small">{model.baseUrl}</TableCell>
                                  <TableCell className="text-right">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() => openEdit(model)}
                                    >
                                      {t.globalSettings.edit}
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        ) : null}
                      </div>
                    )}

                    {provider ? (
                      <p className="muted small">
                        {formatMessage(t.globalSettings.envFallback, {
                          base: provider.envFallback.openaiBaseUrlSet
                            ? t.globalSettings.envSet
                            : t.globalSettings.envUnset,
                          key: provider.envFallback.openaiApiKeySet
                            ? t.globalSettings.envSet
                            : t.globalSettings.envUnset,
                        })}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>

                {editorMode !== "closed" ? (
                  <Card data-testid="model-editor">
                    <CardHeader className="row-between items-center">
                      <CardTitle>
                        {editorMode === "create"
                          ? t.globalSettings.editorCreateTitle
                          : t.globalSettings.editorEditTitle}
                      </CardTitle>
                      <Button type="button" variant="ghost" size="sm" onClick={closeEditor}>
                        {t.common.cancel}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <form className="form form-wide" onSubmit={(e) => void handleSave(e)}>
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor="model-name">
                              {t.globalSettings.displayName}
                            </FieldLabel>
                            <Input
                              id="model-name"
                              value={form.name}
                              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                              placeholder={t.globalSettings.displayNamePlaceholder}
                              required
                              maxLength={120}
                              data-testid="model-name-input"
                              autoFocus
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="model-id">
                              {t.globalSettings.modelIdLabel}
                            </FieldLabel>
                            <Input
                              id="model-id"
                              value={form.modelId}
                              onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
                              placeholder={t.globalSettings.modelIdPlaceholder}
                              required
                              className="font-mono"
                              data-testid="model-id-input"
                            />
                            <FieldDescription>{t.globalSettings.modelIdHint}</FieldDescription>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="model-base-url">
                              {t.globalSettings.baseUrl}
                            </FieldLabel>
                            <Input
                              id="model-base-url"
                              type="url"
                              value={form.baseUrl}
                              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                              placeholder={t.globalSettings.baseUrlPlaceholder}
                              className="font-mono"
                              data-testid="model-base-url"
                              autoComplete="off"
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="model-api-key">
                              {t.globalSettings.apiKey}
                            </FieldLabel>
                            <Input
                              id="model-api-key"
                              type="password"
                              value={form.apiKey}
                              onChange={(e) =>
                                setForm((f) => ({
                                  ...f,
                                  apiKey: e.target.value,
                                  clearApiKey: false,
                                }))
                              }
                              placeholder={
                                editorMode === "edit" && editingId
                                  ? t.globalSettings.apiKeyKeepPlaceholder
                                  : t.globalSettings.apiKeyPlaceholder
                              }
                              className="font-mono"
                              data-testid="model-api-key"
                              autoComplete="off"
                              disabled={form.clearApiKey}
                            />
                            {editorMode === "edit" ? (
                              <Field orientation="horizontal" className="mt-1">
                                <Checkbox
                                  id="model-clear-key"
                                  checked={form.clearApiKey}
                                  onCheckedChange={(checked) =>
                                    setForm((f) => ({
                                      ...f,
                                      clearApiKey: checked === true,
                                      apiKey: checked === true ? "" : f.apiKey,
                                    }))
                                  }
                                  data-testid="model-clear-key"
                                />
                                <FieldLabel htmlFor="model-clear-key" className="font-normal">
                                  {t.globalSettings.clearApiKey}
                                </FieldLabel>
                              </Field>
                            ) : null}
                          </Field>
                          <FieldSet>
                            <FieldLegend variant="label">{t.globalSettings.apiShape}</FieldLegend>
                            <RadioGroup
                              value={form.apiShape}
                              onValueChange={(next) => {
                                if (next === "completions" || next === "responses") {
                                  setForm((f) => ({
                                    ...f,
                                    apiShape: next as ProviderApiShape,
                                  }));
                                }
                              }}
                              aria-label={t.globalSettings.apiShape}
                              className="gap-3"
                            >
                              <Field orientation="horizontal">
                                <RadioGroupItem
                                  value="completions"
                                  id="model-shape-completions"
                                  data-testid="model-shape-completions"
                                />
                                <FieldContent>
                                  <FieldLabel htmlFor="model-shape-completions">
                                    {t.globalSettings.shapeCompletions}
                                  </FieldLabel>
                                  <FieldDescription>
                                    <code>POST …/v1/chat/completions</code>
                                  </FieldDescription>
                                </FieldContent>
                              </Field>
                              <Field orientation="horizontal">
                                <RadioGroupItem
                                  value="responses"
                                  id="model-shape-responses"
                                  data-testid="model-shape-responses"
                                />
                                <FieldContent>
                                  <FieldLabel htmlFor="model-shape-responses">
                                    {t.globalSettings.shapeResponses}
                                  </FieldLabel>
                                  <FieldDescription>
                                    <code>POST …/v1/responses</code>
                                  </FieldDescription>
                                </FieldContent>
                              </Field>
                            </RadioGroup>
                          </FieldSet>
                          <Field>
                            <FieldLabel htmlFor="model-max-context">
                              {t.globalSettings.maxContextTokens}
                            </FieldLabel>
                            <Input
                              id="model-max-context"
                              type="number"
                              min={1}
                              step={1}
                              value={form.maxContextTokens}
                              onChange={(e) =>
                                setForm((f) => ({
                                  ...f,
                                  maxContextTokens: e.target.value,
                                }))
                              }
                              placeholder={t.globalSettings.maxContextTokensPlaceholder}
                              className="font-mono max-w-xs"
                              data-testid="model-max-context"
                            />
                            <FieldDescription>
                              {t.globalSettings.maxContextTokensHint}
                            </FieldDescription>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="model-user-agent">
                              {t.globalSettings.userAgent}
                            </FieldLabel>
                            <Input
                              id="model-user-agent"
                              value={form.userAgent}
                              onChange={(e) =>
                                setForm((f) => ({
                                  ...f,
                                  userAgent: e.target.value,
                                }))
                              }
                              placeholder="node"
                              className="font-mono"
                              data-testid="model-user-agent"
                              autoComplete="off"
                            />
                            <FieldDescription>{t.globalSettings.userAgentHint}</FieldDescription>
                          </Field>
                          <Field orientation="horizontal">
                            <Checkbox
                              id="model-developer-role"
                              checked={form.supportsDeveloperRole}
                              onCheckedChange={(checked) =>
                                setForm((f) => ({
                                  ...f,
                                  supportsDeveloperRole: checked === true,
                                }))
                              }
                              data-testid="model-developer-role"
                            />
                            <FieldContent>
                              <FieldLabel htmlFor="model-developer-role" className="font-normal">
                                {t.globalSettings.supportsDeveloperRole}
                              </FieldLabel>
                              <FieldDescription>
                                {t.globalSettings.supportsDeveloperRoleHint}
                              </FieldDescription>
                            </FieldContent>
                          </Field>
                          {form.providerId ? (
                            <p className="muted small" data-testid="model-provider-hint">
                              {formatMessage(t.globalSettings.addingUnderProvider, {
                                id: form.providerId,
                              })}
                            </p>
                          ) : null}
                          <div className="form-actions">
                            <Button
                              type="submit"
                              disabled={saving || !form.name.trim() || !form.modelId.trim()}
                              data-testid="model-save"
                            >
                              {saving ? <Spinner data-icon="inline-start" /> : null}
                              {saving
                                ? t.globalSettings.saving
                                : editorMode === "create"
                                  ? t.globalSettings.saveCreate
                                  : t.globalSettings.saveEdit}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={testing || !form.baseUrl.trim()}
                              onClick={() => void handleTest()}
                              data-testid="model-test"
                            >
                              {testing ? <Spinner data-icon="inline-start" /> : null}
                              {testing ? t.globalSettings.testing : t.globalSettings.testConnection}
                            </Button>
                          </div>
                          {testResult ? (
                            <div
                              className={
                                testResult.ok
                                  ? "provider-test-result ok"
                                  : "provider-test-result fail"
                              }
                              data-testid="provider-test-result"
                              role="status"
                            >
                              <Badge variant={testResult.ok ? "secondary" : "destructive"}>
                                {testResult.ok
                                  ? t.globalSettings.testOk
                                  : t.globalSettings.testFail}
                              </Badge>
                              <span className="mono small">
                                {testResult.message}
                                {testResult.latencyMs !== undefined
                                  ? ` · ${testResult.latencyMs}ms`
                                  : ""}
                              </span>
                            </div>
                          ) : null}
                        </FieldGroup>
                      </form>
                    </CardContent>
                  </Card>
                ) : null}
              </TabsContent>

              <TabsContent value="diagnostics" className="flex flex-col gap-4 outline-none">
                <Card data-testid="health-panel">
                  <CardHeader>
                    <CardTitle>{t.globalSettings.healthTitle}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <dl className="kv">
                      <div>
                        <dt>{t.globalSettings.apiBase}</dt>
                        <dd className="mono">
                          {getApiBase() || t.globalSettings.apiBaseSameOrigin}
                        </dd>
                      </div>
                      <div>
                        <dt>{t.globalSettings.health}</dt>
                        <dd>
                          {health ? (
                            <Badge
                              variant={health.ok ? "secondary" : "destructive"}
                              data-testid="health-status"
                            >
                              {health.ok
                                ? formatMessage(t.globalSettings.healthOk, {
                                    service: health.service,
                                  })
                                : t.globalSettings.healthNotOk}
                            </Badge>
                          ) : (
                            <span className="muted">{t.globalSettings.healthNotChecked}</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                    <div className="form-actions">
                      <Button
                        type="button"
                        onClick={() => void handleHealthCheck()}
                        disabled={checkingHealth}
                      >
                        {checkingHealth ? <Spinner data-icon="inline-start" /> : null}
                        {checkingHealth
                          ? t.globalSettings.checking
                          : t.globalSettings.runHealthCheck}
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {doctor ? (
                  <Card data-testid="doctor-panel">
                    <CardHeader>
                      <CardTitle>{t.globalSettings.doctorTitle}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <dl className="kv kv-grid">
                        <div>
                          <dt>{t.globalSettings.status}</dt>
                          <dd>
                            <Badge
                              variant={doctor.ok ? "secondary" : "destructive"}
                              data-testid="doctor-status"
                            >
                              {doctor.ok ? t.globalSettings.statusOk : t.globalSettings.statusNotOk}
                            </Badge>
                          </dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.node}</dt>
                          <dd className="mono">{doctor.node}</dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.platform}</dt>
                          <dd className="mono">
                            {doctor.platform}/{doctor.arch}
                          </dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.git}</dt>
                          <dd>
                            {doctor.git.available ? (
                              <Badge variant="secondary">
                                {t.globalSettings.gitAvailable}
                                {doctor.git.version ? ` · ${doctor.git.version}` : ""}
                              </Badge>
                            ) : (
                              <Badge variant="destructive">{t.globalSettings.gitUnavailable}</Badge>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.doctorModels}</dt>
                          <dd>
                            {doctor.provider ? (
                              <Badge
                                variant={doctor.provider.configured ? "secondary" : "outline"}
                                data-testid="doctor-provider-status"
                              >
                                {formatMessage(t.globalSettings.doctorModelsConfigured, {
                                  n: doctor.provider.modelCount ?? 0,
                                })}
                                {doctor.provider.configured
                                  ? ""
                                  : ` · ${t.globalSettings.doctorNoCredentials}`}
                              </Badge>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </dd>
                        </div>
                      </dl>
                    </CardContent>
                  </Card>
                ) : null}
              </TabsContent>
            </Tabs>

            <ConfirmDialog
              open={deleteTarget != null}
              onOpenChange={(open) => {
                if (!open) {
                  setDeleteTarget(null);
                }
              }}
              title={t.globalSettings.deleteConfirmTitle}
              description={
                deleteTarget
                  ? formatMessage(t.globalSettings.deleteConfirmBody, {
                      name: deleteTarget.name,
                    })
                  : undefined
              }
              confirmLabel={
                deletingId != null ? t.globalSettings.deleting : t.globalSettings.deleteSubmit
              }
              cancelLabel={t.common.cancel}
              onConfirm={() => void handleDeleteConfirm()}
              confirmDisabled={deletingId != null}
              data-testid="model-delete-dialog"
              confirmTestId="model-delete-confirm"
            />
          </>
        )}
      </div>
    </Layout>
  );
}
