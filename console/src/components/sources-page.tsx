import { useEffect, useState, type FormEvent } from "react"
import {
  CircleAlertIcon,
  DownloadIcon,
  FolderGit2Icon,
  GitCommitHorizontalIcon,
  GitBranchIcon,
  LinkIcon,
  RefreshCwIcon,
  Trash2Icon,
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
  CardFooter,
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
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
  cloneConfiguredSource,
  cloneSource,
  deleteManagedSource,
  fetchPreflight,
  fetchSources,
  linkSource,
  linkConfiguredSource,
  pullSource,
  removeSource,
  setSourceRevision,
  type PreflightSnapshot,
  type RevisionPolicy,
  type SourceCheckout,
  type SourceRole,
  type SourcesError,
  type SourcesSnapshot,
} from "@/lib/sources"

const roles: Array<{ value: SourceRole; label: string }> = [
  { value: "implementation", label: "Implementation" },
  { value: "documentation", label: "Documentation" },
  { value: "requirements", label: "Requirements" },
  { value: "contract", label: "Contract" },
]

export function SourcesPage({ token }: { token: string }) {
  const [reload, setReload] = useState(0)
  const [snapshot, setSnapshot] = useState<SourcesSnapshot | null>(null)
  const [error, setError] = useState<SourcesError | null>(null)
  const [preflight, setPreflight] = useState<PreflightSnapshot | null>(null)
  const [preflightError, setPreflightError] = useState<SourcesError | null>(
    null
  )
  const [working, setWorking] = useState<string | null>(null)
  const [linkConfiguredId, setLinkConfiguredId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchSources(token, controller.signal).then(
      (result) => {
        setSnapshot(result)
        setError(null)
      },
      (reason: SourcesError) => {
        if (!controller.signal.aborted) setError(reason)
      }
    )
    return () => controller.abort()
  }, [reload, token])

  useEffect(() => {
    const controller = new AbortController()
    fetchPreflight(token, controller.signal).then(
      (result) => {
        setPreflight(result)
        setPreflightError(null)
      },
      (reason: SourcesError) => {
        if (!controller.signal.aborted) {
          setPreflight(null)
          setPreflightError(reason)
        }
      }
    )
    return () => controller.abort()
  }, [reload, token])

  async function mutate(
    label: string,
    operation: () => Promise<SourcesSnapshot>
  ) {
    setWorking(label)
    setError(null)
    try {
      setSnapshot(await operation())
      try {
        setPreflight(await fetchPreflight(token))
        setPreflightError(null)
      } catch (reason) {
        setPreflight(null)
        setPreflightError(reason as SourcesError)
      }
    } catch (reason) {
      setError(reason as SourcesError)
    } finally {
      setWorking(null)
    }
  }

  if (!snapshot && !error) return <SourcesLoading />
  if (!snapshot) {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8 lg:px-8">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Source Checkouts unavailable</AlertTitle>
          <AlertDescription>{error?.message}</AlertDescription>
        </Alert>
        <Button
          className="self-start"
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Reload Sources
        </Button>
      </main>
    )
  }

  const configuredLinkSource = snapshot.sources.find(
    (source) => source.id === linkConfiguredId && source.ownership === null
  )

  return (
    <main className="mx-auto flex w-full max-w-[90rem] flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9">
      <section
        className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"
        aria-labelledby="sources-title"
      >
        <div>
          <p className="mb-2 text-sm text-muted-foreground">Source Checkouts</p>
          <h1
            id="sources-title"
            className="text-3xl font-semibold tracking-tight"
          >
            Sources
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Clone Workspace-managed repositories or link existing local working
            trees. Authentication stays with your installed Git and credential
            helpers.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={working !== null}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh status
        </Button>
      </section>
      <Separator />

      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Source operation failed</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <SourceTable
        sources={snapshot.sources}
        working={working}
        onClone={(id) =>
          mutate(`bind-clone:${id}`, () => cloneConfiguredSource(token, id))
        }
        onLink={(id) => {
          setLinkConfiguredId(id)
          setTimeout(() => document.getElementById("link-checkout")?.focus(), 0)
        }}
        onRemove={(id) => mutate(`remove:${id}`, () => removeSource(token, id))}
        onPull={(id) => mutate(`pull:${id}`, () => pullSource(token, id))}
      />

      <RevisionPoliciesCard
        sources={snapshot.sources.filter((source) => source.ownership !== null)}
        working={working}
        onRevision={(id, revision_policy, revision) =>
          mutate(`revision:${id}`, () =>
            setSourceRevision(token, {
              id,
              revision_policy,
              revision,
              configuration_digest: snapshot.configuration_digest,
            })
          )
        }
      />

      <PreflightCard preflight={preflight} error={preflightError} />

      {snapshot.retained_managed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Retained managed checkouts</CardTitle>
            <CardDescription>
              Removing configuration never deletes files. Delete a retained
              checkout only after typing its exact Source ID.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {snapshot.retained_managed.map((source) => (
              <div
                key={source.id}
                className="flex flex-col justify-between gap-3 rounded-lg border p-4 sm:flex-row sm:items-center"
              >
                <div className="min-w-0">
                  <p className="font-medium">{source.id}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {source.checkout}
                  </p>
                </div>
                <DeleteManagedDialog
                  source={source}
                  disabled={working !== null}
                  onDelete={(confirmation) =>
                    mutate(`delete:${source.id}`, () =>
                      deleteManagedSource(token, source.id, confirmation)
                    )
                  }
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <CloneForm
          disabled={working !== null}
          busy={working === "clone"}
          onSubmit={(payload) =>
            mutate("clone", () => cloneSource(token, payload))
          }
        />
        <LinkForm
          key={configuredLinkSource?.id ?? "new"}
          configuredSource={configuredLinkSource}
          disabled={working !== null}
          busy={working === "link"}
          onSubmit={(payload) =>
            mutate("link", () =>
              configuredLinkSource
                ? linkConfiguredSource(token, payload.id, payload.checkout)
                : linkSource(token, payload)
            )
          }
        />
      </div>
    </main>
  )
}

function SourceTable({
  sources,
  working,
  onClone,
  onLink,
  onRemove,
  onPull,
}: {
  sources: SourceCheckout[]
  working: string | null
  onClone: (id: string) => void
  onLink: (id: string) => void
  onRemove: (id: string) => void
  onPull: (id: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configured Sources</CardTitle>
        <CardDescription>
          Status is read from local Git only; refreshing does not fetch or run
          repository code.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {sources.length === 0 ? (
          <Empty className="min-h-56">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitBranchIcon />
              </EmptyMedia>
              <EmptyTitle>No Sources configured</EmptyTitle>
              <EmptyDescription>
                Clone a managed Source or link an existing repository below.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Ownership</TableHead>
                <TableHead>Git state</TableHead>
                <TableHead>Revision policy</TableHead>
                <TableHead>Checkout</TableHead>
                <TableHead className="sticky right-0 bg-card text-right">
                  Action
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => {
                const unbound = source.ownership === null
                return (
                  <TableRow key={source.id}>
                    <TableCell>
                      <p className="font-medium">{source.id}</p>
                      <p className="text-xs text-muted-foreground">
                        {roleLabel(source.role)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {source.ownership ?? "Unbound"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {unbound ? (
                        <div className="flex flex-col gap-1 text-xs">
                          <Badge variant="outline">Checkout not bound</Badge>
                          <p className="font-mono text-muted-foreground">
                            Revision {source.revision}
                          </p>
                        </div>
                      ) : source.error ? (
                        <p className="max-w-64 text-sm whitespace-normal text-destructive">
                          {source.error}
                        </p>
                      ) : (
                        <div className="flex flex-col gap-1 text-xs">
                          <p>
                            <span className="font-medium">
                              {source.branch ?? "Detached"}
                            </span>{" "}
                            <Badge
                              variant={
                                source.dirty ? "destructive" : "secondary"
                              }
                            >
                              {source.dirty ? "Dirty" : "Clean"}
                            </Badge>
                          </p>
                          <p className="font-mono text-muted-foreground">
                            {source.commit ?? "No commit"}
                          </p>
                          <p className="text-muted-foreground">
                            {source.ahead === null || source.behind === null
                              ? "No local upstream"
                              : `${source.ahead} ahead / ${source.behind} behind`}
                          </p>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {policyLabel(source.revision_policy)}
                      </Badge>
                      <p className="mt-1 max-w-56 truncate font-mono text-xs text-muted-foreground">
                        {source.revision}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-72 truncate font-mono text-xs">
                        {source.checkout ?? "Not bound"}
                      </p>
                      <p className="max-w-72 truncate text-xs text-muted-foreground">
                        {source.remote ?? "No origin remote"}
                      </p>
                      {unbound && (
                        <p className="text-xs text-muted-foreground">
                          Choose a managed clone or link an external checkout.
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="sticky right-0 bg-card text-right">
                      {unbound ? (
                        <div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              working !== null || source.remote === null
                            }
                            onClick={() => onClone(source.id)}
                          >
                            <FolderGit2Icon data-icon="inline-start" />
                            {working === `bind-clone:${source.id}`
                              ? "Cloning…"
                              : "Clone"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working !== null}
                            onClick={() => onLink(source.id)}
                          >
                            <LinkIcon data-icon="inline-start" />
                            Link below
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working !== null}
                            aria-label={`Remove ${source.id} configuration`}
                            onClick={() => onRemove(source.id)}
                          >
                            <Trash2Icon data-icon="inline-start" />
                            {working === `remove:${source.id}`
                              ? "Removing…"
                              : "Remove config"}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working !== null}
                            onClick={() => onPull(source.id)}
                          >
                            {working === `pull:${source.id}` ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <DownloadIcon data-icon="inline-start" />
                            )}
                            {working === `pull:${source.id}`
                              ? "Pulling…"
                              : "Pull"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working !== null}
                            onClick={() => onRemove(source.id)}
                          >
                            <Trash2Icon data-icon="inline-start" />
                            {working === `remove:${source.id}`
                              ? "Removing…"
                              : "Remove"}
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function RevisionPoliciesCard({
  sources,
  working,
  onRevision,
}: {
  sources: SourceCheckout[]
  working: string | null
  onRevision: (
    id: string,
    revisionPolicy: RevisionPolicy,
    revision: string
  ) => void
}) {
  if (sources.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revision Policies</CardTitle>
        <CardDescription>
          Follow a named local branch or pin the exact commit the next Run must
          use. Pull never changes a pinned commit.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {sources.map((source) => (
          <RevisionPolicyForm
            key={`${source.id}:${source.revision_policy}:${source.revision}`}
            source={source}
            disabled={working !== null}
            busy={working === `revision:${source.id}`}
            onSubmit={(policy, revision) =>
              onRevision(source.id, policy, revision)
            }
          />
        ))}
      </CardContent>
    </Card>
  )
}

function RevisionPolicyForm({
  source,
  disabled,
  busy,
  onSubmit,
}: {
  source: SourceCheckout
  disabled: boolean
  busy: boolean
  onSubmit: (policy: RevisionPolicy, revision: string) => void
}) {
  const [policy, setPolicy] = useState(source.revision_policy)
  const [revision, setRevision] = useState(source.revision)

  function changePolicy(values: string[]) {
    const next = values[0] as RevisionPolicy | undefined
    if (!next) return
    setPolicy(next)
    setRevision(
      next === "follow_branch" ? (source.branch ?? "") : (source.commit ?? "")
    )
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (revision.trim()) onSubmit(policy, revision.trim())
  }

  return (
    <form onSubmit={submit}>
      <FieldSet>
        <FieldLegend variant="label">
          {source.id} · {roleLabel(source.role)}
        </FieldLegend>
        <FieldDescription>
          Local {source.local_commit ?? "unavailable"}; remote{" "}
          {source.remote_commit ?? "unavailable"}.
        </FieldDescription>
        <FieldGroup>
          <Field orientation="horizontal" data-disabled={disabled || undefined}>
            <FieldLabel id={`policy-${source.id}`}>Policy</FieldLabel>
            <ToggleGroup
              aria-labelledby={`policy-${source.id}`}
              value={[policy]}
              onValueChange={changePolicy}
              variant="outline"
              size="sm"
              spacing={0}
              disabled={disabled}
            >
              <ToggleGroupItem value="follow_branch">
                Follow Branch
              </ToggleGroupItem>
              <ToggleGroupItem value="pinned_commit">
                Pinned Commit
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field orientation="horizontal" data-disabled={disabled || undefined}>
            <FieldLabel htmlFor={`revision-${source.id}`}>
              {policy === "follow_branch" ? "Branch" : "Commit"}
            </FieldLabel>
            <Input
              id={`revision-${source.id}`}
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              required
            />
          </Field>
          <Button
            type="submit"
            className="self-start"
            size="sm"
            disabled={disabled || !revision.trim()}
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <GitCommitHorizontalIcon data-icon="inline-start" />
            )}
            {busy ? "Saving…" : "Save policy"}
          </Button>
        </FieldGroup>
      </FieldSet>
    </form>
  )
}

function PreflightCard({
  preflight,
  error,
}: {
  preflight: PreflightSnapshot | null
  error: SourcesError | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Next Run Source Set</CardTitle>
        <CardDescription>
          Exact immutable commits and tree digests resolved by the Python
          control plane before Production Run creation.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {error ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Run preflight blocked</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : !preflight ? (
          <Skeleton className="h-32 w-full" />
        ) : preflight.sources.length === 0 ? (
          <Empty className="min-h-40">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitCommitHorizontalIcon />
              </EmptyMedia>
              <EmptyTitle>No Source Set yet</EmptyTitle>
              <EmptyDescription>
                Configure and bind a Source before starting a Production Run.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table className="min-w-[76rem] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Source</TableHead>
                <TableHead className="w-36">Policy</TableHead>
                <TableHead className="w-60">Local commit</TableHead>
                <TableHead className="w-60">Remote commit</TableHead>
                <TableHead className="w-60">Exact commit</TableHead>
                <TableHead className="w-60">Tree digest</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preflight.sources.map((source) => (
                <TableRow key={source.id}>
                  <TableCell className="align-top">
                    <p className="font-medium">{source.id}</p>
                    <p className="text-xs text-muted-foreground">
                      {roleLabel(source.role)}
                    </p>
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant="outline">
                      {policyLabel(source.revision_policy)}
                    </Badge>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {source.revision}
                    </p>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs break-all whitespace-normal">
                    {source.local_commit ?? "unavailable"}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs break-all whitespace-normal">
                    {source.remote_commit ?? "unavailable"}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs break-all whitespace-normal">
                    {source.exact_commit}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs break-all whitespace-normal">
                    {source.tree_digest}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {preflight && preflight.sources.length > 0 && (
        <CardFooter>
          <p className="font-mono text-xs break-all text-muted-foreground">
            Source Set {preflight.source_set_digest}
          </p>
        </CardFooter>
      )}
    </Card>
  )
}

function CloneForm({
  disabled,
  busy,
  onSubmit,
}: {
  disabled: boolean
  busy: boolean
  onSubmit: (payload: { id: string; role: SourceRole; remote: string }) => void
}) {
  const [id, setId] = useState("")
  const [role, setRole] = useState<SourceRole>("implementation")
  const [remote, setRemote] = useState("")

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (id.trim() && remote.trim())
      onSubmit({ id: id.trim(), role, remote: remote.trim() })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Clone managed Source</CardTitle>
        <CardDescription>
          Creates the checkout at Workspace/sources/Source-ID using system Git.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <SourceIdentityFields
              prefix="clone"
              id={id}
              role={role}
              disabled={disabled}
              onIdChange={setId}
              onRoleChange={setRole}
            />
            <Field data-disabled={disabled || undefined}>
              <FieldLabel htmlFor="clone-remote">Git remote</FieldLabel>
              <Input
                id="clone-remote"
                aria-describedby="clone-remote-description"
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
                placeholder="git@example.com:team/project.git"
                disabled={disabled}
                required
              />
              <FieldDescription id="clone-remote-description">
                Git uses your SSH agent and credential helpers; credentials do
                not belong in this value.
              </FieldDescription>
            </Field>
            <Button
              type="submit"
              className="self-start"
              disabled={disabled || !id.trim() || !remote.trim()}
            >
              <FolderGit2Icon data-icon="inline-start" />
              {busy ? "Cloning…" : "Clone Source"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}

function LinkForm({
  configuredSource,
  disabled,
  busy,
  onSubmit,
}: {
  configuredSource?: SourceCheckout
  disabled: boolean
  busy: boolean
  onSubmit: (payload: {
    id: string
    role: SourceRole
    checkout: string
  }) => void
}) {
  const [id, setId] = useState(configuredSource?.id ?? "")
  const [role, setRole] = useState<SourceRole>(
    configuredSource?.role ?? "documentation"
  )
  const [checkout, setCheckout] = useState("")

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (id.trim() && checkout.trim())
      onSubmit({ id: id.trim(), role, checkout: checkout.trim() })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {configuredSource
            ? `Bind ${configuredSource.id}`
            : "Link existing Source"}
        </CardTitle>
        <CardDescription>
          {configuredSource
            ? "Adds only this machine's checkout binding; the shared Source definition stays unchanged."
            : "Registers an external working tree without moving or copying it."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <SourceIdentityFields
              prefix="link"
              id={id}
              role={role}
              disabled={disabled}
              locked={configuredSource !== undefined}
              onIdChange={setId}
              onRoleChange={setRole}
            />
            <Field data-disabled={disabled || undefined}>
              <FieldLabel htmlFor="link-checkout">
                Local checkout path
              </FieldLabel>
              <Input
                id="link-checkout"
                aria-describedby="link-checkout-description"
                value={checkout}
                onChange={(event) => setCheckout(event.target.value)}
                placeholder="/Users/alice/projects/catalog-docs"
                disabled={disabled}
                required
              />
              <FieldDescription id="link-checkout-description">
                Linked paths remain externally owned and are never deleted by
                the Workspace.
              </FieldDescription>
            </Field>
            <Button
              type="submit"
              className="self-start"
              disabled={disabled || !id.trim() || !checkout.trim()}
            >
              <LinkIcon data-icon="inline-start" />
              {busy
                ? "Linking…"
                : configuredSource
                  ? "Bind checkout"
                  : "Link Source"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}

function SourceIdentityFields({
  prefix,
  id,
  role,
  disabled,
  locked = false,
  onIdChange,
  onRoleChange,
}: {
  prefix: string
  id: string
  role: SourceRole
  disabled: boolean
  locked?: boolean
  onIdChange: (value: string) => void
  onRoleChange: (value: SourceRole) => void
}) {
  const identityDisabled = disabled || locked
  return (
    <>
      <Field data-disabled={identityDisabled || undefined}>
        <FieldLabel htmlFor={`${prefix}-id`}>Source ID</FieldLabel>
        <Input
          id={`${prefix}-id`}
          aria-describedby={`${prefix}-id-description`}
          value={id}
          onChange={(event) => onIdChange(event.target.value)}
          placeholder="catalog-docs"
          disabled={identityDisabled}
          required
        />
        <FieldDescription id={`${prefix}-id-description`}>
          Stable across refreshes and Production Runs; letters, numbers, dots,
          underscores, and hyphens only.
        </FieldDescription>
      </Field>
      <Field data-disabled={identityDisabled || undefined}>
        <FieldLabel htmlFor={`${prefix}-role`}>Role</FieldLabel>
        <NativeSelect
          id={`${prefix}-role`}
          value={role}
          onChange={(event) => onRoleChange(event.target.value as SourceRole)}
          disabled={identityDisabled}
        >
          {roles.map((item) => (
            <NativeSelectOption key={item.value} value={item.value}>
              {item.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </>
  )
}

function DeleteManagedDialog({
  source,
  disabled,
  onDelete,
}: {
  source: { id: string; checkout: string }
  disabled: boolean
  onDelete: (confirmation: string) => void
}) {
  const [confirmation, setConfirmation] = useState("")
  return (
    <AlertDialog>
      <AlertDialogTrigger
        disabled={disabled}
        render={<Button variant="destructive" size="sm" />}
      >
        <Trash2Icon data-icon="inline-start" />
        Delete checkout
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete managed checkout?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes {source.checkout}. Type {source.id} to
            confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor={`delete-${source.id}`}>
            Source ID confirmation
          </FieldLabel>
          <Input
            id={`delete-${source.id}`}
            aria-describedby={`delete-${source.id}-description`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
          />
          <FieldDescription id={`delete-${source.id}-description`}>
            Enter the exact stable Source ID shown above.
          </FieldDescription>
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={confirmation !== source.id}
            onClick={() => onDelete(confirmation)}
          >
            Delete checkout
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function SourcesLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex w-full max-w-[90rem] flex-col gap-6 px-5 py-7"
    >
      <p className="sr-only" role="status">
        Loading Sources
      </p>
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-72 w-full" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </main>
  )
}

function roleLabel(role: SourceRole) {
  return roles.find((item) => item.value === role)?.label ?? role
}

function policyLabel(policy: RevisionPolicy) {
  return policy === "follow_branch" ? "Follow Branch" : "Pinned Commit"
}
