import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";
import { agentWorkspaceHref } from "../lib/workspace-path";
import { ErrorBanner } from "./ErrorBanner";
import { Layout } from "./Layout";
import { WorkspaceSubnav } from "./WorkspaceSubnav";

export type WorkspaceShellProps = {
  workspaceId: string;
  workspaceName?: string;
  /** Final breadcrumb segment (workspace name links to Agent Workspace). */
  breadcrumbLabel?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  error?: unknown;
  onDismissError?: () => void;
  /**
   * Compact chrome for Session: single-line title + actions, no description.
   * Also applies the immersive page height classes used by the chat layout.
   */
  compact?: boolean;
  /**
   * Immersive agent layout: no page padding, slim chrome, full-height shell.
   * Implies compact behavior for height chain.
   */
  immersive?: boolean;
  /** data-testid on the page root wrapper. */
  testId?: string;
  className?: string;
};

export function WorkspaceShell({
  workspaceId,
  workspaceName,
  breadcrumbLabel,
  title,
  description,
  actions,
  children,
  error,
  onDismissError,
  compact = false,
  immersive = false,
  testId,
  className,
}: WorkspaceShellProps) {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const rootPath = searchParams.get("rootPath");
  const displayName = workspaceName ?? workspaceId;
  const tight = compact || immersive;

  return (
    <Layout immersive={immersive}>
      <div
        data-testid={testId}
        className={cn(
          tight
            ? "relative flex min-h-0 flex-1 flex-col overflow-hidden"
            : "flex flex-col gap-5",
          immersive && "gap-0",
          !immersive && tight && "gap-2",
          className,
        )}
      >
        <header
          className={cn(
            immersive
              ? "flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5"
              : cn("page-header", tight && "shrink-0"),
          )}
        >
          {immersive ? (
            <>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Link
                  to="/workspaces"
                  className="text-xs text-muted-foreground no-underline hover:text-foreground hover:underline"
                >
                  {t.nav.workspaces}
                </Link>
                <span className="text-muted-foreground/50">/</span>
                <h1 className="!mb-0 min-w-0 truncate text-sm font-semibold tracking-tight">
                  {displayName}
                </h1>
                {breadcrumbLabel ? (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="text-xs text-muted-foreground">
                      {breadcrumbLabel}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="text-xs text-muted-foreground">{title}</span>
                  </>
                )}
              </div>
              {actions ? (
                <div className="flex flex-wrap items-center gap-2">{actions}</div>
              ) : null}
              {workspaceId ? (
                <WorkspaceSubnav workspaceId={workspaceId} compact />
              ) : null}
            </>
          ) : (
            <>
              <Breadcrumb className="breadcrumb" data-testid="workspace-breadcrumb">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink render={<Link to="/workspaces" />}>
                      {t.nav.workspaces}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {breadcrumbLabel ? (
                      <BreadcrumbLink
                        render={
                          <Link to={agentWorkspaceHref(workspaceId, rootPath)} />
                        }
                      >
                        {displayName}
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{displayName}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                  {breadcrumbLabel ? (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage>{breadcrumbLabel}</BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  ) : null}
                </BreadcrumbList>
              </Breadcrumb>

              {tight ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h1 className="!mb-0 text-xl font-semibold tracking-tight">
                    {title}
                  </h1>
                  {actions ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {actions}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div
                  className={cn(
                    actions && "flex flex-wrap items-start justify-between gap-2",
                  )}
                >
                  <div>
                    <h1>{title}</h1>
                    {description ? <p>{description}</p> : null}
                  </div>
                  {actions ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {actions}
                    </div>
                  ) : null}
                </div>
              )}

              {workspaceId ? (
                <div className={cn(tight && "shrink-0")}>
                  <WorkspaceSubnav workspaceId={workspaceId} />
                </div>
              ) : null}
            </>
          )}
        </header>

        <ErrorBanner error={error} onDismiss={onDismissError} />

        {children}
      </div>
    </Layout>
  );
}
