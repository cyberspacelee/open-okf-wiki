import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  getProvider,
  getWorkspace,
  patchWorkspace,
  type ModelProfilePublic,
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

  const applyWorkspace = useCallback(
    (ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => {
      setWorkspace(ws);
      setName(ws.name);
      setPublicationPath(ws.publicationPath);
      setAdaptive(ws.adaptive);
      setReviewer(ws.reviewer);

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
    } catch (err) {
      setError(err);
      setWorkspace(null);
    } finally {
      setLoading(false);
    }
  }, [id, rootPathHint, applyWorkspace]);

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
