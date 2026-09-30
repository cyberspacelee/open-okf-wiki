# Multi-source layout, contracts and derived navigation

Status: accepted. Amends ADR 0027 (single root index, no log, one canon page
per type). Evidence: [research notes](../research/multi-source-knowledge-layer-evidence.md).

## Context

A hub documents several repositories in one wiki, but the kernel treated it as
one flat repository with prefixed paths:

- page paths were free, so parallel writers invented inconsistent layouts;
- one Conventions page held the commands and rules of every repository;
- the index listed pages flat by type, so a hub with many modules was hard to
  scan and same-named modules collided;
- nothing found or checked the contracts between repositories (a client
  calling another repository's route, a topic one repository produces and
  another consumes, a table two repositories write, a library one publishes
  and another depends on), so cross-repository knowledge ended up as one
  sentence in the architecture page, or missing (Kill Bill QA);
- `log.md`, reserved by OKF, was treated as a concept page.

Teams that run coding agents across many repositories converge on the same
answer (Meta, Mabl, Riftmap): derive the dependency and contract graph with
parsers, make "what depends on X" a lookup, and record the change order. Agent
context guidance (Anthropic, Claude Code, Karpathy's LLM Wiki, CodeWiki) adds:
directory structure is a signal, disclose in layers, keep upper layers short,
assemble overviews after the pages below them, keep a log a new session can
read.

## Decision

### 1. The directory is the hierarchy, derived from scope

Every author page has exactly one valid path, computed from its type, its
source and its name. `okf new` computes it; `okf validate` reports any other
path (`page-path`, error). A single repository is a hub with one source and no
`sources/` level.

| page | single repository | hub |
|---|---|---|
| Glossary | `glossary.md` | `glossary.md` (one for the system) |
| Architecture | `architecture.md` | `architecture.md` (the system: sources and contracts) |
| Conventions | `conventions.md` | `conventions.md` (cross-repository rules) and `sources/<s>/conventions.md` |
| Overview | — | `sources/<s>/overview.md` |
| Module | `modules/<name>.md` | `sources/<s>/modules/<name>.md` |
| Workflow | `workflows/<name>.md` | `sources/<s>/workflows/<name>.md` |
| Flow | — | `flows/<name>.md` |
| Map (generated) | — | `system-map.md` |
| Schema, Table (generated) | `databases/…` | `databases/…` |

- A Module or Workflow page's scope stays inside one source (every glob starts
  with that source's name). A flow that crosses sources is a **Flow** page,
  whose scope spans two or more sources.
- **Overview** is a new page type: one source's structure, its Not covered
  table and its cross-module changes. The source's module and trigger coverage
  is checked against it. This splits the per-repository part out of the
  hub's Architecture page; it is not a generated summary. The redundancy
  finding in ADR 0027 (generated overviews that restate docs cost more and
  help less) still applies, and the Assembly Test still gates the content.
- Canon in a hub: the system Glossary, Architecture and Conventions, plus each
  source's Overview and Conventions. `okf init --hub` creates them all.
  Glossary stays single so that names and alias lint stay global.
- Required sections and tables depend on the page's **role**, not only its
  type: the system Architecture requires a Contracts table, the system
  Conventions requires only Rules (a hub has no commands of its own).

### 2. Contracts: the kernel derives the graph, authors explain it

**Contract** is a named interface between two sources. Scan derives each one
deterministically, with provider and consumer sites. A Contract id is
`<kind> <key>`:

| kind | provider | consumer | key |
|---|---|---|---|
| `http` | a route (Spring, JAX-RS, FastAPI/Flask, Django, Express/NestJS, Go, ASP.NET) | a declared client (Feign, MicroProfile REST client, RestTemplate, WebClient, requests/httpx, fetch/axios, Go `net/http`) | `METHOD /path/{}` (parameters normalized to `{}`) |
| `rpc` | a Dubbo or gRPC service implementation | a Dubbo reference or gRPC stub | the service or interface name |
| `topic` | a send/publish call with a literal topic | a listener or consumer | the topic name |
| `table` | SQL or mapping that writes the table | SQL that only reads it | the table name |
| `library` | the source that declares an artifact (Maven, npm, Go module, Python project), or holds the imported module | the source that depends on or imports it | the artifact or module |

- Only contracts whose sites span two sources are contracts. HTTP clients with
  no provider in the hub are listed as external.
- `okf scan` prints `contracts`, `okf links` answers lookups, and stamp renders
  the **System map** (`system-map.md`, type `Map`, kernel-owned like the
  database pages).
- Authors claim contracts in frontmatter, the way scope claims files: a Flow
  page or the system Architecture page lists contract ids or globs under
  `contracts`. `link-coverage` (error, a Structure-stage rule) requires every
  contract to be claimed or excluded by a Not covered row matching one of its
  site files.
- Claims must be backed by content once the page's todo block is gone
  (`contract-row`, error): the system Architecture page's **Contracts table**
  (`Contract | Provider | Consumers | Change order | Verify`) or a Flow page's
  **Call chain table** (`Step | Source | Entry | Contract | Next`) must name
  each claimed contract. A Flow page also needs a mermaid `sequenceDiagram`
  and a change guide.
- Change order is Mabl's release ordering: which side changes and ships first,
  and what compatibility the other side relies on.
- `okf impact --files` returns, for a file that is a contract site, the
  contract, its counterpart sites, the pages that claim it and its Change
  order row. A page that claims a contract goes stale (`contract-changed`)
  when any site file of that contract changes, even in a source outside the
  page's scope.

### 3. Navigation and history are derived files

- **Indexes per level** (OKF §8). The root `index.md` lists the system canon,
  the System map, Flow pages, databases and one line per source linking
  `sources/<s>/`. Each `sources/<s>/index.md` lists that source's pages and its
  source map. A single repository keeps one root index. Each entry adds a
  trust marker: `(reviewed <date>)` or `(unreviewed <date>)`. An index longer
  than 150 lines raises `index-size` (warning).
- **`log.md`** (OKF §9) at the wiki root, rendered by stamp from git history.
  Each stamp that changed a page's `stamp.content_sha256` is an entry
  (Creation, Update or Deletion, with the source revision range and the
  reviewer), grouped by date, newest first, capped at 100 entries. It is a
  projection, not a ledger: deleting it and stamping rebuilds it identically,
  and a merge conflict is resolved by stamping again. `okf log [--since]
  [--files]` filters it. `validate` reports a log that differs from its
  derivation (`log`, error, only when no page is a draft), as it does for
  `index.md` and the System map (`map`).
- `index.md` and `log.md` are reserved at every level: `okf new` refuses them
  and page discovery skips them.
- `orphan` (warning): an author page no other author page links to. The
  indexes do not count.
- `okf pointer --source <s>` prints the block for one source's AGENTS.md: its
  index, its conventions, the system conventions and glossary, and the System
  map.

### 4. Stages

Discover, Structure, Research, Write, **Assemble**, Review and stamp.
Research covers the Glossary and every Conventions page, which every writer
needs. Assemble writes the Architecture and Overview pages after the Module,
Workflow and Flow pages exist, bottom-up as in CodeWiki. Discovery still fills
their briefs, and Structure still fills their Not covered rows. Tracers in a
hub also start from `contracts`: one Flow stub per end-to-end path that
crosses sources.

## Consequences

- No compatibility layer. Wikis written against ADR 0027 fail `page-path` and
  `canon-missing` until their pages are recreated at the derived paths.
- `okf new` takes `--type`, `--name` and `--source` instead of a path.
- A monorepo that holds several services keeps the ADR 0027 tools for
  cross-module relations (`deps`, `resources`, cross-module change guide
  rows). Contracts are derived only between sources of a hub.
- Contract extraction is regex over text, like triggers: it points at the
  places to read and can miss dynamic URLs. A missed contract costs a
  description, not a false claim, because every contract row still cites code.
- Validation in a hub reads every production file to derive contracts, once
  per command, through the same pipelined blob reads scan uses.
