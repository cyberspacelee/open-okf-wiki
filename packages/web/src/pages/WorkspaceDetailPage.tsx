import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getWorkspace, type WorkspaceConfig } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { useI18n } from "../i18n";
import { workspaceHref } from "../lib/workspace-path";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function WorkspaceDetailPage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

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

  const wikiLangLabel =
    (workspace?.wikiLanguage ?? "en") === "zh" ? t.detail.langZh : t.detail.langEn;

  return (
    <Layout>
      <div data-testid="workspace-detail" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">{t.detail.breadcrumb}</Link>
            <span aria-hidden="true"> / </span>
            <span>{workspace?.name ?? id}</span>
          </p>
          <h1>{workspace?.name ?? t.detail.titleFallback}</h1>
          <p>{t.detail.description}</p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label={t.detail.loading} />
        ) : workspace ? (
          <Card>
            <CardContent className="flex flex-col gap-6">
              <dl className="kv kv-grid">
                <div>
                  <dt>{t.detail.name}</dt>
                  <dd>{workspace.name}</dd>
                </div>
                <div>
                  <dt>{t.detail.id}</dt>
                  <dd className="mono muted">{workspace.id}</dd>
                </div>
                <div>
                  <dt>{t.detail.rootPath}</dt>
                  <dd className="mono">{workspace.rootPath}</dd>
                </div>
                <div>
                  <dt>{t.detail.model}</dt>
                  <dd className="mono">
                    {workspace.model.id}
                    {workspace.model.profileId ? (
                      <span className="muted small">
                        {" "}
                        · {t.detail.profile} {workspace.model.profileId}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>{t.detail.publicationPath}</dt>
                  <dd className="mono">{workspace.publicationPath}</dd>
                </div>
                <div>
                  <dt>{t.detail.wikiLanguage}</dt>
                  <dd data-testid="detail-wiki-language">{wikiLangLabel}</dd>
                </div>
                <div>
                  <dt>{t.detail.adaptive}</dt>
                  <dd>
                    <Badge variant={workspace.adaptive ? "secondary" : "outline"}>
                      {workspace.adaptive ? t.common.on : t.common.off}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt>{t.detail.reviewer}</dt>
                  <dd>
                    <Badge variant={workspace.reviewer ? "secondary" : "outline"}>
                      {workspace.reviewer ? t.common.on : t.common.off}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt>{t.detail.sources}</dt>
                  <dd>
                    {workspace.sources.length}{" "}
                    <Link
                      to={workspaceHref(workspace.id, "/sources", rootPathHint)}
                      className="inline-link"
                    >
                      {t.detail.manageSources}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt>{t.detail.created}</dt>
                  <dd className="muted">
                    {new Date(workspace.createdAt).toLocaleString()}
                  </dd>
                </div>
                {workspace.lastOpenedAt ? (
                  <div>
                    <dt>{t.detail.lastOpened}</dt>
                    <dd className="muted">
                      {new Date(workspace.lastOpenedAt).toLocaleString()}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div className="form-actions">
                <Link
                  to={workspaceHref(workspace.id, "/settings", rootPathHint)}
                  className={cn(buttonVariants({ variant: "outline" }))}
                >
                  {t.detail.editSettings}
                </Link>
                <Link
                  to={workspaceHref(workspace.id, "/sources", rootPathHint)}
                  className={cn(buttonVariants())}
                >
                  {t.detail.sourcesBtn}
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Layout>
  );
}
