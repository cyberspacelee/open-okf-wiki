import { useEffect, useState } from "react"
import {
  BookOpenIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FileDiffIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  decideReview,
  fetchBundleFile,
  fetchEvidence,
  fetchReview,
  type BundleFileDetail,
  type EvidenceExcerpt,
  type EvidenceReference,
  type ReviewError,
  type ReviewSnapshot,
} from "@/lib/review"
import { fetchRuns, titleCase } from "@/lib/runs"

const changeKinds = [
  "added",
  "changed",
  "removed",
  "stale",
  "disputed",
  "merged",
  "split",
  "excluded",
] as const

export function ReviewPage({
  token,
  selectedRunId,
  onSelectRun,
}: {
  token: string
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
}) {
  const [review, setReview] = useState<ReviewSnapshot | null>(null)
  const [error, setError] = useState<ReviewError | null>(null)
  const [reload, setReload] = useState(0)
  const [outcome, setOutcome] = useState<string | null>(null)

  useEffect(() => {
    if (selectedRunId) return
    const controller = new AbortController()
    fetchRuns(token, controller.signal).then(
      ({ runs }) => {
        const pending = runs.find((run) => run.state === "review_required")
        if (pending) onSelectRun(pending.run_id)
      },
      (reason: ReviewError) => {
        if (!controller.signal.aborted) setError(reason)
      }
    )
    return () => controller.abort()
  }, [onSelectRun, selectedRunId, token])

  useEffect(() => {
    if (!selectedRunId) return
    const controller = new AbortController()
    fetchReview(token, selectedRunId, controller.signal).then(
      (snapshot) => {
        setReview(snapshot)
        setError(null)
        setOutcome(null)
      },
      (reason: ReviewError) => {
        if (!controller.signal.aborted) setError(reason)
      }
    )
    return () => controller.abort()
  }, [reload, selectedRunId, token])

  if (!selectedRunId)
    return (
      <main className="mx-auto w-full max-w-[90rem] px-5 py-7 lg:px-8 lg:py-9">
        <Empty className="min-h-96 border bg-background">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheckIcon />
            </EmptyMedia>
            <EmptyTitle>No Run needs review</EmptyTitle>
            <EmptyDescription>
              A completed Production Run will appear here when it reaches Review
              Required.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    )

  return (
    <main className="mx-auto flex w-full max-w-[90rem] flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9">
      <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            Authoritative review
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Review & publish
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Inspect accepted knowledge, fixed-revision evidence, and the
            generated Bundle diff. Derived Claims, Concepts, Findings, and
            Markdown are read-only.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh snapshot
        </Button>
      </section>

      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Review could not be loaded</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {outcome && (
        <Alert>
          <CircleCheckIcon />
          <AlertTitle>Review decision recorded</AlertTitle>
          <AlertDescription>{outcome}</AlertDescription>
        </Alert>
      )}

      {!review || review.run_id !== selectedRunId ? (
        <Skeleton className="h-[36rem] w-full" />
      ) : (
        <ReviewContents
          token={token}
          review={review}
          onRefresh={setReview}
          onOutcome={setOutcome}
          onError={setError}
        />
      )}
    </main>
  )
}

