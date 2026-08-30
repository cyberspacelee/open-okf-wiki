# Knowledge Plan

Own the complete cross-Source investigation. One planner maintains the shared
mental model; focused evidence workers answer bounded questions and return note
paths, locators, gaps and unanswered questions.

Call `okf evidence outline . --source <name> --json` once for every Source and
use catalog evidence commands where applicable. The outline command is the
Source Index interface; do not open internal Index files. Navigate from build
modules and source sets into relevant package clusters. Account for Source roles,
domain nouns, state transitions, commands, persistence, events, failure paths,
extension points and cross-Source contracts. When all three are present,
distinguish public API, internal API/events and plugin SPI together in one unit
question or explicit gap. Name all three layers explicitly; a generic event,
facade or extension label does not establish the internal boundary. Package
and class counts are not concepts.
When a causal lifecycle crosses units, require one unit question or explicit
gap to name the handoff and feedback path; separate presence-only units do not
establish the relationship.

Continuously overwrite `work/plan.md`. For long work, keep
`work/progress.md` sufficient to resume without conversation history: completed
investigations, current findings, rejected hypotheses, gaps and next actions.
Evidence notes belong under `work/evidence/`; copy conclusions into the Plan
instead of making the notes mandatory dependencies.

Replace the initial Progress marker before requesting Plan review. Update this
single file after each evidence batch and each review repair; do not create
checkpoint or attempt files.

After the top-level outlines, identify independent evidence questions. When
there are two or more, dispatch focused workers before the planner performs
deeper search/read calls. Each worker writes one fixed note and returns that
path; the planner owns only cross-Source synthesis and residual questions.
Worker questions and note files are evidence partitions, not future unit
boundaries: one note may feed several units and several notes may support one
bridge unit.

Merge the first batch, then inspect every proposed Gap. "Not traced in this
pass", "not inspected" and equivalent planner-controlled omissions are pending
questions when the registered Sources expose the domain or entry point. Send a
focused residual investigation before review. Keep a Gap only when the frozen
revisions lack the evidence, it belongs to an unregistered Source, bounded
navigation failed to establish the claim, or the remaining uncertainty is a
real semantic boundary.

The Plan is Markdown with this frontmatter:

```yaml
---
kind: knowledge-plan
units:
  - id: request-lifecycle
    kind: lifecycle
    question: How does a request enter failure and recover?
    scopes:
      - source: API
        paths: [api-core/src/main/java/example/request]
    evidence_seeds:
      - API/api-core/src/main/java/example/request/Request.java#L20-L48
gaps: []
---
```

Kinds are `capability`, `lifecycle`, `flow`, `data-model`, `integration` and
`operations`. IDs are stable lowercase semantic keys. Each unit has one to
three seeds actually opened inside its scopes. The body explains the global
model, lifecycle and cross-Source relationships, evidence-backed conclusions,
rejected hypotheses and unresolved gaps.

A unit owns one independently routable change surface or causal question. Split
an umbrella question that merely enumerates domains with independent owners or
failure modes; preserve the end-to-end relationship in a focused bridge unit or
explicit gap instead of absorbing every domain into one lifecycle unit.

Before review, run two concrete maintainer probes against every compound unit.
Turn its named stages or domains into questions such as "where would I change
X?" and "where would I debug failure Y?" If the answers start in different
scope roots, have independent failure modes, or one can change without the
other, split the unit. A chronological handoff does not by itself make input
admission, state mutation, background delivery and recovery one change surface;
keep their relationship in a focused bridge unit or gap.

Plan defines what knowledge requires coverage. Page IDs, types, titles, paths,
diagrams and hierarchy belong to Composition. Keep at most 64 coherent units;
edit the Plan directly when a unit is too broad.

If nothing passes the Grep Test, use `units: []` and record at least one gap
explaining why no durable knowledge warrants a page. This is a complete Plan,
not a blocker and not a reason to invent an Overview.

Before Plan review, account for every significant domain or subsystem exposed
by top-level build modules and entry points. Each belongs in a unit, an explicit
evidence-backed gap, or a rejected hypothesis in the body. A unit may cover
several related modules; this is a recall check, not permission to mirror the
directory tree. A module name in `scopes` is not enough: sample its public
types or entry points and name its central domain nouns and behaviors in the
unit question or a gap. When those types form a public hierarchy, name its
major levels or types instead of only the umbrella domain. When a pipeline has
separately maintained capture, transformation and downstream-consumption
stages, distinguish the stages in the unit question or a gap.
