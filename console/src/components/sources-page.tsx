import { useEffect, useState, type FormEvent } from "react"
import {
  CircleAlertIcon,
  FolderGit2Icon,
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
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  cloneSource,
  deleteManagedSource,
  fetchSources,
  linkSource,
  removeSource,
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
  const [working, setWorking] = useState<string | null>(null)

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

  async function mutate(
    label: string,
    operation: () => Promise<SourcesSnapshot>
  ) {
    setWorking(label)
    setError(null)
    try {
      setSnapshot(await operation())
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
        onRemove={(id) => mutate(`remove:${id}`, () => removeSource(token, id))}
      />

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
          disabled={working !== null}
          busy={working === "link"}
          onSubmit={(payload) =>
            mutate("link", () => linkSource(token, payload))
          }
        />
      </div>
    </main>
  )
}

function SourceTable({
  sources,
  working,
  onRemove,
}: {
  sources: SourceCheckout[]
  working: string | null
  onRemove: (id: string) => void
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
                <TableHead>Checkout</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => (
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
                    {source.error ? (
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
                            variant={source.dirty ? "destructive" : "secondary"}
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
                    <p className="max-w-72 truncate font-mono text-xs">
                      {source.checkout ?? "Not bound"}
                    </p>
                    <p className="max-w-72 truncate text-xs text-muted-foreground">
                      {source.remote ?? "No origin remote"}
                    </p>
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
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
            <Field>
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
  disabled,
  busy,
  onSubmit,
}: {
  disabled: boolean
  busy: boolean
  onSubmit: (payload: {
    id: string
    role: SourceRole
    checkout: string
  }) => void
}) {
  const [id, setId] = useState("")
  const [role, setRole] = useState<SourceRole>("documentation")
  const [checkout, setCheckout] = useState("")

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (id.trim() && checkout.trim())
      onSubmit({ id: id.trim(), role, checkout: checkout.trim() })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Link existing Source</CardTitle>
        <CardDescription>
          Registers an external working tree without moving or copying it.
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
              onIdChange={setId}
              onRoleChange={setRole}
            />
            <Field>
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
              {busy ? "Linking…" : "Link Source"}
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
  onIdChange,
  onRoleChange,
}: {
  prefix: string
  id: string
  role: SourceRole
  disabled: boolean
  onIdChange: (value: string) => void
  onRoleChange: (value: SourceRole) => void
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${prefix}-id`}>Source ID</FieldLabel>
        <Input
          id={`${prefix}-id`}
          aria-describedby={`${prefix}-id-description`}
          value={id}
          onChange={(event) => onIdChange(event.target.value)}
          placeholder="catalog-docs"
          disabled={disabled}
          required
        />
        <FieldDescription id={`${prefix}-id-description`}>
          Stable across refreshes and Production Runs; letters, numbers, dots,
          underscores, and hyphens only.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-role`}>Role</FieldLabel>
        <NativeSelect
          id={`${prefix}-role`}
          value={role}
          onChange={(event) => onRoleChange(event.target.value as SourceRole)}
          disabled={disabled}
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
