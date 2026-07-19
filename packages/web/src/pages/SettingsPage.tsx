import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createModelProfile,
  deleteModelProfile,
  getApiBase,
  getDoctor,
  getHealth,
  getProvider,
  setDefaultModelProfile,
  testProvider,
  updateModelProfile,
  type DoctorResponse,
  type HealthResponse,
  type ModelProfilePublic,
  type ProviderApiShape,
  type ProviderPublic,
  type ProviderTestResult,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { Badge } from "@/components/ui/badge";
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

type EditorMode = "closed" | "create" | "edit";

const emptyForm = {
  name: "",
  modelId: "",
  baseUrl: "",
  apiKey: "",
  apiShape: "completions" as ProviderApiShape,
  clearApiKey: false,
};

export function SettingsPage() {
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [provider, setProvider] = useState<ProviderPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const [editorMode, setEditorMode] = useState<EditorMode>("closed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [doctorData, providerData] = await Promise.all([getDoctor(), getProvider()]);
      setDoctor(doctorData);
      setProvider(providerData.provider);
    } catch (err) {
      setError(err);
      setDoctor(null);
      setProvider(null);
    } finally {
      setLoading(false);
    }
  }, []);

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
      clearApiKey: false,
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
      const payload = {
        name: form.name.trim(),
        modelId: form.modelId.trim(),
        baseUrl: form.baseUrl.trim(),
        apiShape: form.apiShape,
        ...(form.clearApiKey
          ? { apiKey: null as null }
          : form.apiKey.trim()
            ? { apiKey: form.apiKey.trim() }
            : {}),
      };
      const result =
        editorMode === "edit" && editingId
          ? await updateModelProfile(editingId, payload)
          : await createModelProfile(payload);
      setProvider(result.provider);
      setStatusMsg(editorMode === "edit" ? "Model updated" : "Model added");
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

  async function handleDelete(model: ModelProfilePublic) {
    if (!window.confirm(`Delete model “${model.name}”? Workspaces that selected it keep the last known model id.`)) {
      return;
    }
    setDeletingId(model.id);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await deleteModelProfile(model.id);
      setProvider(result.provider);
      if (editingId === model.id) {
        closeEditor();
      }
      setStatusMsg("Model deleted");
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
      setStatusMsg(`Default: ${model.name}`);
    } catch (err) {
      setError(err);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await testProvider({
        modelProfileId: editingId ?? undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.clearApiKey ? "" : form.apiKey.trim() || undefined,
        apiShape: form.apiShape,
        modelId: form.modelId.trim() || undefined,
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
            <h1>Settings</h1>
            <p>
              Configure OpenAI-compatible models here. Workspaces only pick a model from this list —
              base URL and API keys are never stored in workspace.json.
            </p>
          </div>
          <div className="row-actions">
            <Button type="button" variant="outline" onClick={() => void loadAll()} disabled={loading}>
              Refresh
            </Button>
            <Button
              type="button"
              onClick={openCreate}
              disabled={loading || editorMode !== "closed"}
              data-testid="model-add"
            >
              Add model
            </Button>
          </div>
        </header>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        {statusMsg ? (
          <p className="success-text" role="status" data-testid="settings-status">
            {statusMsg}
          </p>
        ) : null}

        {loading ? (
          <LoadingState label="Loading settings…" />
        ) : (
          <>
            <Card data-testid="provider-panel">
              <CardHeader className="row-between items-center">
                <CardTitle>Models</CardTitle>
                <span className="muted small">
                  {models.length} configured
                  {provider?.defaultModelProfileId
                    ? ` · default set`
                    : models.length > 0
                      ? " · no default"
                      : ""}
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {models.length === 0 ? (
                  <p className="muted" data-testid="models-empty">
                    No models yet. Add at least one OpenAI-compatible model, then select it when
                    creating a workspace.
                  </p>
                ) : (
                  <Table data-testid="models-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Model id</TableHead>
                        <TableHead>Shape</TableHead>
                        <TableHead>Base URL</TableHead>
                        <TableHead>Key</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {models.map((model) => {
                        const isDefault = provider?.defaultModelProfileId === model.id;
                        return (
                          <TableRow key={model.id} data-testid="model-row" data-model-id={model.id}>
                            <TableCell>
                              <span className="font-medium">{model.name}</span>
                              {isDefault ? (
                                <Badge variant="secondary" className="ml-2">
                                  default
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="mono small">{model.modelId}</TableCell>
                            <TableCell className="small">{model.apiShape}</TableCell>
                            <TableCell className="mono small muted whitespace-normal">
                              {model.baseUrl || "—"}
                            </TableCell>
                            <TableCell className="mono small">
                              {model.apiKeySet ? model.apiKeyMasked ?? "set" : "—"}
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
                                    Set default
                                  </Button>
                                ) : null}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openEdit(model)}
                                  data-testid="model-edit"
                                >
                                  Edit
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="destructive"
                                  disabled={deletingId === model.id}
                                  onClick={() => void handleDelete(model)}
                                  data-testid="model-delete"
                                >
                                  {deletingId === model.id ? "…" : "Delete"}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}

                {provider ? (
                  <p className="muted small">
                    Env fallback: OPENAI_BASE_URL=
                    {provider.envFallback.openaiBaseUrlSet ? "set" : "unset"} · OPENAI_API_KEY=
                    {provider.envFallback.openaiApiKeySet ? "set" : "unset"}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {editorMode !== "closed" ? (
              <Card data-testid="model-editor">
                <CardHeader className="row-between items-center">
                  <CardTitle>
                    {editorMode === "create" ? "Add model" : "Edit model"}
                  </CardTitle>
                  <Button type="button" variant="ghost" size="sm" onClick={closeEditor}>
                    Cancel
                  </Button>
                </CardHeader>
                <CardContent>
                  <form className="form form-wide" onSubmit={(e) => void handleSave(e)}>
                    <div className="field">
                      <Label htmlFor="model-name">Display name</Label>
                      <Input
                        id="model-name"
                        value={form.name}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="Corp GPT-4o"
                        required
                        maxLength={120}
                        data-testid="model-name-input"
                        autoFocus
                      />
                    </div>
                    <div className="field">
                      <Label htmlFor="model-id">Model id</Label>
                      <Input
                        id="model-id"
                        value={form.modelId}
                        onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
                        placeholder="openai/my-served-model"
                        required
                        className="font-mono"
                        data-testid="model-id-input"
                      />
                      <span className="field-hint">
                        Served identity sent to the gateway (Mastra form{" "}
                        <code>provider/model</code>).
                      </span>
                    </div>
                    <div className="field">
                      <Label htmlFor="model-base-url">Base URL</Label>
                      <Input
                        id="model-base-url"
                        type="url"
                        value={form.baseUrl}
                        onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                        placeholder="https://gateway.example.com/v1"
                        className="font-mono"
                        data-testid="model-base-url"
                        autoComplete="off"
                      />
                    </div>
                    <div className="field">
                      <Label htmlFor="model-api-key">API key</Label>
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
                            ? "Leave blank to keep stored key"
                            : "sk-… or gateway token"
                        }
                        className="font-mono"
                        data-testid="model-api-key"
                        autoComplete="off"
                        disabled={form.clearApiKey}
                      />
                      {editorMode === "edit" ? (
                        <label className="field checkbox-field mt-1">
                          <input
                            type="checkbox"
                            checked={form.clearApiKey}
                            onChange={(e) =>
                              setForm((f) => ({
                                ...f,
                                clearApiKey: e.target.checked,
                                apiKey: e.target.checked ? "" : f.apiKey,
                              }))
                            }
                            data-testid="model-clear-key"
                          />
                          <span>
                            <strong>Clear stored API key</strong>
                          </span>
                        </label>
                      ) : null}
                    </div>
                    <fieldset className="field">
                      <legend className="text-sm font-medium">API shape</legend>
                      <div className="radio-row" role="radiogroup" aria-label="API shape">
                        <label className="radio-option">
                          <input
                            type="radio"
                            name="api-shape"
                            value="completions"
                            checked={form.apiShape === "completions"}
                            onChange={() =>
                              setForm((f) => ({ ...f, apiShape: "completions" }))
                            }
                            data-testid="model-shape-completions"
                          />
                          <span>
                            <strong>Chat Completions</strong>
                            <span className="field-hint">
                              <code>POST …/v1/chat/completions</code>
                            </span>
                          </span>
                        </label>
                        <label className="radio-option">
                          <input
                            type="radio"
                            name="api-shape"
                            value="responses"
                            checked={form.apiShape === "responses"}
                            onChange={() =>
                              setForm((f) => ({ ...f, apiShape: "responses" }))
                            }
                            data-testid="model-shape-responses"
                          />
                          <span>
                            <strong>Responses</strong>
                            <span className="field-hint">
                              <code>POST …/v1/responses</code>
                            </span>
                          </span>
                        </label>
                      </div>
                    </fieldset>
                    <div className="form-actions">
                      <Button
                        type="submit"
                        disabled={
                          saving || !form.name.trim() || !form.modelId.trim()
                        }
                        data-testid="model-save"
                      >
                        {saving
                          ? "Saving…"
                          : editorMode === "create"
                            ? "Add model"
                            : "Save changes"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={testing || !form.baseUrl.trim()}
                        onClick={() => void handleTest()}
                        data-testid="model-test"
                      >
                        {testing ? "Testing…" : "Test connection"}
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
                          {testResult.ok ? "reachable" : "failed"}
                        </Badge>
                        <span className="mono small">
                          {testResult.message}
                          {testResult.latencyMs !== undefined
                            ? ` · ${testResult.latencyMs}ms`
                            : ""}
                        </span>
                      </div>
                    ) : null}
                  </form>
                </CardContent>
              </Card>
            ) : null}

            <Card data-testid="health-panel">
              <CardHeader>
                <CardTitle>API connection</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <dl className="kv">
                  <div>
                    <dt>API base</dt>
                    <dd className="mono">{getApiBase() || "(same origin)"}</dd>
                  </div>
                  <div>
                    <dt>Health</dt>
                    <dd>
                      {health ? (
                        <Badge
                          variant={health.ok ? "secondary" : "destructive"}
                          data-testid="health-status"
                        >
                          {health.ok ? `ok · ${health.service}` : "not ok"}
                        </Badge>
                      ) : (
                        <span className="muted">Not checked yet</span>
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
                    {checkingHealth ? "Checking…" : "Run health check"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {doctor ? (
              <Card data-testid="doctor-panel">
                <CardHeader>
                  <CardTitle>Doctor</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <dl className="kv kv-grid">
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <Badge
                          variant={doctor.ok ? "secondary" : "destructive"}
                          data-testid="doctor-status"
                        >
                          {doctor.ok ? "ok" : "not ok"}
                        </Badge>
                      </dd>
                    </div>
                    <div>
                      <dt>Node</dt>
                      <dd className="mono">{doctor.node}</dd>
                    </div>
                    <div>
                      <dt>Platform</dt>
                      <dd className="mono">
                        {doctor.platform}/{doctor.arch}
                      </dd>
                    </div>
                    <div>
                      <dt>Git</dt>
                      <dd>
                        {doctor.git.available ? (
                          <Badge variant="secondary">
                            available{doctor.git.version ? ` · ${doctor.git.version}` : ""}
                          </Badge>
                        ) : (
                          <Badge variant="destructive">unavailable</Badge>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Models</dt>
                      <dd>
                        {doctor.provider ? (
                          <Badge
                            variant={doctor.provider.configured ? "secondary" : "outline"}
                            data-testid="doctor-provider-status"
                          >
                            {doctor.provider.modelCount ?? 0} configured
                            {doctor.provider.configured ? "" : " · no credentials"}
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
          </>
        )}
      </div>
    </Layout>
  );
}
