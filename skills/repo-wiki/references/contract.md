# Writing Contract

## Coverage and representation

The Wiki closes four mandatory ledgers before optional depth is considered:

- every eligible Source region has one Source Area disposition;
- every discovered business responsibility belongs to one Domain;
- every primary domain noun belongs to one Domain and has one definition owner;
- every captured OpenGauss table belongs to one Source/Domain/role table group
  and, when relevant, links to its Concepts through Model Basis records.

Every persistent Concept also has one kernel-derived data-model owner. The Grep Test controls
only optional depth such as a separate Procedure, Flow or Lifecycle page. It
cannot remove Domain, Concept, persistence-model, Schema or Table coverage.
The Plan and Composition must therefore contain coverage owners; an empty Wiki
is not a valid Publication.

Use prose for definitions and rationale, tables for repeated comparisons, and
diagrams when topology, ordering, state reachability or cardinality would
otherwise be reconstructed across sentences. Split only for an independently
routable, independently evidenced question. Omit signature catalogs, directory
mirrors, copied configuration and restated comments from authored pages;
deterministic reference pages may contain complete captured schema facts.

## Model evidence

Select a Model Basis per Concept:

- `opengauss`: captured Catalog facts own physical columns, keys, constraints,
  indexes and partitions; code supplies behavior, state meaning and ownership;
- `code`: when no relevant OpenGauss evidence is configured, recover a logical
  model in the order DDL/migrations, ORM annotations or XML overrides, SQL and
  mappers, then persistence code;
- `none`: the Concept is not persistent and has no data-model owner.

OpenGauss is the only database Source kind. A configured OpenGauss capture must
succeed; connection, identity or capture failure blocks the Run rather than
silently changing the Concept to `code`. When code names a relevant table that
was not selected for capture, the Concept may use a partial code model only
with a `catalog-selection` Gap naming the omitted evidence.

Physical relationships come only from captured constraints. Code-derived
relationships are logical and record their evidence basis separately. Render
physical and logical ER views separately; Mermaid line style expresses
identifying semantics, never evidence confidence.

## Scope and locators

A scope pairs a registered Source with normalized relative POSIX paths. `.`
selects the eligible Source root. Cross-Source claims evidence each participant.
Each Source appears once per unit with one role: `owner`, `model`, `producer`,
`contract`, `consumer` or `feedback`, and has at least one seed inside its
paths. Integration units include producer and consumer scopes from at least two
Sources. A `model` scope identifies structural evidence; it does not imply
business ownership.
For a Catalog Source, `.` selects the whole captured catalog; otherwise paths
select exact table names/page slugs, and evidence from a sibling table is out of
scope.
Agents query live selection with `okf db tables` and `okf db describe <table>` before
registration, then frozen capture with `okf catalog tables` and `okf catalog
describe <table>` after `run start`. They do not read Run state or Catalog JSON
files.
Catalog table-existence locators are derived by the kernel; table-group evidence
records only classification or Domain ownership, while Concept links derive
from `model_basis.catalog_tables`.
Locators are plain paths with an optional line range:

    service/src/main/java/example/Request.java#L42-L68
    database/orders

Catalog locators are logical Source/table identities. They never contain the
connection scheme, host, port, database or schema; Source configuration and the
Run's content-addressed Catalog bind them to the captured environment.

The first segment is the Source. No URI scheme or revision appears in locator
text; Run state binds it to the frozen Pin or Catalog. Plans and evidence notes
are routing inputs, never provenance.

## Artifact boundaries

Plan is a pair: `work/plan.md` is Markdown with identity-only frontmatter and a
required analysis body, while `work/plan-ledger.json` is its strict machine
coverage ledger. Both are bound by the same review digest. Composition is
Markdown with small schema-validated frontmatter and an analysis body. Pages are Markdown. Plan, Composition and bundle
reviews are strict JSON issue ledgers because they control phase transitions.
Each issue has a stable ID and remains `open` or `resolved`; approval means no
issue remains open. Long-running
planning progress is one living Markdown file that is overwritten in place.
The kernel creates its initial marker; Plan review remains closed until the
coordinator replaces that marker with findings, gaps and next actions.

The Plan Ledger owns Domain-oriented coverage, compact table groups, sparse
replica mappings, authored knowledge units, evidence scopes, seeds and gaps.
The Plan Narrative owns global synthesis, lifecycles, cross-Source
relationships, evidence-backed conclusions, rejected hypotheses and unresolved
gaps. Domains and Concepts use unit IDs to declare unique definition owners;
the kernel derives one data-model unit from every persistent Concept's Model
Basis. Every Domain has a distinct owner unit. Plan has no page
inventory or target page count. Composition assigns units to stable authored
Page IDs, metadata, diagrams and final paths, and assigns each OpenGauss Source
one Reference Root. The kernel deterministically derives Schema and Table pages
from the captured Catalog, Plan table groups and those roots. It first exposes
their IDs and paths in the read-only derived `work/reference-map.json`; agents
never edit that Artifact or reconstruct its naming rules.
Independent Plan review binds domain recall to the frozen Sources. Independent
Composition review binds task routing and page cohesion before page fan-out.
Both reviews record merge probes covering every routed item when more than one
exists; a merge decision requires a matching open merge issue.
After Composition approval, the kernel derives one digest-bound
`work/page-packets/<page-id>.json` per authored page. It contains only that
page's owned units, related semantic projections, scopes, evidence seeds,
generated references, template and output. Writers read this packet and reopen
evidence; they do not load the full Plan Ledger, Composition or Reference Map.
Domain packets project all Concepts, related detail pages and non-owning units
in their one owned Domain without duplicating unit ownership. The projected
units extend that Domain page's allowed scopes and seeds so its summaries can
reopen and cite the evidence they describe.
Writers own authored page bodies, citations and coverage. They do not transcribe
Catalog field inventories. Final bundle review owns the machine trust stamp and
is digest-bound to both approved pre-write reviews.

