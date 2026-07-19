import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  getWorkspace,
  patchWorkspace,
  type WorkspaceConfig,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WorkspaceSettingsPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [publicationPath, setPublicationPath] = useState("");
  const [adaptive, setAdaptive] = useState(false);
  const [reviewer, setReviewer] = useState(false);

  const applyWorkspace = useCallback((ws: WorkspaceConfig) => {
    setWorkspace(ws);
    setName(ws.name);
    setModelId(ws.model.id);
    setPublicationPath(ws.publicationPath);
    setAdaptive(ws.adaptive);
    setReviewer(ws.reviewer);
  }, []);

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const data = await getWorkspace(id, rootPathHint);
      applyWorkspace(data.workspace);
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
          modelId: modelId.trim(),
          publicationPath: publicationPath.trim(),
          adaptive,
          reviewer,
        },
        workspace?.rootPath ?? rootPathHint,
      );
      applyWorkspace(result.workspace);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout>
      <div data-testid="settings-page" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">Workspaces</Link>
            <span aria-hidden="true"> / </span>
            <Link to={`/workspaces/${encodeURIComponent(id)}`}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Settings</span>
          </p>
          <h1>Workspace settings</h1>
          <p>
            Edit non-secret project configuration. Model credentials remain in environment variables.
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
                <div className="field">
                  <Label htmlFor="settings-model">Model id</Label>
                  <Input
                    id="settings-model"
                    type="text"
                    value={modelId}
                    onChange={(e) => {
                      setModelId(e.target.value);
                      setSaved(false);
                    }}
                    placeholder="openai/my-served-model"
                    required
                    className="font-mono"
                    data-testid="settings-model-input"
                  />
                  <span className="field-hint">
                    Non-secret model identity (for example <code>openai/my-served-model</code>).
                  </span>
                </div>
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
                      !modelId.trim() ||
                      !publicationPath.trim()
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
              </dl>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Layout>
  );
}
