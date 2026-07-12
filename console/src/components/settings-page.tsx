import { useEffect, useState, type FormEvent } from "react"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  RefreshCwIcon,
  SaveIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  fetchSettings,
  saveSettings,
  type SettingsError,
  type WorkspaceSettings,
} from "@/lib/settings"

type Draft = {
  name: string
  publicationPath: string
  bundleName: string
  excludedPaths: string
  priorities: string
  majorDisposition: string
  majorReason: string
  supportingDisposition: string
  supportingReason: string
  compactNavigation: boolean
}

type FieldErrors = Partial<Record<keyof Draft, string>>

export function SettingsPage({ token }: { token: string }) {
  const [reload, setReload] = useState(0)
  const [snapshot, setSnapshot] = useState<WorkspaceSettings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<SettingsError | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchSettings(token, controller.signal).then(
      (settings) => {
        setError(null)
        setSnapshot(settings)
        setDraft(toDraft(settings))
      },
      (reason: SettingsError) => {
        if (!controller.signal.aborted) setError(reason)
      }
    )
    return () => controller.abort()
  }, [reload, token])

  if (error && !draft) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-8 lg:px-8">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Workspace settings need attention</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
        <Button
          className="self-start"
          variant="outline"
          onClick={reloadSettings}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Reload settings
        </Button>
      </div>
    )
  }

  if (!snapshot || !draft) return <SettingsLoading />

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!snapshot || !draft) return
    const validation = validate(draft)
    setFieldErrors(validation)
    setSaved(false)
    setError(null)
    if (Object.keys(validation).length) return

    setSaving(true)
    try {
      const updated = await saveSettings(token, {
        configuration_digest: snapshot.configuration_digest,
        definition: {
          ...snapshot.definition,
          project: { ...snapshot.definition.project, name: draft.name.trim() },
          publication: {
            ...snapshot.definition.publication,
            path: draft.publicationPath.trim(),
            bundle_name: draft.bundleName.trim() || null,
          },
          profile: {
            ...snapshot.definition.profile,
            java_excluded_paths: lines(draft.excludedPaths),
            priorities: parsePriorities(draft.priorities),
            dispositions: dispositions(draft),
          },
        },
        local_settings: {
          ...snapshot.local_settings,
          ui: {
            ...snapshot.local_settings.ui,
            compact_navigation: draft.compactNavigation,
          },
        },
      })
      setSnapshot(updated)
      setDraft(toDraft(updated))
      setSaved(true)
    } catch (reason) {
      setError(reason as SettingsError)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9"
      onSubmit={submit}
      noValidate
    >
      <section className="border-b pb-6" aria-labelledby="settings-title">
        <p className="mb-2 text-sm text-muted-foreground">
          Workspace configuration
        </p>
        <h1
          id="settings-title"
          className="text-3xl font-semibold tracking-tight"
        >
          Workspace settings
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Shared production intent stays in workspace.toml. Machine-specific
          preferences stay under .okf-wiki.
        </p>
      </section>

      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            {error.kind === "stale"
              ? "Settings changed elsewhere"
              : "Settings not saved"}
          </AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {saved && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <CircleCheckIcon aria-hidden="true" /> Settings saved.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Producer Project</CardTitle>
          <CardDescription>
            The stable identity of this product or project.
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">Shared</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-disabled>
              <FieldLabel htmlFor="project-id">Project ID</FieldLabel>
              <Input
                id="project-id"
                value={snapshot.definition.project.id}
                disabled
              />
              <FieldDescription>
                Immutable after Workspace initialization.
              </FieldDescription>
            </Field>
            <Field data-invalid={Boolean(fieldErrors.name)}>
              <FieldLabel htmlFor="project-name">Display name</FieldLabel>
              <Input
                id="project-name"
                value={draft.name}
                required
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby="project-name-description project-name-error"
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
              <FieldDescription id="project-name-description">
                Shown throughout the Console and Bundle metadata.
              </FieldDescription>
              <FieldError id="project-name-error">
                {fieldErrors.name}
              </FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publication</CardTitle>
          <CardDescription>
            Bundle naming and destination relative to the Workspace.
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">Shared</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={Boolean(fieldErrors.bundleName)}>
              <FieldLabel htmlFor="bundle-name">Bundle name</FieldLabel>
              <Input
                id="bundle-name"
                value={draft.bundleName}
                placeholder={
                  draft.name.trim() || "Defaults to the project name"
                }
                aria-invalid={Boolean(fieldErrors.bundleName)}
                onChange={(event) =>
                  setDraft({ ...draft, bundleName: event.target.value })
                }
              />
              <FieldDescription>
                Leave blank to use the Producer Project display name.
              </FieldDescription>
              <FieldError>{fieldErrors.bundleName}</FieldError>
            </Field>
            <Field data-invalid={Boolean(fieldErrors.publicationPath)}>
              <FieldLabel htmlFor="publication-path">
                Publication target
              </FieldLabel>
              <Input
                id="publication-path"
                value={draft.publicationPath}
                required
                aria-invalid={Boolean(fieldErrors.publicationPath)}
                onChange={(event) =>
                  setDraft({ ...draft, publicationPath: event.target.value })
                }
              />
              <FieldDescription>
                Directory where the accepted Knowledge Bundle is published.
              </FieldDescription>
              <FieldError>{fieldErrors.publicationPath}</FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Producer Profile</CardTitle>
          <CardDescription>
            Versioned coverage rules applied to future Production Runs.
          </CardDescription>
          <CardAction>
            <Badge variant="secondary">Shared</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={Boolean(fieldErrors.excludedPaths)}>
              <FieldLabel htmlFor="java-excluded-paths">
                Java excluded paths
              </FieldLabel>
              <Textarea
                id="java-excluded-paths"
                rows={4}
                value={draft.excludedPaths}
                placeholder={"generated/**\nvendor/**"}
                aria-invalid={Boolean(fieldErrors.excludedPaths)}
                onChange={(event) =>
                  setDraft({ ...draft, excludedPaths: event.target.value })
                }
              />
              <FieldDescription>
                One safe relative glob per line.
              </FieldDescription>
              <FieldError>{fieldErrors.excludedPaths}</FieldError>
            </Field>
            <Field data-invalid={Boolean(fieldErrors.priorities)}>
              <FieldLabel htmlFor="profile-priorities">
                Obligation priorities
              </FieldLabel>
              <Textarea
                id="profile-priorities"
                rows={4}
                value={draft.priorities}
                placeholder={"data_contract=major\ntable=supporting"}
                aria-invalid={Boolean(fieldErrors.priorities)}
                onChange={(event) =>
                  setDraft({ ...draft, priorities: event.target.value })
                }
              />
              <FieldDescription>
                One obligation=major or obligation=supporting rule per line.
              </FieldDescription>
              <FieldError>{fieldErrors.priorities}</FieldError>
            </Field>
            <DispositionFields
              priority="major"
              disposition={draft.majorDisposition}
              reason={draft.majorReason}
              errors={fieldErrors}
              onDisposition={(majorDisposition) =>
                setDraft({ ...draft, majorDisposition })
              }
              onReason={(majorReason) => setDraft({ ...draft, majorReason })}
            />
            <DispositionFields
              priority="supporting"
              disposition={draft.supportingDisposition}
              reason={draft.supportingReason}
              errors={fieldErrors}
              onDisposition={(supportingDisposition) =>
                setDraft({ ...draft, supportingDisposition })
              }
              onReason={(supportingReason) =>
                setDraft({ ...draft, supportingReason })
              }
            />
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Local preferences</CardTitle>
          <CardDescription>
            Used only on this machine and never shared as production intent.
          </CardDescription>
          <CardAction>
            <Badge variant="outline">Local</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="compact-navigation">
              Compact navigation
            </FieldLabel>
            <Switch
              id="compact-navigation"
              checked={draft.compactNavigation}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, compactNavigation: checked })
              }
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3 border-t pt-6">
        <Button type="submit" disabled={saving}>
          <SaveIcon data-icon="inline-start" />
          {saving ? "Saving…" : "Save settings"}
        </Button>
        {error?.kind === "stale" && (
          <Button type="button" variant="outline" onClick={reloadSettings}>
            <RefreshCwIcon data-icon="inline-start" /> Reload settings
          </Button>
        )}
      </div>
    </form>
  )

  function reloadSettings() {
    setError(null)
    setSnapshot(null)
    setDraft(null)
    setReload((value) => value + 1)
  }
}

function SettingsLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading workspace settings"
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8"
    >
      <p className="sr-only" role="status">
        Loading settings
      </p>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </main>
  )
}

function toDraft(settings: WorkspaceSettings): Draft {
  return {
    name: settings.definition.project.name,
    publicationPath: settings.definition.publication.path,
    bundleName: settings.definition.publication.bundle_name ?? "",
    excludedPaths:
      settings.definition.profile.java_excluded_paths?.join("\n") ?? "",
    priorities: Object.entries(settings.definition.profile.priorities)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    majorDisposition:
      settings.definition.profile.dispositions.major?.disposition ?? "",
    majorReason: settings.definition.profile.dispositions.major?.reason ?? "",
    supportingDisposition:
      settings.definition.profile.dispositions.supporting?.disposition ?? "",
    supportingReason:
      settings.definition.profile.dispositions.supporting?.reason ?? "",
    compactNavigation: settings.local_settings.ui.compact_navigation,
  }
}

function validate(draft: Draft): FieldErrors {
  const errors: FieldErrors = {}
  if (!draft.name.trim()) errors.name = "Display name is required."
  if (!draft.publicationPath.trim())
    errors.publicationPath = "Publication target is required."
  const unsafe = lines(draft.excludedPaths)?.find(
    (path) => path.startsWith("/") || path.split(/[\\/]/).includes("..")
  )
  if (unsafe)
    errors.excludedPaths = `Use a safe relative path instead of “${unsafe}”.`
  try {
    parsePriorities(draft.priorities)
  } catch (error) {
    errors.priorities = String(error)
  }
  if (draft.majorDisposition === "excluded" && !draft.majorReason.trim()) {
    errors.majorReason =
      "A reason is required when Major Obligations are excluded."
  }
  if (
    ["deferred", "excluded"].includes(draft.supportingDisposition) &&
    !draft.supportingReason.trim()
  ) {
    errors.supportingReason =
      "A reason is required when Supporting Obligations are deferred or excluded."
  }
  return errors
}

