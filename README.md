# Open OKF Wiki

Open OKF Wiki is a Pi extension that produces a source-grounded repository Wiki
from one repository or an existing multi-source `workspace.yaml`.

```bash
pnpm install
pi install .
```

The host skill is declared in the package `pi.skills` field and loaded by
`pi install`. It is not read from the repository `.agents/` directory.

Run Pi in the repository or Wiki workspace:

```text
/wiki [focus]
/wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]
/wiki source add link <local-path> [--name <name>] [--workspace <dir>]
/wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]
/wiki regenerate [focus]
/wiki status [run-id] [lead|batch-N/task-id] [--process]
/wiki runs
/wiki pause
/wiki resume [run-id]
/wiki cancel [run-id]
```

The default command updates the Wiki. `regenerate` rebuilds its page topology.
A Git repository without `workspace.yaml` works directly as one implicit source.
Use `init` only to create an explicit workspace, then add one or more sources.

`source add link` requires a local Git repository root. It creates a symlink on
Linux/macOS and a directory junction on Windows. Use `source add clone` when a
link is unsuitable or the source is remote; `--ref` checks out a branch, tag, or
commit. `init` defaults to the current directory, Chinese output, and standard
source ignores. Repeat `--exclude` for workspace-specific source globs.

Explicit workspaces can tune Wiki Agent execution in `workspace.yaml`:

```yaml
wiki:
  exclude: []
  maxConcurrentAgents: 3
  transientRetries: 1
  baseRetryDelayMs: 1000
  sessionTimeoutSeconds: 1200
  maxDelegatedTasks: 24
  maxDelegateBatches: 8
  maxTurnsPerSession: 60
  maxToolCallsPerSession: 120
  maxTurnsPerLeadSession: 200
  maxToolCallsPerLeadSession: 400
  models: {}
  generation:
    audience: [maintainers, integrators]
    purpose: Explain the system's domains, behavior, and extension points.
    focus:
      include: [architecture, runtime behavior, public contracts]
      exclude: [generated files]
    granularity:
      preferChildPagesFor: [flows, states, data structures]
    templates:
      requiredSections: [Overview, Source evidence]
    review:
      mustCover: [cross-domain links, operational flows]
```

All execution limit values are integers:

| Setting | Default | Valid range | Meaning |
| --- | ---: | ---: | --- |
| `maxConcurrentAgents` | `3` | `2..64` sessions | Total concurrent model sessions, including the Lead and delegated Agents. |
| `transientRetries` | `1` | `0..10` retries | Fresh-session retries for each transient Lead or delegated Agent failure; `0` disables them. |
| `baseRetryDelayMs` | `1000` | `0..300000` ms | Full-jitter exponential backoff base when the provider supplies no `Retry-After`; `0` removes the local delay. |
| `sessionTimeoutSeconds` | `1200` | `1..2147483` seconds | Delegated sessions: wall-clock deadline. Lead: thinking time only; `wiki_delegate_collect` wait does not count. |
| `maxDelegatedTasks` | `24` | `1..10000` tasks | Maximum delegated tasks started across the complete run, including resumed work but excluding retries. |
| `maxDelegateBatches` | `8` | `1..1000` batches | Maximum asynchronous delegation batches started across the complete run. |
| `maxTurnsPerSession` | `60` | `1..100000` turns | Hard limit for model turns in each delegated Pi session. |
| `maxToolCallsPerSession` | `120` | `1..1000000` calls | Hard limit for tool calls in each delegated Pi session. |
| `maxTurnsPerLeadSession` | `200` | `1..100000` turns | Hard limit for model turns in the Lead Pi session. |
| `maxToolCallsPerLeadSession` | `400` | `1..1000000` calls | Hard limit for tool calls in the Lead Pi session. |

Timeouts count as transient failures and consume the same retry budget. Provider
`Retry-After` values take precedence over the configured backoff base.
Task and batch limits are run-wide and remain consumed after pause/resume.
Turn and tool-call limits are enforced per persistent Pi session. Token, cost,
cache, and context-window usage are reported for observation but are not hard
limits.