function ReviewContents({
  token,
  review,
  onRefresh,
  onOutcome,
  onError,
}: {
  token: string
  review: ReviewSnapshot
  onRefresh: (review: ReviewSnapshot) => void
  onOutcome: (message: string) => void
  onError: (error: ReviewError | null) => void
}) {
  const [evidence, setEvidence] = useState<EvidenceExcerpt | null>(null)
  const [bundleFile, setBundleFile] = useState<BundleFileDetail | null>(null)
  const [pending, setPending] = useState(false)
  const [completed, setCompleted] = useState(false)

  async function openEvidence(reference: EvidenceReference) {
    try {
      setEvidence(await fetchEvidence(token, review.run_id, reference.id))
    } catch (reason) {
      onError(reason as ReviewError)
    }
  }

  async function openBundleFile(path: string) {
    try {
      setBundleFile(await fetchBundleFile(token, review.run_id, path))
    } catch (reason) {
      onError(reason as ReviewError)
    }
  }

  async function decide(decision: "approve" | "reject") {
    setPending(true)
    onError(null)
    try {
      const result = await decideReview(
        token,
        review.run_id,
        decision,
        review.authoritative_digest
      )
      if (result.status === "stale") {
        onRefresh(result.review)
        onError({ kind: "invalid", message: result.message })
      } else {
        setCompleted(true)
        onOutcome(
          decision === "approve"
            ? "The validated Bundle was published atomically."
            : "The Run returned to Exploring; the published Bundle was unchanged."
        )
      }
    } catch (reason) {
      onError(reason as ReviewError)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <code className="break-all">{review.run_id}</code>
          </CardTitle>
          <CardDescription>
            Source Set{" "}
            <code className="break-all">{review.source_set_digest}</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Major" value={review.coverage.major} />
          <Metric label="Supporting" value={review.coverage.supporting} />
          <Metric label="Covered" value={review.coverage.covered} />
          <Metric
            label="Excluded / deferred"
            value={review.coverage.excluded + review.coverage.deferred}
          />
          <div className="sm:col-span-2 lg:col-span-4">
            <p className="text-xs text-muted-foreground">
              Authoritative digest
            </p>
            <code
              className="mt-1 block text-sm break-all"
              data-testid="review-digest"
            >
              {review.authoritative_digest}
            </code>
          </div>
        </CardContent>
      </Card>

      <Coverage review={review} />
      <KnowledgeChanges review={review} onEvidence={openEvidence} />
      <EvidenceReferences review={review} onEvidence={openEvidence} />
      <Findings review={review} onEvidence={openEvidence} />
      <BundleDiff review={review} onOpen={openBundleFile} />

      <Card>
        <CardHeader>
          <CardTitle>Decision</CardTitle>
          <CardDescription>
            The decision is checked against the digest above. Approval reruns
            deterministic validation before atomic publication.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <DecisionDialog
            label="Approve & publish"
            description="Publish only if the final deterministic validation still passes."
            disabled={pending || completed}
            onConfirm={() => decide("approve")}
          />
          <DecisionDialog
            label="Reject changes"
            description="Return the Run to Exploring without changing the published Bundle."
            disabled={pending || completed}
            destructive
            onConfirm={() => decide("reject")}
          />
        </CardContent>
      </Card>

      <EvidenceSheet
        evidence={evidence}
        onOpenChange={(open) => !open && setEvidence(null)}
      />
      <BundleSheet
        file={bundleFile}
        onOpenChange={(open) => !open && setBundleFile(null)}
      />
    </>
  )
}

function EvidenceReferences({
  review,
  onEvidence,
}: {
  review: ReviewSnapshot
  onEvidence: (evidence: EvidenceReference) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Evidence References</CardTitle>
        <CardDescription>
          Every accepted or removed reference resolves at its fixed Source
          Snapshot revision and recorded span.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Path and span</TableHead>
              <TableHead>Authority</TableHead>
              <TableHead className="text-right">Excerpt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {review.evidence_references.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <p className="font-medium">{item.source_id}</p>
                  <code className="text-xs text-muted-foreground">
                    {item.revision}
                  </code>
                </TableCell>
                <TableCell>
                  <code className="text-xs">
                    {item.path}:{item.start_line}-{item.end_line}
                  </code>
                </TableCell>
                <TableCell>{titleCase(item.authority)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onEvidence(item)}
                  >
                    <BookOpenIcon data-icon="inline-start" />
                    Open excerpt
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function Coverage({ review }: { review: ReviewSnapshot }) {
  const deferred = review.coverage_obligations.filter((item) =>
    ["deferred", "excluded"].includes(item.disposition)
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Coverage</CardTitle>
        <CardDescription>
          Disposition totals by source, role, and priority.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Tabs defaultValue="source">
          <TabsList>
            <TabsTrigger value="source">Source</TabsTrigger>
            <TabsTrigger value="role">Role</TabsTrigger>
            <TabsTrigger value="priority">Priority</TabsTrigger>
          </TabsList>
          <TabsContent value="source">
            <CoverageTable groups={review.coverage.by_source} />
          </TabsContent>
          <TabsContent value="role">
            <CoverageTable groups={review.coverage.by_role} />
          </TabsContent>
          <TabsContent value="priority">
            <CoverageTable groups={review.coverage.by_priority} />
          </TabsContent>
        </Tabs>
        {deferred.length > 0 && (
          <div>
            <h3 className="mb-3 font-medium">Exclusions and deferrals</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Obligation</TableHead>
                  <TableHead>Source / role</TableHead>
                  <TableHead>Disposition</TableHead>
                  <TableHead>Required reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deferred.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <code className="text-xs break-all">{item.id}</code>
                    </TableCell>
                    <TableCell>
                      {item.source} / {titleCase(item.role)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {titleCase(item.disposition)}
                      </Badge>
                    </TableCell>
                    <TableCell>{item.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CoverageTable({
  groups,
}: {
  groups: Record<
    string,
    { total: number; dispositions: Record<string, number> }
  >
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Group</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Dispositions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Object.entries(groups).map(([name, group]) => (
          <TableRow key={name}>
            <TableCell className="font-medium">{titleCase(name)}</TableCell>
            <TableCell>{group.total}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-2">
                {Object.entries(group.dispositions).map(
                  ([disposition, count]) => (
                    <Badge key={disposition} variant="outline">
                      {titleCase(disposition)} {count}
                    </Badge>
                  )
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function KnowledgeChanges({
  review,
  onEvidence,
}: {
  review: ReviewSnapshot
  onEvidence: (evidence: EvidenceReference) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge changes</CardTitle>
        <CardDescription>
          Authoritative Claim and Concept changes; no derived-content editing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="claims">
          <TabsList>
            <TabsTrigger value="claims">Claims</TabsTrigger>
            <TabsTrigger value="concepts">Concepts</TabsTrigger>
          </TabsList>
          <TabsContent value="claims" className="flex flex-col gap-5">
            {changeKinds.map((kind) => {
              const items = review.knowledge_changes.claims[kind]
              if (!items.length) return null
              return (
                <section key={kind}>
                  <h3 className="mb-2 font-medium">{titleCase(kind)} Claims</h3>
                  <div className="flex flex-col gap-2">
                    {items.map((claim) => (
                      <div key={claim.id} className="rounded-lg border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {titleCase(claim.epistemic_status)}
                          </Badge>
                          <code className="text-xs break-all">{claim.id}</code>
                        </div>
                        <p className="mt-2 text-sm">{claim.statement}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {claim.evidence.map((item) => (
                            <Button
                              key={item.id}
                              variant="outline"
                              size="sm"
                              onClick={() => onEvidence(item)}
                            >
                              <BookOpenIcon data-icon="inline-start" />
                              Evidence {item.path}:{item.start_line}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </TabsContent>
          <TabsContent value="concepts" className="flex flex-col gap-5">
            {changeKinds.map((kind) => {
              const items = review.knowledge_changes.concepts[kind]
              if (!items.length) return null
              return (
                <section key={kind}>
                  <h3 className="mb-2 font-medium">
                    {titleCase(kind)} Concepts
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Concept</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Bundle page</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((concept) => (
                        <TableRow key={concept.id}>
                          <TableCell>
                            <p className="font-medium">
                              {concept.canonical_name}
                            </p>
                            <code className="text-xs break-all text-muted-foreground">
                              {concept.id}
                            </code>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {titleCase(concept.status)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs">{concept.page}</code>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </section>
              )
            })}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function Findings({
  review,
  onEvidence,
}: {
  review: ReviewSnapshot
  onEvidence: (evidence: EvidenceReference) => void
}) {
  const [groupBy, setGroupBy] = useState<
    "perspective" | "severity" | "verdict" | "blocking"
  >("perspective")
  const evidence = new Map(
    review.evidence_references.map((item) => [item.id, item])
  )
  const groups = review.verification_findings.reduce<
    Record<string, ReviewSnapshot["verification_findings"]>
  >((result, finding) => {
    const group =
      groupBy === "blocking"
        ? finding.blocking
          ? "Blocking"
          : "Non-blocking"
        : titleCase(finding[groupBy])
    if (!result[group]) result[group] = []
    result[group].push(finding)
    return result
  }, {})
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verification Findings</CardTitle>
        <CardDescription>
          Group independent semantic assessments by perspective, severity,
          verdict, or blocking status.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 px-0">
        <div className="px-4">
          <ToggleGroup
            aria-label="Group Verification Findings"
            value={[groupBy]}
            onValueChange={(value) => {
              if (value[0]) setGroupBy(value[0] as typeof groupBy)
            }}
          >
            <ToggleGroupItem value="perspective">Perspective</ToggleGroupItem>
            <ToggleGroupItem value="severity">Severity</ToggleGroupItem>
            <ToggleGroupItem value="verdict">Verdict</ToggleGroupItem>
            <ToggleGroupItem value="blocking">Blocking</ToggleGroupItem>
          </ToggleGroup>
        </div>
        {Object.entries(groups).map(([group, findings]) => (
          <section key={group}>
            <h3 className="mb-2 px-4 font-medium">{group}</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Perspective</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Blocking</TableHead>
                  <TableHead>Rationale and evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {findings.map((finding) => (
                  <TableRow
                    key={`${finding.candidate_id}:${finding.perspective}`}
                  >
                    <TableCell>{titleCase(finding.perspective)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {titleCase(finding.severity)}
                      </Badge>
                    </TableCell>
                    <TableCell>{titleCase(finding.verdict)}</TableCell>
                    <TableCell>{finding.blocking ? "Yes" : "No"}</TableCell>
                    <TableCell>
                      <p>{finding.rationale}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {finding.evidence.map((id) => {
                          const reference = evidence.get(id)
                          return reference ? (
                            <Button
                              key={id}
                              variant="outline"
                              size="sm"
                              onClick={() => onEvidence(reference)}
                            >
                              <BookOpenIcon data-icon="inline-start" />
                              Evidence {reference.path}:{reference.start_line}
                            </Button>
                          ) : (
                            <Badge key={id} variant="outline">
                              {id}
                            </Badge>
                          )
                        })}
                        {finding.evidence_reference_ids
                          .filter((id) => !finding.evidence.includes(id))
                          .map((id) => {
                            const reference = evidence.get(id)
                            return reference ? (
                              <Button
                                key={id}
                                variant="outline"
                                size="sm"
                                onClick={() => onEvidence(reference)}
                              >
                                <BookOpenIcon data-icon="inline-start" />
                                Evidence {reference.path}:{reference.start_line}
                              </Button>
                            ) : null
                          })}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ))}
      </CardContent>
    </Card>
  )
}

function BundleDiff({
  review,
  onOpen,
}: {
  review: ReviewSnapshot
  onOpen: (path: string) => void
}) {
  const rows = (["added", "changed", "removed"] as const).flatMap((status) =>
    review.bundle_diff[status].map((path) => ({ path, status }))
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bundle diff</CardTitle>
        <CardDescription>
          Generated staged pages compared with the current published Bundle.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>Change</TableHead>
              <TableHead className="text-right">Inspect</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((item) => (
              <TableRow key={`${item.status}:${item.path}`}>
                <TableCell>
                  <code className="text-xs">{item.path}</code>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{titleCase(item.status)}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpen(item.path)}
                  >
                    <FileDiffIcon data-icon="inline-start" />
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function DecisionDialog({
  label,
  description,
  disabled,
  destructive = false,
  onConfirm,
}: {
  label: string
  description: string
  disabled: boolean
  destructive?: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={disabled}
          />
        }
      >
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            Confirm {destructive ? "rejection" : "publication"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function EvidenceSheet({
  evidence,
  onOpenChange,
}: {
  evidence: EvidenceExcerpt | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={evidence !== null} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Fixed-revision Evidence</SheetTitle>
          <SheetDescription>
            {evidence
              ? `${evidence.source_id}@${evidence.revision} · ${evidence.path} · lines ${evidence.start_line}-${evidence.requested_end_line}`
              : "Evidence excerpt"}
          </SheetDescription>
        </SheetHeader>
        <pre className="mx-4 overflow-auto rounded-lg border bg-muted/30 p-4 text-xs whitespace-pre-wrap">
          {evidence?.text}
        </pre>
        {evidence?.truncated && (
          <p className="px-4 text-xs text-muted-foreground">
            Excerpt truncated at the bounded review limit.
          </p>
        )}
      </SheetContent>
    </Sheet>
  )
}

function BundleSheet({
  file,
  onOpenChange,
}: {
  file: BundleFileDetail | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={file !== null} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Generated Bundle detail</SheetTitle>
          <SheetDescription>
            {file ? `${titleCase(file.status)} · ${file.path}` : "Bundle diff"}
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-auto px-4 lg:grid-cols-2">
          <ReadOnlyText title="Published" text={file?.published ?? null} />
          <ReadOnlyText title="Staged" text={file?.staged ?? null} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ReadOnlyText({ title, text }: { title: string; text: string | null }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2 font-medium">{title}</h3>
      <pre className="min-h-48 overflow-auto rounded-lg border bg-muted/30 p-4 text-xs whitespace-pre-wrap">
        {text ?? "No page in this Bundle."}
      </pre>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <dl>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
    </dl>
  )
}
