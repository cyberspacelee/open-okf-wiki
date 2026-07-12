import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  PlusIcon,
  SaveIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  loadConnections,
  saveProfile,
  selectWorkspaceModels,
  testProfile,
  type ConnectionsState,
} from "@/lib/connections"

const roles = ["planner", "worker", "verifier", "renderer", "query"] as const

export function GatewayConnections({ token }: { token: string }) {
  const [state, setState] = useState<ConnectionsState | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState("")
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setState(await loadConnections(token))
      setError("")
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    let active = true
    loadConnections(token).then(
      (next) => {
        if (active) {
          setState(next)
          setError("")
          setLoading(false)
        }
      },
      (reason: Error) => {
        if (active) {
          setError(reason.message)
          setLoading(false)
        }
      }
    )
    return () => {
      active = false
    }
  }, [token])

  if (!state) {
    if (!loading) {
      return (
        <div className="flex flex-col gap-4">
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Connection settings unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button
            className="self-start"
            variant="outline"
            onClick={() =>
              void reload().catch((reason: Error) => setError(reason.message))
            }
          >
            Retry
          </Button>
        </div>
      )
    }
    return (
      <div aria-busy="true" className="flex flex-col gap-5">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  async function run(action: string, operation: () => Promise<unknown>) {
    setBusy(action)
    setError("")
    setNotice("")
    try {
      await operation()
      await reload()
      setNotice(
        action === "profile" ? "Gateway Profile saved." : `${action} completed.`
      )
      return true
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Connection action failed."
      )
      return false
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="pb-7" aria-labelledby="connections-title">
        <p className="mb-2 text-sm text-muted-foreground">
          Machine-local settings
        </p>
        <h1
          id="connections-title"
          className="text-3xl font-semibold tracking-tight"
        >
          Connections
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          Reuse enterprise LLM gateways across Workspaces. Credentials stay in
          this machine&apos;s credential store and never enter shared Workspace
          or Run data.
        </p>
      </section>
      <Separator />

      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Connection action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>Settings updated</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <ProfileList
        state={state}
        busy={busy}
        onTest={(profileId, model) =>
          run(`Test ${profileId}`, () => testProfile(token, profileId, model))
        }
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <ProfileForm
          busy={busy === "profile"}
          onSave={(profile, credential) =>
            run("profile", () => saveProfile(token, profile, credential))
          }
        />
        <WorkspaceModels
          state={state}
          busy={busy === "Workspace selection"}
          onSave={(models) =>
            run("Workspace selection", () =>
              selectWorkspaceModels(token, models)
            )
          }
        />
      </div>
    </div>
  )
}

function ProfileList({
  state,
  busy,
  onTest,
}: {
  state: ConnectionsState
  busy: string
  onTest: (profileId: string, model: string) => void
}) {
  const [testModel, setTestModel] = useState(
    state.models.default_model || state.profiles[0]?.models[0] || ""
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gateway Profiles</CardTitle>
        <CardDescription>
          Profile listings expose connection identity and header names, never
          credential or header values.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {state.profiles.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>No Gateway Profiles</EmptyTitle>
              <EmptyDescription>
                Add a machine-local connection before selecting a Workspace
                model.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="test-model">
                  Capability test model
                </FieldLabel>
                <FieldDescription id="test-model-description">
                  Use a model returned by the selected enterprise gateway.
                </FieldDescription>
              </FieldContent>
              <Input
                id="test-model"
                aria-describedby="test-model-description"
                value={testModel}
                onChange={(event) => setTestModel(event.target.value)}
                placeholder="enterprise-model"
              />
            </Field>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Credential</TableHead>
                  <TableHead>Capabilities</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.profiles.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <strong>{profile.name}</strong>
                        <code>{profile.gateway_id}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="block max-w-64 truncate">
                        {profile.base_url}
                      </code>
                      {profile.header_names.length > 0 && (
                        <small>
                          Headers: {profile.header_names.join(", ")}
                        </small>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          profile.credential_configured
                            ? "secondary"
                            : "outline"
                        }
                      >
                        <KeyRoundIcon data-icon="inline-start" />
                        {profile.credential_backend || "Missing"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          profile.capabilities.authentication
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {profile.capabilities.authentication
                          ? "Verified"
                          : "Not tested"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!testModel.trim() || Boolean(busy)}
                        onClick={() => onTest(profile.id, testModel.trim())}
                      >
                        {busy === `Test ${profile.id}` ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <FlaskConicalIcon data-icon="inline-start" />
                        )}
                        Test
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ProfileForm({
  busy,
  onSave,
}: {
  busy: boolean
  onSave: (
    profile: Parameters<typeof saveProfile>[1],
    credential: string
  ) => Promise<boolean>
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const headers = Object.fromEntries(
      String(data.get("headers") || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=")
          return separator < 1
            ? [line, ""]
            : [
                line.slice(0, separator).trim(),
                line.slice(separator + 1).trim(),
              ]
        })
    )
    if (
      await onSave(
        {
          id: String(data.get("id")),
          name: String(data.get("name")),
          gateway_id: String(data.get("gateway_id")),
          base_url: String(data.get("base_url")),
          headers,
        },
        String(data.get("credential"))
      )
    ) {
      form.reset()
    }
  }

  return (
    <Card>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>Add Gateway Profile</CardTitle>
          <CardDescription>
            OpenAI-compatible connection details are machine-local. Put bearer
            tokens only in the credential field.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="profile-name">Profile name</FieldLabel>
              </FieldContent>
              <Input
                id="profile-name"
                name="name"
                required
                placeholder="Enterprise Gateway"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="profile-id">Profile ID</FieldLabel>
              </FieldContent>
              <Input
                id="profile-id"
                name="id"
                required
                placeholder="enterprise"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="gateway-id">Gateway ID</FieldLabel>
              </FieldContent>
              <Input
                id="gateway-id"
                name="gateway_id"
                required
                placeholder="corp-openai"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="base-url">
                  OpenAI-compatible base URL
                </FieldLabel>
                <FieldDescription id="base-url-description">
                  User info, query strings, and fragments are rejected.
                </FieldDescription>
              </FieldContent>
              <Input
                id="base-url"
                aria-describedby="base-url-description"
                name="base_url"
                type="url"
                required
                placeholder="https://gateway.example/v1"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="headers">
                  Optional non-secret headers
                </FieldLabel>
                <FieldDescription id="headers-description">
                  One NAME=VALUE pair per line. Secret-bearing names are
                  rejected.
                </FieldDescription>
              </FieldContent>
              <Textarea
                id="headers"
                aria-describedby="headers-description"
                name="headers"
                placeholder="X-Tenant=knowledge"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="credential">Credential</FieldLabel>
                <FieldDescription id="credential-description">
                  Stored in the OS credential store or a local 0600 fallback.
                  macOS uses the default Keychain and may show an OS access
                  prompt.
                </FieldDescription>
              </FieldContent>
              <Input
                id="credential"
                aria-describedby="credential-description"
                name="credential"
                type="password"
                required
                autoComplete="off"
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={busy}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            Save profile
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function WorkspaceModels({
  state,
  busy,
  onSave,
}: {
  state: ConnectionsState
  busy: boolean
  onSave: (models: Parameters<typeof selectWorkspaceModels>[1]) => void
}) {
  const selected = state.models.gateway_profile || state.profiles[0]?.id || ""

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const roleOverrides = Object.fromEntries(
      roles
        .map((role) => [role, String(data.get(role) || "").trim()])
        .filter(([, value]) => value)
    )
    onSave({
      profile_id: String(data.get("profile_id")),
      default_model: String(data.get("default_model")),
      concurrency: Number(data.get("concurrency")),
      budgets: { total_tokens: Number(data.get("total_tokens")) },
      role_overrides: roleOverrides,
    })
  }

  return (
    <Card>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>Workspace model selection</CardTitle>
          <CardDescription>
            The normal path uses one default model. Advanced role overrides stay
            optional.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="workspace-profile">
                  Gateway Profile
                </FieldLabel>
              </FieldContent>
              <NativeSelect
                key={selected}
                id="workspace-profile"
                name="profile_id"
                defaultValue={selected}
                required
              >
                <NativeSelectOption value="">
                  Select a profile
                </NativeSelectOption>
                {state.profiles.map((profile) => (
                  <NativeSelectOption key={profile.id} value={profile.id}>
                    {profile.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="default-model">Default model</FieldLabel>
                <FieldDescription id="default-model-description">
                  Used for every Agent Role without an override.
                </FieldDescription>
              </FieldContent>
              <Input
                id="default-model"
                aria-describedby="default-model-description"
                name="default_model"
                required
                defaultValue={state.models.default_model || ""}
                placeholder="enterprise-model"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="concurrency">Concurrency</FieldLabel>
                <FieldDescription id="concurrency-description">
                  Maximum parallel model requests for this Workspace.
                </FieldDescription>
              </FieldContent>
              <Input
                id="concurrency"
                aria-describedby="concurrency-description"
                name="concurrency"
                type="number"
                min="1"
                required
                defaultValue={state.models.concurrency}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="total-tokens">
                  Total token budget
                </FieldLabel>
                <FieldDescription id="total-tokens-description">
                  Positive upper bound recorded in each resolved Run snapshot.
                </FieldDescription>
              </FieldContent>
              <Input
                id="total-tokens"
                aria-describedby="total-tokens-description"
                name="total_tokens"
                type="number"
                min="1"
                required
                defaultValue={state.models.budgets.total_tokens || 100000}
              />
            </Field>
            <Collapsible>
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between"
                  />
                }
              >
                Advanced role overrides
                <ChevronDownIcon data-icon="inline-end" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-5">
                <FieldSet>
                  <FieldLegend variant="label">Agent Role models</FieldLegend>
                  <FieldDescription>
                    Leave blank to inherit the default model.
                  </FieldDescription>
                  <FieldGroup>
                    {roles.map((role) => (
                      <Field key={role} orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor={`role-${role}`}>
                            {role[0].toUpperCase() + role.slice(1)}
                          </FieldLabel>
                        </FieldContent>
                        <Input
                          id={`role-${role}`}
                          name={role}
                          defaultValue={state.models.role_overrides[role] || ""}
                          placeholder="Use default"
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={busy || state.profiles.length === 0}>
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            Save Workspace selection
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