function lines(value: string) {
  const values = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return values.length ? values : null
}

function parsePriorities(value: string) {
  const priorities: Record<string, "major" | "supporting"> = {}
  for (const line of lines(value) ?? []) {
    const [key, priority, ...extra] = line.split("=").map((part) => part.trim())
    if (
      !key ||
      !priority ||
      extra.length ||
      !["major", "supporting"].includes(priority)
    ) {
      throw new Error(`Invalid priority rule “${line}”.`)
    }
    if (key in priorities) throw new Error(`Duplicate priority rule “${key}”.`)
    priorities[key] = priority as "major" | "supporting"
  }
  return priorities
}

function dispositions(draft: Draft) {
  const result: WorkspaceSettings["definition"]["profile"]["dispositions"] = {}
  if (draft.majorDisposition) {
    result.major = {
      disposition: draft.majorDisposition as NonNullable<
        typeof result.major
      >["disposition"],
      reason: draft.majorReason.trim() || null,
    }
  }
  if (draft.supportingDisposition) {
    result.supporting = {
      disposition: draft.supportingDisposition as NonNullable<
        typeof result.supporting
      >["disposition"],
      reason: draft.supportingReason.trim() || null,
    }
  }
  return result
}

function DispositionFields({
  priority,
  disposition,
  reason,
  errors,
  onDisposition,
  onReason,
}: {
  priority: "major" | "supporting"
  disposition: string
  reason: string
  errors: FieldErrors
  onDisposition: (value: string) => void
  onReason: (value: string) => void
}) {
  const title =
    priority === "major" ? "Major Obligations" : "Supporting Obligations"
  const reasonError =
    priority === "major" ? errors.majorReason : errors.supportingReason
  return (
    <FieldSet>
      <FieldLegend variant="label">{title}</FieldLegend>
      <FieldDescription>
        Default disposition for {priority} coverage obligations.
      </FieldDescription>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${priority}-disposition`}>
            Disposition
          </FieldLabel>
          <NativeSelect
            className="w-full"
            id={`${priority}-disposition`}
            value={disposition}
            onChange={(event) => onDisposition(event.target.value)}
          >
            <NativeSelectOption value="">
              Use the Producer default
            </NativeSelectOption>
            <NativeSelectOption value="open">Open</NativeSelectOption>
            <NativeSelectOption value="covered">Covered</NativeSelectOption>
            {priority === "supporting" && (
              <NativeSelectOption value="deferred">Deferred</NativeSelectOption>
            )}
            <NativeSelectOption value="excluded">Excluded</NativeSelectOption>
            <NativeSelectOption value="blocked">Blocked</NativeSelectOption>
            <NativeSelectOption value="failed">Failed</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field data-invalid={Boolean(reasonError)}>
          <FieldLabel htmlFor={`${priority}-reason`}>Reason</FieldLabel>
          <Input
            id={`${priority}-reason`}
            value={reason}
            aria-invalid={Boolean(reasonError)}
            onChange={(event) => onReason(event.target.value)}
          />
          <FieldDescription>
            Required for deferred or excluded coverage.
          </FieldDescription>
          <FieldError>{reasonError}</FieldError>
        </Field>
      </FieldGroup>
    </FieldSet>
  )
}
