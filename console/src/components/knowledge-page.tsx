import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  ArrowRightIcon,
  BookOpenIcon,
  BracesIcon,
  CodeIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  fetchKnowledgeClaim,
  fetchKnowledgeDiff,
  fetchKnowledgePage,
  fetchKnowledgeSnapshot,
  searchKnowledge,
  type BundleKind,
  type DiffOption,
  type InlineNode,
  type KnowledgeClaim,
  type KnowledgeDiff,
  type KnowledgeError,
  type KnowledgePage as KnowledgePageData,
  type KnowledgeSnapshot,
  type MarkdownBlock,
} from "@/lib/knowledge"
import { cn } from "@/lib/utils"

type ReaderMode = "rendered" | "source" | "diff"
type DiffMode = "unified" | "split"

function diffOptionValue(option: DiffOption) {
  return `${option.base}:${option.base_run_id}:${option.target}:${option.target_run_id}`
}

export function KnowledgePage({ token }: { token: string }) {
  const query = new URLSearchParams(window.location.search)
  const [bundle, setBundle] = useState<BundleKind>(() =>
    query.get("bundle") === "published" ? "published" : "staged"
  )
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null)
  const [page, setPage] = useState<KnowledgePageData | null>(null)
  const [path, setPath] = useState<string | null>(() => query.get("page"))
  const [mode, setMode] = useState<ReaderMode>("rendered")
  const [diffMode, setDiffMode] = useState<DiffMode>("unified")
  const [comparison, setComparison] = useState("")
  const [diff, setDiff] = useState<KnowledgeDiff | null>(null)
  const [error, setError] = useState<KnowledgeError | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [queryText, setQueryText] = useState("")
  const [results, setResults] = useState<
    Array<{ path: string; title: string; excerpt: string }>
  >([])
  const [searching, setSearching] = useState(false)
  const articleRef = useRef<HTMLElement>(null)
  const pendingFragment = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchKnowledgeSnapshot(token, bundle, controller.signal).then(
      (next) => {
        setError(null)
        setSnapshot(next)
        setComparison((current) => {
          if (
            next.diff_options.some(
              (option) => diffOptionValue(option) === current
            )
          )
            return current
          const preferred =
            next.diff_options.find(
              (option) => option.target === next.selected.kind
            ) ?? next.diff_options[0]
          return preferred ? diffOptionValue(preferred) : ""
        })
        setPath((current) =>
          current && next.pages.some((item) => item.path === current)
            ? current
            : next.default_page
        )
      },
      (nextError: KnowledgeError) => {
        if (!controller.signal.aborted) setError(nextError)
      }
    )
    return () => controller.abort()
  }, [bundle, retryKey, token])

  useEffect(() => {
    if (!path || !snapshot) return
    const controller = new AbortController()
    fetchKnowledgePage(
      token,
      bundle,
      snapshot.selected.run_id,
      path,
      controller.signal
    ).then(
      (next) => {
        setError(null)
        setPage(next)
      },
      (nextError: KnowledgeError) => {
        if (!controller.signal.aborted) setError(nextError)
      }
    )
    const parameters = new URLSearchParams(window.location.search)
    parameters.set("view", "knowledge")
    parameters.set("bundle", bundle)
    parameters.set("page", path)
    window.history.replaceState(null, "", `/?${parameters}`)
    return () => controller.abort()
  }, [bundle, path, retryKey, snapshot, token])

  useEffect(() => {
    if (mode !== "diff" || !path || !snapshot) return
    const option = snapshot.diff_options.find(
      (item) => diffOptionValue(item) === comparison
    )
    if (!option) return
    const controller = new AbortController()
    fetchKnowledgeDiff(token, path, option, controller.signal).then(
      (next) => {
        setError(null)
        setDiff(next)
      },
      (nextError: KnowledgeError) => {
        if (!controller.signal.aborted) setError(nextError)
      }
    )
    return () => controller.abort()
  }, [comparison, mode, path, retryKey, snapshot, token])

  useEffect(() => {
    if (!page) return
    const fragment = pendingFragment.current
    pendingFragment.current = null
    if (fragment) {
      requestAnimationFrame(() => {
        const target = document.getElementById(fragment)
        target?.focus()
        target?.scrollIntoView({ block: "start" })
      })
    } else {
      articleRef.current?.focus()
    }
  }, [page])

  const navigate = useCallback(
    (nextPath: string, fragment?: string | null) => {
      if (nextPath === path && fragment) {
        const target = document.getElementById(fragment)
        target?.focus()
        target?.scrollIntoView({ block: "start" })
        return
      }
      pendingFragment.current = fragment ?? null
      setPage(null)
      setDiff(null)
      setError(null)
      setPath(nextPath)
      setMode("rendered")
    },
    [path]
  )

  async function submitSearch(event: FormEvent) {
    event.preventDefault()
    if (!queryText.trim() || !snapshot) return
    setSearching(true)
    setError(null)
    try {
      setResults(
        await searchKnowledge(
          token,
          bundle,
          snapshot.selected.run_id,
          queryText
        )
      )
    } catch (nextError) {
      setError(nextError as KnowledgeError)
    } finally {
      setSearching(false)
    }
  }

  function retry() {
    setError(null)
    setRetryKey((value) => value + 1)
  }

  if (error && !snapshot)
    return (
      <KnowledgeFailure
        error={error}
        bundle={bundle}
        onBundle={setBundle}
        onRetry={retry}
      />
    )
  if (!snapshot) return <KnowledgeLoading />

  return (
    <main className="mx-auto flex w-full max-w-[100rem] flex-col gap-5 px-5 py-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            Read-only Knowledge Bundle
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Generated Markdown is rendered from the deterministic control plane
            and cannot be edited here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            aria-label="Knowledge Bundle"
            value={[bundle]}
            onValueChange={(values) => {
              const selected = values[0] as BundleKind | undefined
              if (selected) {
                setSnapshot(null)
                setPage(null)
                setError(null)
                setBundle(selected)
              }
            }}
            variant="outline"
            size="sm"
            spacing={0}
          >
            {snapshot.bundles.map((item) => (
              <ToggleGroupItem key={item.kind} value={item.kind}>
                {item.kind === "staged" ? "Staged" : "Published"}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Badge variant="outline">Run {snapshot.selected.run_id}</Badge>
          <Badge variant="secondary">
            Source Set {snapshot.selected.source_set_digest.slice(0, 12)}
          </Badge>
        </div>
      </header>

      {error && page && mode !== "diff" && (
        <Alert variant="destructive">
          <ShieldCheckIcon />
          <AlertTitle>Knowledge reader needs attention</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </Alert>
      )}

      <div className="grid min-h-[42rem] gap-5 xl:grid-cols-[17rem_minmax(0,1fr)_16rem]">
        <aside
          aria-label="Bundle pages"
          className="flex min-w-0 flex-col gap-4 border-r pr-4"
        >
          <form onSubmit={submitSearch}>
            <Field>
              <FieldLabel htmlFor="knowledge-search" className="sr-only">
                Search Knowledge Bundle
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="knowledge-search"
                  placeholder="Search pages"
                  value={queryText}
                  onChange={(event) => setQueryText(event.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="submit"
                    size="icon-xs"
                    disabled={searching}
                    aria-label="Search"
                  >
                    <SearchIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </form>
          {results.length > 0 && (
            <section
              aria-label="Search results"
              className="flex flex-col gap-2"
            >
              <p className="text-xs font-medium text-muted-foreground">
                Search results
              </p>
              {results.map((result) => (
                <Button
                  key={result.path}
                  variant="ghost"
                  className="h-auto min-w-0 justify-start whitespace-normal"
                  onClick={() => navigate(result.path)}
                >
                  <span className="min-w-0 text-left">
                    <span className="block truncate font-medium">
                      {result.title}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {result.excerpt}
                    </span>
                  </span>
                </Button>
              ))}
              <Separator />
            </section>
          )}
          <nav aria-label="Knowledge pages" className="flex flex-col gap-1">
            {snapshot.pages.map((item) => (
              <Button
                key={item.path}
                variant={item.path === path ? "secondary" : "ghost"}
                className="min-w-0 justify-start"
                aria-current={item.path === path ? "page" : undefined}
                onClick={() => navigate(item.path)}
              >
                <BookOpenIcon data-icon="inline-start" />
                <span className="truncate">{item.title}</span>
              </Button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0">
          {!path ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpenIcon />
                </EmptyMedia>
                <EmptyTitle>No Bundle pages</EmptyTitle>
                <EmptyDescription>
                  The selected Bundle contains no Markdown pages.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : !page && error ? (
            <ReaderFailure error={error} onRetry={retry} />
          ) : !page ? (
            <div
              className="flex flex-col gap-4"
              aria-label="Loading Knowledge page"
              aria-busy="true"
            >
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : (
            <article
              ref={articleRef}
              tabIndex={-1}
              aria-labelledby="knowledge-page-title"
              className="outline-none"
            >
              <div className="mb-5 flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <h2
                    id="knowledge-page-title"
                    className="truncate text-xl font-semibold"
                  >
                    {page.title}
                  </h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {page.path}
                  </p>
                </div>
                <ToggleGroup
                  aria-label="Reader view"
                  value={[mode]}
                  onValueChange={(values) => {
                    const selected = values[0] as ReaderMode | undefined
                    if (selected) {
                      if (selected === "diff") setDiff(null)
                      setMode(selected)
                    }
                  }}
                  variant="outline"
                  size="sm"
                  spacing={0}
                >
                  <ToggleGroupItem value="rendered">
                    <BookOpenIcon />
                    Rendered
                  </ToggleGroupItem>
                  <ToggleGroupItem value="source">
                    <CodeIcon />
                    Source
                  </ToggleGroupItem>
                  <ToggleGroupItem value="diff">
                    <FileDiffIcon />
                    Diff
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              {page.diagnostics.length > 0 && (
                <Alert className="mb-5">
                  <ShieldCheckIcon />
                  <AlertTitle>
                    Unsafe or unavailable content was contained
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 list-disc pl-5">
                      {page.diagnostics.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {mode === "source" ? (
                <pre
                  className="overflow-auto rounded-lg border bg-muted p-4 text-sm leading-6"
                  tabIndex={0}
                  aria-label="Generated Markdown source"
                >
                  <code>{page.source}</code>
                </pre>
              ) : mode === "diff" ? (
                <DiffReader
                  diff={diff}
                  error={error}
                  mode={diffMode}
                  onMode={setDiffMode}
                  options={snapshot.diff_options}
                  comparison={comparison}
                  onComparison={(value) => {
                    setDiff(null)
                    setError(null)
                    setComparison(value)
                  }}
                  onRetry={retry}
                />
              ) : (
                <MarkdownReader
                  blocks={page.blocks}
                  bundle={bundle}
                  runId={snapshot.selected.run_id}
                  token={token}
                  onNavigate={navigate}
                />
              )}
            </article>
          )}
        </section>

        <aside
          aria-label="Page details"
          className="flex min-w-0 flex-col gap-5 border-l pl-4"
        >
          {page && (
            <>
              <PageMetadata metadata={page.metadata} />
              <PageLinks
                title="On this page"
                empty="No headings."
                values={page.outline.map((item) => ({
                  label: item.text,
                  href: `#${item.id}`,
                }))}
              />
              <PageLinks
                title="Backlinks"
                empty="No pages link here."
                values={page.backlinks.map((item) => ({
                  label: item,
                  page: item,
                }))}
                onNavigate={navigate}
              />
            </>
          )}
        </aside>
      </div>
    </main>
  )
}

function MarkdownReader({
  blocks,
  bundle,
  runId,
  token,
  onNavigate,
}: {
  blocks: MarkdownBlock[]
  bundle: BundleKind
  runId: string
  token: string
  onNavigate: (path: string, fragment?: string | null) => void
}) {
  return (
    <div className="flex max-w-4xl flex-col gap-4 text-[0.95rem] leading-7">
      {blocks.map((block, index) => (
        <Block
          key={`${block.type}-${index}`}
          block={block}
          bundle={bundle}
          runId={runId}
          token={token}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

function Block({
  block,
  bundle,
  runId,
  token,
  onNavigate,
}: {
  block: MarkdownBlock
  bundle: BundleKind
  runId: string
  token: string
  onNavigate: (path: string, fragment?: string | null) => void
}) {
  if (block.type === "heading") {
    const Heading = `h${Math.min(block.level + 1, 6)}` as "h2"
    return (
      <Heading
        id={block.id}
        tabIndex={-1}
        className={cn(
          "scroll-mt-20 font-semibold tracking-tight outline-none",
          block.level === 1
            ? "mt-3 text-2xl"
            : block.level === 2
              ? "mt-2 text-xl"
              : "text-lg"
        )}
      >
        <Inline
          nodes={block.children}
          bundle={bundle}
          runId={runId}
          token={token}
          onNavigate={onNavigate}
        />
      </Heading>
    )
  }
  if (block.type === "paragraph")
    return (
      <p>
        <Inline
          nodes={block.children}
          bundle={bundle}
          runId={runId}
          token={token}
          onNavigate={onNavigate}
        />
      </p>
    )
  if (block.type === "claim")
    return (
      <ClaimMarker
        claimId={block.claim_id}
        bundle={bundle}
        runId={runId}
        token={token}
      />
    )
  if (block.type === "separator") return <Separator />
  if (block.type === "blockquote")
    return (
      <blockquote className="border-l-2 pl-4 text-muted-foreground">
        <MarkdownReader
          blocks={block.children}
          bundle={bundle}
          runId={runId}
          token={token}
          onNavigate={onNavigate}
        />
      </blockquote>
    )
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul"
    return (
      <List
        start={block.ordered ? block.start : undefined}
        className={block.ordered ? "list-decimal pl-6" : "list-disc pl-6"}
      >
        {block.items.map((item, index) => (
          <li key={index} className="pl-1">
            <div className="flex items-start gap-2">
              {item.checked !== null && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  disabled
                  aria-label={
                    item.checked ? "Completed task" : "Incomplete task"
                  }
                  className="mt-1.5"
                />
              )}
              <div className="min-w-0 flex-1">
                <MarkdownReader
                  blocks={item.children}
                  bundle={bundle}
                  runId={runId}
                  token={token}
                  onNavigate={onNavigate}
                />
              </div>
            </div>
          </li>
        ))}
      </List>
    )
  }
  if (block.type === "table") {
    return (
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {block.headers.map((cell, index) => (
                <TableHead key={index}>
                  <Inline
                    nodes={cell}
                    bundle={bundle}
                    runId={runId}
                    token={token}
                    onNavigate={onNavigate}
                  />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {block.rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {row.map((cell, index) => (
                  <TableCell key={index}>
                    <Inline
                      nodes={cell}
                      bundle={bundle}
                      runId={runId}
                      token={token}
                      onNavigate={onNavigate}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    )
  }
  if (block.type === "code") {
    return (
      <figure className="overflow-hidden rounded-lg border">
        <figcaption className="border-b bg-muted px-3 py-1 font-mono text-xs text-muted-foreground">
          {block.language || "text"}
        </figcaption>
        <pre
          className="overflow-auto bg-muted/40 p-4 text-sm leading-6"
          tabIndex={0}
        >
          <code>
            {block.segments.map((segment, index) => (
              <span
                key={index}
                className={
                  segment.kind === "comment"
                    ? "text-muted-foreground"
                    : segment.kind === "keyword"
                      ? "font-semibold text-primary"
                      : segment.kind === "string" || segment.kind === "number"
                        ? "text-foreground/75"
                        : undefined
                }
              >
                {segment.text}
              </span>
            ))}
          </code>
        </pre>
      </figure>
    )
  }
  if (block.type === "mermaid") return <MermaidDiagram block={block} />
  if (block.type === "math")
    return <MathNotation source={block.source} display />
  return null
}

function Inline({
  nodes,
  bundle,
  runId,
  token,
  onNavigate,
}: {
  nodes: InlineNode[]
  bundle: BundleKind
  runId: string
  token: string
  onNavigate: (path: string, fragment?: string | null) => void
}) {
  return nodes.map((node, index): ReactNode => {
    if (node.type === "text")
      return <Fragment key={index}>{node.text}</Fragment>
    if (node.type === "code")
      return (
        <code
          key={index}
          className="rounded bg-muted px-1 py-0.5 font-mono text-sm break-all"
        >
          {node.text}
        </code>
      )
    if (node.type === "claim")
      return (
        <ClaimMarker
          key={index}
          claimId={node.claim_id}
          bundle={bundle}
          runId={runId}
          token={token}
          inline
        />
      )
    if (node.type === "break") return <br key={index} />
    if (node.type === "math")
      return <MathNotation key={index} source={node.source} />
    if (node.type === "image")
      return (
        <img
          key={index}
          src={node.source}
          alt={node.alt}
          className="my-3 max-h-[36rem] max-w-full rounded-lg border object-contain"
        />
      )
    if (node.type === "strong")
      return (
        <strong key={index}>
          <Inline
            nodes={node.children}
            bundle={bundle}
            runId={runId}
            token={token}
            onNavigate={onNavigate}
          />
        </strong>
      )
    if (node.type === "em")
      return (
        <em key={index}>
          <Inline
            nodes={node.children}
            bundle={bundle}
            runId={runId}
            token={token}
            onNavigate={onNavigate}
          />
        </em>
      )
    if (node.type === "s")
      return (
        <s key={index}>
          <Inline
            nodes={node.children}
            bundle={bundle}
            runId={runId}
            token={token}
            onNavigate={onNavigate}
          />
        </s>
      )
    if (node.external)
      return (
        <a
          key={index}
          href={node.href}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-4"
        >
          <Inline
            nodes={node.children}
            bundle={bundle}
            runId={runId}
            token={token}
            onNavigate={onNavigate}
          />
          <ExternalLinkIcon
            className="ml-1 inline size-3"
            aria-label="External link"
          />
        </a>
      )
    return (
      <a
        key={index}
        href={node.href}
        className="font-medium underline underline-offset-4"
        onClick={(event) => {
          if (node.page) {
            event.preventDefault()
            onNavigate(node.page, node.fragment)
          }
        }}
      >
        <Inline
          nodes={node.children}
          bundle={bundle}
          runId={runId}
          token={token}
          onNavigate={onNavigate}
        />
      </a>
    )
  })
}

function ClaimMarker({
  claimId,
  bundle,
  runId,
  token,
  inline = false,
}: {
  claimId: string
  bundle: BundleKind
  runId: string
  token: string
  inline?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [claim, setClaim] = useState<KnowledgeClaim | null>(null)
  const [error, setError] = useState<KnowledgeError | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open || claim) return
    const controller = new AbortController()
    fetchKnowledgeClaim(token, bundle, runId, claimId, controller.signal).then(
      setClaim,
      (nextError: KnowledgeError) => {
        if (!controller.signal.aborted) setError(nextError)
      }
    )
    return () => controller.abort()
  }, [attempt, bundle, claim, claimId, open, runId, token])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant={inline ? "outline" : "ghost"}
        size={inline ? "xs" : "sm"}
        onClick={() => setOpen(true)}
        className={inline ? undefined : "self-start"}
      >
        <ShieldCheckIcon data-icon="inline-start" />
        {inline ? `Claim ${claimId.slice(6, 14)}` : "View accepted Claim"}
      </Button>
      <SheetContent className="overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Accepted Claim</SheetTitle>
          <SheetDescription>{claimId}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Claim unavailable</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(null)
                  setClaim(null)
                  setAttempt((value) => value + 1)
                }}
              >
                Retry
              </Button>
            </Alert>
          ) : !claim ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <p className="text-base leading-7">{claim.statement}</p>
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 text-sm">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{claim.epistemic_status}</dd>
                <dt className="text-muted-foreground">Subject</dt>
                <dd>{claim.subject}</dd>
                <dt className="text-muted-foreground">Predicate</dt>
                <dd>{claim.predicate}</dd>
              </dl>
              <Separator />
              <h3 className="font-semibold">Evidence excerpts</h3>
              {claim.evidence.map((evidence) => (
                <section
                  key={evidence.id}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <p className="font-mono text-xs text-muted-foreground">
                    {evidence.source_id}@{evidence.revision.slice(0, 12)} /{" "}
                    {evidence.path}#L{evidence.start_line}-L{evidence.end_line}
                  </p>
                  {evidence.error ? (
                    <Alert variant="destructive">
                      <AlertDescription>{evidence.error}</AlertDescription>
                    </Alert>
                  ) : (
                    <pre
                      className="overflow-auto bg-muted p-3 text-sm whitespace-pre-wrap"
                      tabIndex={0}
                    >
                      {evidence.excerpt}
                    </pre>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function MermaidDiagram({
  block,
}: {
  block: Extract<MarkdownBlock, { type: "mermaid" }>
}) {
  if (block.error)
    return (
      <Alert>
        <BracesIcon />
        <AlertTitle>Diagram shown as source</AlertTitle>
        <AlertDescription>
          {block.error}
          <pre className="mt-2 overflow-auto whitespace-pre-wrap" tabIndex={0}>
            {block.source}
          </pre>
        </AlertDescription>
      </Alert>
    )
  const labels = new Map(block.nodes.map((node) => [node.id, node.label]))
  const nodeNames = block.nodes.map((node) => node.label).join(", ")
  const relations = block.edges
    .map((edge) => {
      const relation = `${labels.get(edge.from) ?? edge.from} → ${labels.get(edge.to) ?? edge.to}`
      return edge.label ? `${relation} (${edge.label})` : relation
    })
    .join("; ")
  return (
    <figure
      role="img"
      aria-label={`Mermaid flowchart. Nodes: ${nodeNames}. Relations: ${relations}.`}
      className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4"
    >
      <div className="flex flex-col gap-3">
        {block.edges.map((edge, index) => (
          <div
            key={`${edge.from}-${edge.to}-${index}`}
            className={cn(
              "flex items-center gap-3",
              block.direction === "TB" ||
                block.direction === "TD" ||
                block.direction === "BT"
                ? "flex-col"
                : undefined
            )}
          >
            <div className="rounded-lg border bg-background px-3 py-2 text-center font-medium">
              {labels.get(edge.from) ?? edge.from}
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowRightIcon aria-hidden="true" />
              {edge.label}
            </div>
            <div className="rounded-lg border bg-background px-3 py-2 text-center font-medium">
              {labels.get(edge.to) ?? edge.to}
            </div>
          </div>
        ))}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        Safe deterministic Mermaid flowchart subset
      </figcaption>
    </figure>
  )
}

function MathNotation({
  source,
  display = false,
}: {
  source: string
  display?: boolean
}) {
  const [mathml, setMathml] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    import("katex")
      .then(({ default: katex }) => {
        if (!active) return
        try {
          setMathml(
            katex.renderToString(source, {
              displayMode: display,
              output: "mathml",
              strict: "error",
              throwOnError: false,
              trust: false,
            })
          )
        } catch {
          setMathml(null)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [display, source])
  const Element = display ? "div" : "span"
  return (
    <Element
      aria-label={`Mathematical notation: ${source}`}
      className={display ? "overflow-x-auto py-2 text-center" : undefined}
    >
      {mathml ? (
        <span dangerouslySetInnerHTML={{ __html: mathml }} />
      ) : (
        <code>{source}</code>
      )}
    </Element>
  )
}

function DiffReader({
  diff,
  error,
  mode,
  onMode,
  options,
  comparison,
  onComparison,
  onRetry,
}: {
  diff: KnowledgeDiff | null
  error: KnowledgeError | null
  mode: DiffMode
  onMode: (mode: DiffMode) => void
  options: DiffOption[]
  comparison: string
  onComparison: (value: string) => void
  onRetry: () => void
}) {
  if (options.length === 0)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileDiffIcon />
          </EmptyMedia>
          <EmptyTitle>No comparable Bundle version</EmptyTitle>
          <EmptyDescription>
            Publish or stage another Run to compare this page.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  if (error) return <ReaderFailure error={error} onRetry={onRetry} />
  if (!diff) return <Skeleton className="h-80 w-full" />
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label="Diff versions"
          value={[comparison]}
          onValueChange={(values) => {
            if (values[0]) onComparison(values[0])
          }}
          variant="outline"
          size="sm"
          spacing={0}
        >
          {options.map((option) => (
            <ToggleGroupItem
              key={diffOptionValue(option)}
              value={diffOptionValue(option)}
            >
              {option.base === "previous" ? "Previous" : "Published"} →{" "}
              {option.target === "staged" ? "Staged" : "Published"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{diff.page_change}</Badge>
          <ToggleGroup
            aria-label="Diff layout"
            value={[mode]}
            onValueChange={(values) => {
              const selected = values[0] as DiffMode | undefined
              if (selected) onMode(selected)
            }}
            variant="outline"
            size="sm"
            spacing={0}
          >
            <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
            <ToggleGroupItem value="split">Split</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Run {diff.base.run_id} → Run {diff.target.run_id}
      </p>
      <div
        className="overflow-auto rounded-lg border font-mono text-xs"
        role="table"
        aria-label={`${mode} page diff`}
      >
        {diff.lines.map((line, index) =>
          mode === "unified" ? (
            <div
              key={index}
              role="row"
              className={cn(
                "grid grid-cols-[3rem_3rem_minmax(0,1fr)] border-b last:border-b-0",
                line.kind === "added"
                  ? "bg-primary/5"
                  : line.kind === "removed"
                    ? "bg-destructive/5"
                    : line.kind === "changed"
                      ? "bg-muted"
                      : undefined
              )}
            >
              <span className="px-2 py-1 text-right text-muted-foreground">
                {line.left_number}
              </span>
              <span className="px-2 py-1 text-right text-muted-foreground">
                {line.right_number}
              </span>
              <span className="px-2 py-1 whitespace-pre">
                {line.kind === "removed"
                  ? `- ${line.left}`
                  : line.kind === "added"
                    ? `+ ${line.right}`
                    : line.kind === "changed"
                      ? `~ ${line.left ?? ""} → ${line.right ?? ""}`
                      : `  ${line.right}`}
              </span>
            </div>
          ) : (
            <div
              key={index}
              role="row"
              className="grid grid-cols-2 border-b last:border-b-0"
            >
              <div
                className={cn(
                  "grid grid-cols-[3rem_minmax(0,1fr)] border-r",
                  line.kind === "removed" || line.kind === "changed"
                    ? "bg-destructive/5"
                    : undefined
                )}
              >
                <span className="px-2 py-1 text-right text-muted-foreground">
                  {line.left_number}
                </span>
                <span className="px-2 py-1 whitespace-pre">{line.left}</span>
              </div>
              <div
                className={cn(
                  "grid grid-cols-[3rem_minmax(0,1fr)]",
                  line.kind === "added" || line.kind === "changed"
                    ? "bg-primary/5"
                    : undefined
                )}
              >
                <span className="px-2 py-1 text-right text-muted-foreground">
                  {line.right_number}
                </span>
                <span className="px-2 py-1 whitespace-pre">{line.right}</span>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

function PageMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata)
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Metadata</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No frontmatter.</p>
      ) : (
        <dl className="flex flex-col gap-2 text-xs">
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt className="font-medium text-muted-foreground">{key}</dt>
              <dd className="mt-0.5 break-words">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function PageLinks({
  title,
  empty,
  values,
  onNavigate,
}: {
  title: string
  empty: string
  values: Array<{ label: string; href?: string; page?: string }>
  onNavigate?: (path: string) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {values.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <nav aria-label={title} className="flex flex-col gap-1">
          {values.map((item) =>
            item.page ? (
              <Button
                key={item.label}
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => onNavigate?.(item.page!)}
              >
                {item.label}
              </Button>
            ) : (
              <a
                key={item.href}
                href={item.href}
                className="text-sm underline underline-offset-4"
              >
                {item.label}
              </a>
            )
          )}
        </nav>
      )}
    </section>
  )
}

function KnowledgeLoading() {
  return (
    <main
      className="mx-auto flex w-full max-w-[100rem] flex-col gap-5 px-5 py-6"
      aria-label="Loading Knowledge Bundle"
      aria-busy="true"
    >
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-5 xl:grid-cols-[17rem_minmax(0,1fr)_16rem]">
        <Skeleton className="h-[40rem] w-full" />
        <Skeleton className="h-[40rem] w-full" />
        <Skeleton className="h-[40rem] w-full" />
      </div>
    </main>
  )
}

function KnowledgeFailure({
  error,
  bundle,
  onBundle,
  onRetry,
}: {
  error: KnowledgeError
  bundle: BundleKind
  onBundle: (bundle: BundleKind) => void
  onRetry: () => void
}) {
  return (
    <main className="grid min-h-[35rem] place-items-center p-6">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BookOpenIcon />
          </EmptyMedia>
          <EmptyTitle>
            {bundle === "staged"
              ? "No staged Knowledge Bundle"
              : "No published Knowledge Bundle"}
          </EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button onClick={onRetry}>Retry</Button>
          <Button
            variant="outline"
            onClick={() =>
              onBundle(bundle === "staged" ? "published" : "staged")
            }
          >
            Try {bundle === "staged" ? "published" : "staged"}
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}

function ReaderFailure({
  error,
  onRetry,
}: {
  error: KnowledgeError
  onRetry: () => void
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheckIcon />
        </EmptyMedia>
        <EmptyTitle>Knowledge content unavailable</EmptyTitle>
        <EmptyDescription>{error.message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onRetry}>Retry</Button>
      </EmptyContent>
    </Empty>
  )
}
