import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import {
  ApiError,
  getWikiPage,
  getWorkspace,
  listWikiPages,
  type WikiPageResponse,
  type WorkspaceConfig,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { useI18n } from "../i18n";
import { workspaceHref } from "../lib/workspace-path";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Strip YAML frontmatter so the body renders without the --- block. */
function stripFrontmatter(content: string): string {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return content;
  }
  const firstNl = trimmed.indexOf("\n");
  if (firstNl < 0) {
    return content;
  }
  if (trimmed.slice(0, firstNl).trim() !== "---") {
    return content;
  }
  const rest = trimmed.slice(firstNl + 1);
  const close = rest.search(/^---\s*$/m);
  if (close < 0) {
    return content;
  }
  return rest.slice(close).replace(/^---\s*\n?/, "");
}

/**
 * Resolve a relative markdown href against the current page path.
 * Returns a wiki-relative `.md` path, or null if the link should stay external.
 */
function resolveWikiMdHref(href: string, currentPage: string): string | null {
  if (!href || href.startsWith("#")) {
    return null;
  }
  // Protocol / absolute URL / absolute site path → leave alone
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//") || href.startsWith("/")) {
    return null;
  }
  const hashIndex = href.indexOf("#");
  const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  if (!pathPart) {
    return null;
  }
  if (!pathPart.toLowerCase().endsWith(".md")) {
    return null;
  }
  if (pathPart.includes("..")) {
    // Reject escape attempts in content links.
    return null;
  }

  const currentDir = currentPage.includes("/")
    ? currentPage.slice(0, currentPage.lastIndexOf("/"))
    : "";
  const joined = currentDir ? `${currentDir}/${pathPart}` : pathPart;
  const segments = joined.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    return null;
  }
  return segments.join("/");
}

function defaultPage(pages: string[]): string | undefined {
  if (pages.includes("overview.md")) {
    return "overview.md";
  }
  return pages[0];
}

export function WorkspaceWikiPage() {
  const { t } = useI18n();
  const { id = "", "*": splat = "" } = useParams<{ id: string; "*": string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;

  const pageFromRoute = useMemo(() => {
    const fromSplat = splat.replace(/^\/+/, "").trim();
    if (fromSplat) {
      return fromSplat;
    }
    const fromQuery = searchParams.get("page")?.trim();
    return fromQuery || "";
  }, [splat, searchParams]);

  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [page, setPage] = useState<WikiPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [empty, setEmpty] = useState(false);

  const baseWikiPath = `/workspaces/${encodeURIComponent(id)}/wiki`;

  const selectPage = useCallback(
    (nextPath: string) => {
      const params = new URLSearchParams();
      if (rootPathHint) {
        params.set("rootPath", rootPathHint);
      }
      // Prefer path segment for nested pages; keep rootPath as query.
      const query = params.toString();
      navigate(`${baseWikiPath}/${nextPath.split("/").map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`);
    },
    [baseWikiPath, navigate, rootPathHint],
  );

  // Load workspace + page list
  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setEmpty(false);
      try {
        const data = await getWorkspace(id, rootPathHint);
        if (cancelled) {
          return;
        }
        setWorkspace(data.workspace);
        const root = data.workspace.rootPath ?? rootPathHint;
        try {
          const list = await listWikiPages(id, root);
          if (cancelled) {
            return;
          }
          setPages(list.pages);
          setEmpty(false);
        } catch (listErr) {
          if (cancelled) {
            return;
          }
          if (listErr instanceof ApiError && listErr.status === 404) {
            setPages([]);
            setEmpty(true);
            setPage(null);
          } else {
            throw listErr;
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setWorkspace(null);
          setPages([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, rootPathHint]);

  // When list is ready and no page selected, open default
  useEffect(() => {
    if (loading || empty || pages.length === 0) {
      return;
    }
    if (!pageFromRoute) {
      const fallback = defaultPage(pages);
      if (fallback) {
        selectPage(fallback);
      }
    }
  }, [loading, empty, pages, pageFromRoute, selectPage]);

  // Load selected page content
  useEffect(() => {
    if (!id || !workspace || !pageFromRoute || empty) {
      return;
    }
    let cancelled = false;
    (async () => {
      setPageLoading(true);
      setError(null);
      try {
        const root = workspace.rootPath ?? rootPathHint;
        const data = await getWikiPage(id, pageFromRoute, root);
        if (!cancelled) {
          setPage(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setPage(null);
        }
      } finally {
        if (!cancelled) {
          setPageLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, workspace, pageFromRoute, rootPathHint, empty]);

  const markdownComponents = useMemo<Components>(() => {
    return {
      a({ href, children, ...rest }) {
        if (!href || !pageFromRoute) {
          return (
            <a href={href} {...rest}>
              {children}
            </a>
          );
        }
        const wikiTarget = resolveWikiMdHref(href, pageFromRoute);
        if (wikiTarget) {
          return (
            <a
              href={`${baseWikiPath}/${wikiTarget.split("/").map(encodeURIComponent).join("/")}`}
              {...rest}
              onClick={(event) => {
                event.preventDefault();
                selectPage(wikiTarget);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} {...rest} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    };
  }, [baseWikiPath, pageFromRoute, selectPage]);

  const bodyMarkdown = page ? stripFrontmatter(page.content) : "";

  return (
    <Layout>
      <div data-testid="wiki-page" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">{t.wiki.breadcrumbWorkspaces}</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>{t.wiki.breadcrumb}</span>
          </p>
          <h1>{t.wiki.title}</h1>
          <p>{t.wiki.description}</p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label={t.wiki.loading} />
        ) : empty ? (
          <Card data-testid="wiki-empty">
            <CardContent className="pt-0">
              <Empty className="border-0 p-6">
                <EmptyHeader>
                  <EmptyTitle className="text-base">{t.wiki.emptyTitle}</EmptyTitle>
                  <EmptyDescription>{t.wiki.emptyDescription}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Link
                    to={workspaceHref(id, "/run", rootPathHint)}
                    className={cn(buttonVariants())}
                  >
                    {t.wiki.goToRun}
                  </Link>
                </EmptyContent>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="wiki-layout">
            <Card className="h-fit" aria-label={t.wiki.pagesAria}>
              <CardHeader>
                <CardTitle>{t.wiki.pages}</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="max-h-[28rem]">
                  <ul className="wiki-page-list" data-testid="wiki-page-list">
                    {pages.map((p) => {
                      const active = p === pageFromRoute;
                      return (
                        <li key={p}>
                          <button
                            type="button"
                            className={active ? "wiki-page-link active" : "wiki-page-link"}
                            data-testid="wiki-page-link"
                            data-page={p}
                            aria-current={active ? "page" : undefined}
                            onClick={() => selectPage(p)}
                          >
                            {p}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card data-testid="wiki-page-content">
              <CardContent>
                {pageLoading && !page ? (
                  <LoadingState label={t.wiki.loadingPage} />
                ) : page ? (
                  <>
                    {page.title ? (
                      <h2 className="wiki-page-title" data-testid="wiki-page-title">
                        {page.title}
                      </h2>
                    ) : (
                      <h2 className="wiki-page-title muted">{page.path}</h2>
                    )}
                    <p className="muted small mono wiki-page-path">{page.path}</p>
                    <div className="wiki-markdown" data-testid="wiki-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {bodyMarkdown}
                      </ReactMarkdown>
                    </div>
                  </>
                ) : (
                  <p className="muted">{t.wiki.selectPage}</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </Layout>
  );
}
