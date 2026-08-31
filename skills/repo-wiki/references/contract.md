# Writing Contract

## Admission and representation

Admit knowledge only when grep plus two or three files cannot reconstruct it in
about a minute: cross-module architecture, lifecycle and failure propagation,
enforced invariants, written decisions and task routing. Exclude inventories,
signatures, directory trees, configuration lists and restated comments.

Use prose for definitions and rationale, tables for repeated comparisons, and
diagrams when topology, ordering, state reachability or cardinality would
otherwise be reconstructed across sentences. Split only for an independently
routable, independently evidenced question.

## Scope and locators

A scope pairs a registered Source with normalized relative POSIX paths. `.`
selects the eligible Source root. Cross-Source claims evidence each participant.
Each Source appears once per unit with one role: `owner`, `producer`, `contract`,
`consumer` or `feedback`, and has at least one seed inside its paths. Integration
units include producer and consumer scopes from at least two Sources.
For a Catalog Source, `.` selects the whole captured catalog; otherwise paths
select exact table names/page slugs, and evidence from a sibling table is out of
scope.
Locators are plain paths with an optional line range:

    service/src/main/java/example/Request.java#L42-L68

The first segment is the Source. No URI scheme or revision appears in locator
text; Run state binds it to the frozen Pin or Catalog. Plans and evidence notes
are routing inputs, never provenance.

## Artifact boundaries

Plan and Composition are Markdown with small schema-validated YAML frontmatter.
Their bodies hold analysis. Pages are Markdown. Plan, Composition and bundle
reviews are strict JSON issue ledgers because they control phase transitions.
Each issue has a stable ID and remains `open` or `resolved`; approval means no
issue remains open. Long-running
planning progress is one living Markdown file that is overwritten in place.
The kernel creates its initial marker; Plan review remains closed until the
coordinator replaces that marker with findings, gaps and next actions.

Plan owns stable knowledge units, evidence scopes, seeds and gaps. Composition
assigns those units to stable page IDs, page metadata, diagrams and final paths.
Independent Plan review binds domain recall to the frozen Sources. Independent
Composition review binds task routing and page cohesion before page fan-out.
Both reviews record merge probes covering every routed item when more than one
exists; a merge decision requires a matching open merge issue.
Writers own page body, citations and coverage. Final bundle review owns the
machine trust stamp and is digest-bound to both approved pre-write reviews. If
no knowledge passes admission, the Plan records why in `gaps`, Composition and
Candidate are empty, and all reviews may approve a Publication with no concept
pages.

## Page types and diagrams

Types are `Overview`, `Architecture`, `Domain`, `Procedure`, `Flow`, `Lifecycle`,
`DataModel` and `Table`.

- Overview routes tasks and has no diagram.
- Architecture explains static boundaries and requires a flowchart.
- Domain explains capability ownership and invariants; diagrams are optional.
- Procedure explains an internal orchestration, calculation or algorithm;
  diagrams are optional.
- Flow requires a flowchart or sequence.
- Lifecycle requires a state diagram.
- DataModel requires an ER diagram.
- Table explains one captured table and has no diagram.

Each Diagram Spec has a page-local ASCII ID, supported kind, short question and
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
tables must contain Markdown tables.

## Deterministic boundary

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
    "search": {"max_results": 20, "max_output_bytes": 8192},
    "read": {"default_lines": 40, "max_lines": 200, "max_output_bytes": 65536}
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
skipped because a prerequisite Artifact could not be parsed. The host owns
subagent isolation, policy enforcement and the persistent coordinator loop.

Candidate construction also generates the root and directory Navigation
Indexes from Composition paths before final review. Multi-page Compositions put
ordinary pages under capability directories and reject page-type directories;
Publication regenerates the same indexes deterministically.
