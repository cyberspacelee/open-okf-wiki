# Writing Contract

The single source of truth for what may enter the Wiki and how claims are
anchored. Writers, reviewers, and the derive agent all follow it; the
validator enforces the mechanical parts.

## Admission: the Grep Test

Before writing any fact, ask: could an agent rebuild it with grep plus reading
two or three files in about a minute? If yes, it does not belong — write a
pointer to the source location instead. The Wiki carries only knowledge that
is expensive to rebuild: cross-module architecture, invariants, failure
propagation, lifecycle rules, task entry points, the why behind boundaries.

Fails the test (never write): file inventories, function signatures, config
key lists, directory trees, restated code comments.
Passes: "writes flow through the state gate because completion must validate
first — see `scripts/_state.py`".

## Citations

- Every load-bearing claim carries a footnote `[^id]` keyed to a
  `sources` frontmatter entry, with a matching `[^id]: title` definition.
- A locator is a workspace-relative POSIX path plus anchor:
  `scripts/_state.py#L42-L60` or `scripts/_state.py::complete_target`.
  Prefer the symbol form; line ranges must exist in the file as read.
- Cite only files you actually opened in this task. Grep hits are discovery,
  not evidence.

## Coverage honesty

An obligation you cannot support with read evidence is a recorded gap, never
prose. Set `coverage: partial` in frontmatter and list each gap (what is
missing, where you searched) in a `## Gaps` section. Causal claims ("because",
"in order to", 为了/以便) require a locator to written rationale — a comment,
commit message, or ADR. Absent that, state the decision without inventing its
motive: a visible gap routes an agent to source; an invented motive corrupts
its decisions.

## Page shape

Frontmatter: `type`, `title`, `description`, `coverage`, `sources`. The
description says what knowledge the page owns and when to open it — it is the
routing text shown in indexes. Body H2 skeleton comes from the template in
`assets/templates/`; fill every section or record a gap. Wiki-internal links
are standard relative markdown; every page must be reachable from
`wiki/index.md` in at most 3 hops.

## Proposals (derive phase)

- AGENTS.md content goes only inside the managed block delimited by
  `<!-- okf-wiki:begin run=<id> -->` / `<!-- okf-wiki:end -->`. Text outside
  the block is human-owned; never rewrite, reorder, or delete it. The block
  holds two things only: conditional pointers into `wiki/` (one line per
  domain) and verify commands that you executed successfully during this run.
- CONTEXT.md output is a draft. Mark every synonym cluster
  `<!-- pending-ratification -->` and never pick the canonical term yourself —
  a human ratifies.
- ADR stubs: fill Decision plus evidence locators; leave Context/Rationale
  for humans. Emit a stub only when the decision is hard to reverse,
  surprising without context, and a real trade-off.
