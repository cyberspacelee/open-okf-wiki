import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getWorkspace, type WorkspaceConfig } from "../api";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { useI18n } from "../i18n";
import { workspaceHref } from "../lib/workspace-path";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    <WorkspaceShell
      workspaceId={id}
      workspaceName={workspace?.name}
      title={workspace?.name ?? t.detail.titleFallback}
      description={t.detail.description}
      error={error}
      onDismissError={() => setError(null)}
      testId="workspace-detail"
    >
      {loading ? (
        <LoadingState label={t.detail.loading} />
      ) : workspace ? (
        <div className="flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card size="sm">
              <CardHeader>
                <CardDescription>{t.detail.statusSourcesTitle}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {workspace.sources.length}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {workspace.sources.length === 0
                  ? t.detail.statusSourcesEmpty
                  : t.detail.manageSources}
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>{t.detail.statusModelTitle}</CardDescription>
                <CardTitle className="truncate font-mono text-base">
                  {workspace.model.id}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {workspace.model.profileId
                  ? `${t.detail.profile} ${workspace.model.profileId}`
                  : "—"}
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>{t.detail.statusWikiTitle}</CardDescription>
                <CardTitle
                  className="text-base"
                  data-testid="detail-wiki-language"
                >
                  {wikiLangLabel}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Badge variant={workspace.adaptive ? "secondary" : "outline"}>
                  {t.detail.adaptive}: {workspace.adaptive ? t.common.on : t.common.off}
                </Badge>
                <Badge variant={workspace.reviewer ? "secondary" : "outline"}>
                  {t.detail.reviewer}: {workspace.reviewer ? t.common.on : t.common.off}
                </Badge>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>{t.detail.statusPublicationTitle}</CardDescription>
                <CardTitle className="truncate font-mono text-sm font-normal">
                  {workspace.publicationPath}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {t.detail.rootPath}:{" "}
                <span className="font-mono">{workspace.rootPath}</span>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t.detail.nextStepsTitle}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Link
                to={workspaceHref(workspace.id, "/sources", rootPathHint)}
                className={cn(buttonVariants())}
              >
                {t.detail.ctaAddSource}
              </Link>
              <Link
                to={workspaceHref(workspace.id, "/session", rootPathHint)}
                className={cn(buttonVariants({ variant: "secondary" }))}
              >
                {t.detail.ctaOpenSession}
              </Link>
              <Link
                to={workspaceHref(workspace.id, "/wiki", rootPathHint)}
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                {t.detail.ctaOpenWiki}
              </Link>
              <Link
                to={workspaceHref(workspace.id, "/settings", rootPathHint)}
                className={cn(buttonVariants({ variant: "ghost" }))}
              >
                {t.detail.editSettings}
              </Link>
            </CardContent>
          </Card>

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
                  <dd>{wikiLangLabel}</dd>
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
            </CardContent>
          </Card>
        </div>
      ) : null}
    </WorkspaceShell>
  );
}