`models` optionally overrides the Pi model for any of `lead`, `research`,
`write`, and `review`. Omitted roles inherit the model and thinking level active
when the Wiki run starts. Each override requires a Pi registry `provider` and
`id`; `thinkingLevel` is optional and accepts `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`:

```yaml
wiki:
  models:
    research:
      provider: your-provider
      id: your-model-id
      thinkingLevel: high
```

Configured model identifiers must already exist in the active Pi model
registry. A resumed session restores its persisted model instead of silently
switching to a newly configured model.

`language: zh` or `language: en` controls generated titles, descriptions, body
text, writer/reviewer handoffs, and deterministic index text. Research briefs
are model-readable and do not have to use that language. Code identifiers and
source citations remain unchanged.

Each run plans a WikiSpec as a Candidate page path list. The host derives
pageType and cluster identity. Published content uses this cluster topology:

```text
wiki/
  index.md
  overview.md
  architecture.md                 # optional
  <domain>/
    index.md
    domain.md
    <concept>/
      concept.md
      models.md / flows.md / sequences.md / states.md / data.md / modules.md
```

Root, domain, and concept indexes are generated deterministically. Page
frontmatter is parsed and canonicalized in process, so generation does not
require an external `yamlformatter`. Invalid pages are rejected before they can
replace existing content. Publication additionally requires independent review
coverage for the current Spec and page revisions.

Every Lead and delegated Agent attempt uses a persistent Pi session with
auto-compaction. Pause/resume reopens the exact session, including its saved
model, thinking level, messages, tool results, and compaction history. When a
session approaches its context limit, Pi summarizes older context while
keeping recent work. Pi itself supports `compaction.enabled`,
`compaction.reserveTokens`, and `compaction.keepRecentTokens` settings. The Wiki
runtime currently uses Pi's in-memory defaults (`reserveTokens: 16384`,
`keepRecentTokens: 20000`); these values are not configurable in
`workspace.yaml`, and project or user Pi settings are not inherited by Wiki
sessions.

Progress is emitted as plain text. Runs are durable and can be inspected,
paused, resumed, or cancelled without a TUI.

## Design

`/wiki` is the Pi adapter. Tests call the same producer factory:

```ts
const producer = createProductionWikiProducer();
const handle = await producer.start({ cwd, focus });
const view = await handle.view();
const result = await handle.result();
```

The outer lifecycle keeps deterministic repository and publication work in
code:

```text
Inspect -> Spec plan -> dynamic Lead/Writer loop -> Review -> Validate -> Publish
```

The Lead loop adapts research fan-out, targeted follow-ups, verification, and
page grouping to the repository. It is intentionally Wiki-specific; the project
does not ship a generic workflow DSL or depend on Pydantic AI, Deep Agents, or
`pi-dynamic-workflows`.

Research handoff separates content from workflow state:

```text
Markdown blob   model-readable analysis
artifact ref    compact content-addressed handle
task receipt    small coverage/gap/error envelope
```

Large prose remains in artifacts and downstream Agents retrieve it on demand.
JSON is used only where the runtime needs validation and control signals.

Pi supplies Agent sessions, model/tool execution, skill loading, cancellation,
usage statistics, and context compaction. Pi and provider auto-retry are
disabled; the Wiki task runtime is the only owner of transient retry. It also
supplies asynchronous delegation through start/collect/cancel, repository/path
authorization, configurable concurrency admission and bounded fresh-session
retries, durable artifact acceptance, deterministic validation, and atomic
publication.

Transient 400/500-class failures and timeouts use the configured fresh-session
retry count. 429 reduces delegated admission, honors `Retry-After`, and uses
the same retry limit; exhaustion remains an explicit failed task receipt.
Authentication, billing,
local schema/validation, and hard quota failures do not retry, and quota failures
durably pause the run. Partial candidate work may remain available to resume,
but it cannot be published without deterministic validation.

See [architecture](ARCHITECTURE.md).