## Page types and diagrams

Types are `Overview`, `Architecture`, `Domain`, `Concept`, `Procedure`, `Flow`,
`Lifecycle`, `DataModel`, `Schema` and `Table`.

- Overview routes tasks and has no diagram.
- Architecture explains static boundaries and requires a flowchart.
- Domain explains capability ownership and invariants, then summarizes its data
  model, state/lifecycle and key flows with links to owning detail pages;
  diagrams are optional.
- Concept defines one or more tightly coupled domain nouns, ownership and
  semantic relationships; diagrams are optional.
- Procedure explains an internal orchestration, calculation or algorithm;
  diagrams are optional.
- Flow requires a flowchart or sequence.
- Lifecycle requires a state diagram.
- DataModel requires an authored logical ER diagram for a `code` basis. For an
  `opengauss` basis, its physical ER is generated at the model marker and the
  Composition does not plan a writer ER for that block.
- Schema is a deterministic OpenGauss Source overview and has no authored
  diagram.
- Table is a deterministic reference for one captured table and has no authored
  diagram.

Each authored Diagram Spec has a page-local ASCII ID, supported kind, short question and
one or more participating Sources inherited from its page scopes.
A page plans at most four. Each appears exactly once with one
`%% okf-id: <diagram-id>` marker, matching `accTitle` and `accDescr`. Keep
citations outside the fence and follow it with a cited conclusion.
That adjacent conclusion cites at least one source ID for every planned diagram
participant.

## Citations and links

Every load-bearing claim uses a footnote ID that appears exactly once in
frontmatter `sources`, body references and a footnote definition. Partial
coverage requires a non-empty `Gaps` section for English or `缺口` section for
Chinese, naming missing evidence and searched scope; full coverage forbids that
section. `author` and `last_modified` are optional best-effort metadata for Git
file locators and are omitted when unavailable, including for Catalog locators.
Causal rationale must be cited.

Before binding, logical page links use `[label][page-id]` without definitions.
After binding, links are ordinary bundle-root-relative or page-relative links.
Unknown IDs and broken links fail validation.

Draft frontmatter contains both required fields `coverage` and `sources`, no
others, and is validated by a strict writer schema before kernel metadata is
added. Localized template
headings are required, and sections designated by the template as compact
tables must contain Markdown tables. Every localized template instruction is an
explicit `{{replace: ...}}` marker; leaving one in a draft fails validation.

## Deterministic boundary

The Run contract is `domain-plan-ledger-coverage`. Reject every older Run
state rather than migrating or branching its schema; OKF remains v0.2.
The skill bundle digest binds only runtime source files: `SKILL.md`, Markdown
references and templates, and Python kernel files. Caches, bytecode and other
incidental files do not invalidate an active Run. A real runtime-source change
still requires abandoning and restarting the Run; its digest is never patched.

Workspace configuration contains one strict Run Policy. `run start` snapshots
it, and active Runs never observe later Workspace changes. Its evidence policy
defines search result count plus compact-JSON output bytes, and read default
lines, maximum lines and compact-JSON output bytes. Search returns `next_after`;
read returns `next_locator`. Both preserve complete UTF-8 JSON items and report
`limit_reached` separately from `has_more`.

The required policy shape and defaults are:

```json
{
  "evidence": {
    "search": {"max_results": 100, "max_output_bytes": 65536},
    "read": {"default_lines": 200, "max_lines": 1000, "max_output_bytes": 262144}
  },
  "agents": {
    "max_active_children": 4,
    "max_spawn_depth": 1,
    "max_children_per_run": 128
  }
}
```

Kernel safety ceilings are 100 search results, 64 KiB search output, 1,000
read lines, 256 KiB read output, 16 active children and 512 unique children.
Output byte minima are 4 KiB, `default_lines` must not exceed `max_lines`, and
spawn depth is exactly one.

The agent policy defaults to four active children, spawn depth one and 128
unique children per Run. When the host exposes a numeric native cap, the
effective limit is the smaller value; otherwise the coordinator enforces the
Run value. One rolling window spans every phase. The kernel exposes the
immutable policy and records it in the Publication; it does not schedule agents.
Structured live-eval traces verify active high-water, depth, total fan-out and
rolling refill.

The kernel proves revisions, captured paths, locator syntax and ranges, Plan and
Composition schemas, Plan-review and bundle-review digests, exact unit coverage,
page metadata, locale-template separation, citation joins, diagram structure,
logical-link binding, Candidate validity and atomic Publication. Validation
collects every independently diagnosable issue in one pass and names checks
skipped because a prerequisite Artifact could not be parsed. Issues name their
owning phase. `run status` exposes only current blockers and next actions;
`validate` retains the full audit and labels future-phase failures as pending.
The host owns
subagent isolation, policy enforcement and the persistent coordinator loop.

Candidate construction also generates Schema and Table references, model blocks,
and root and directory Navigation Indexes from the approved Plan and Composition
before final review. Multi-page Compositions put ordinary pages under capability
directories and reject page-type directories; Publication regenerates the same
outputs deterministically. Its manifest records an authored/generated origin and
the exact Git blob, files hash or Catalog/table hash used by every page, plus a
non-null navigation inventory derived from the published page tree.
