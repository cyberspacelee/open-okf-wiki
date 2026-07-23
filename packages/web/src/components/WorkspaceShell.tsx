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
  testId,
  className,
}: WorkspaceShellProps) {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const rootPath = searchParams.get("rootPath");
  const displayName = workspaceName ?? workspaceId;

  return (
    <Layout>
      <div
        data-testid={testId}
        className={cn(
          compact
            ? // Immersive: fill SidebarInset scrollport via flex chain (no max-h cap).
              "relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
            : "flex flex-col gap-5",
          className,
        )}
      >
        <header className={cn("page-header", compact && "shrink-0")}>
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

          {compact ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="!mb-0 text-xl font-semibold tracking-tight">{title}</h1>
              {actions ? (
                <div className="flex flex-wrap items-center gap-2">{actions}</div>
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
                <div className="flex flex-wrap items-center gap-2">{actions}</div>
              ) : null}
            </div>
          )}
        </header>

        {workspaceId ? (
          <div className={cn(compact && "shrink-0")}>
            <WorkspaceSubnav workspaceId={workspaceId} />
          </div>
        ) : null}

        <ErrorBanner error={error} onDismiss={onDismissError} />

        {children}
      </div>
    </Layout>
  );
}
