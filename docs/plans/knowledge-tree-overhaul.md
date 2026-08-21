# Knowledge-tree overhaul

Date: 2026-08-21

Thorough replacement of Published Wiki geometry, template altitudes, and the
survey → write → review loop. No compatibility with previous `wiki/` trees,
template packs, or `SCOPE_DEPTH`. Old Candidates are not migrated.

## Why

Host welded generation-time Git Source into consumer navigation
(`wiki/<source>/…`, implicit `wiki/source/`). Architecture was a Domain
optional. Write dumped the whole Candidate from survey one-liners. Host
accepted any non-empty H2. Pages were shallow because that contract rewarded
shallow pages.

## Revised tree

Git Source stays pin + provenance. Every `sources[].resource` is a POSIX path
from the Workspace root plus a line anchor. In an explicit Workspace, each
Source owns a Repository Section keyed by `scopeId`; domains and concepts are
local to that section. Workspace root pages own cross-Source composition.

**Implicit** (no `workspace.yaml`, pin `path: "."`). The internal Source id
is `self`, but citation resources do not add that segment. No `repos/`, no
`source/`.

```text
wiki/overview.md
wiki/architecture.md              # required; C4 L1+L2 on one page
wiki/development.md | runbook.md  # optional
wiki/<domain>/domain.md
wiki/<domain>/flows.md            # optional
wiki/<domain>/<concept>/concept.md
wiki/<domain>/<concept>/states.md | data.md
```

**Explicit** (`workspace.yaml` named pins, including N=1):

```text
wiki/overview.md
wiki/architecture.md                            # required; L1 only
wiki/repos/<scopeId>/architecture.md            # required per Source; L2 only
wiki/repos/<scopeId>/development.md | runbook.md
wiki/repos/<scopeId>/<domain>/domain.md | flows.md
wiki/repos/<scopeId>/<domain>/<concept>/concept.md | states.md | data.md
```

`repos/<scopeId>/` is the Repository Section for one Source. The Source remains
evidence/provenance; the section is the generated navigation and ownership
view. Same-named domains in different Sources remain distinct.

Host generates every `index.md` and root `log.md`. The root index shows System
and Repository Sections for explicit Workspaces; implicit Workspaces show
System and Domains.

## Templates

Scopes: `wiki` | `repo` | `domain` | `concept`. Delete `source.md`,
`interfaces.md`, `models.md`, and domain-level architecture.

| file | type | placement |
|---|---|---|
| `overview.md` | Overview | wiki anchor |
| `architecture.md` | Architecture | `altitudes: [wiki, repo]`; required at those altitudes (implicit collapses to root) |
| `development.md` / `runbook.md` | repo optional | root if implicit; `repos/<scopeId>/` if explicit |
| `domain.md` | Domain | domain anchor |
| `flows.md` | Flow | domain optional |
| `concept.md` | Concept | concept anchor |
| `states.md` / `data.md` | concept optional | beside concept |

Pack: exactly one non-`altitudes` anchor for `wiki`, `domain`, and `concept`.
Repo may have zero anchors. `architecture.md` uses `altitudes`, not `scope`.

Overview routes tasks and lists pin responsibilities. It must not draw the
container diagram. Wiki architecture is composition; repo architecture is
internals and links to `/architecture.md`.

## Pipeline

```text
parallel survey(Source)
  → synthesize(workspace-analysis)     # multi-Source only, after all surveys
  → parallel write(repos/<Source>)     # full Repository Sections
  → write(wiki-root)                   # cross-Source root files only
  → candidate_check → prefix repair
  → exclusive review → prefix repair (host counts two attempts)
  → publish
```

Survey returns inventory + locators + optional **hints** and cross-Source leads.
No binding optional list, no followup YAML, no page bodies. Synthesize reads all
survey handoffs and reopens both ends of supported relationships. It does not
write pages.

Write partitions are Candidate prefixes. Explicit Workspace writers own a
complete `repos/<scopeId>` prefix, including its domain/concept tree. Disjoint
prefixes may run in one batch. Overlap is rejected. Writer is injected only
in-scope skeletons.
Before writing a page, `read` every pin file that page will cite. Optional
pages may be added or dropped only from the injected filename set.

Review fails on heading paraphrase, unread/unsupported locators, duplicate
structure, unjustified optionals, non-executable steps, translated mermaid
names. Missing optionals are not a fail. No survey after write.

## Host

Replace `SCOPE_DEPTH` with placement derived from implicit versus explicit
Workspace geometry. Repository pages may cite only their owning Source; the
root architecture of a multi-Source Workspace must cite every Source.

Mechanical: placement table, required architecture altitudes, ≥1 concept
cluster, H1/title/description/H2 order, no placeholders, mermaid kind +
non-empty fence body, `sources[]` + in-range locators, footnote id match,
**every non-diagram H2 has ≥1 `[^id]`**, wiki links, no leaked template keys.

Session retrieve gate: each written page’s `sources[].resource` files were
`read` in that write execution. Directory grep does not count.

Parallel writer receipts bind the digest of their assigned Candidate prefix,
not the whole Candidate. Review and publish remain bound to the whole Candidate
revision.

`wikiSourceSlug(".")` → `self`. Reserve source names `self`, `source`,
`sources`, `repos`. Citation resources are POSIX paths from the Workspace
root plus `#Lx` or `#Lx-Ly`.

Not host: identifier-in-body, mermaid node names, merge/split of domains,
whether an optional deserved to exist, claim/span relevance.

## Explicitly refused

Type-buckets, `wiki/sources/`, evidence-brief files, N+1 analysis tasks started
simultaneously, NLP host scoring, C4 as a mermaid kind, restoring `source.md` /
`interfaces.md` / `models.md`, survey or synthesis after write, implicit folder
named `source`.
