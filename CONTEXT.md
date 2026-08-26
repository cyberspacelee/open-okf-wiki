# Repository Wiki Skill Harness

This context produces a thin, evidence-anchored repository Wiki plus agent
onboarding files (AGENTS.md block, CONTEXT.md draft), driven by any host coding
agent through a skill, with deterministic guarantees enforced by scripts.

## Language

**Host Agent**:
The coding agent (Claude Code, Amp, Codex, …) that executes the skill SOP and owns sessions, context, and parallelism.
_Avoid_: Lead, orchestrator, runner

**Workspace**:
The repository root that owns Wiki state, proposals, and one Published Wiki.
_Avoid_: Project, working directory

**Source**:
A Git repository whose content is admissible evidence for a Run.
_Avoid_: Codebase, input repo

**Run**:
One resumable Wiki generation attempt, tracked phase-by-phase in durable state until publish or abandonment.
_Avoid_: Session, job

**Phase**:
One ordered stage of a Run: inspect, survey, write, derive, validate, publish.
_Avoid_: Step, task

**State Gate**:
The state script as the only writer of Run state; completing a phase target requires its validation to pass first.
_Avoid_: Status file, checkpoint injection

**Thin Wiki**:
The published routing layer: pages that compress knowledge expensive to rebuild by search, never content cheaply derivable from code.
_Avoid_: Documentation site, source mirror, API reference

**Grep Test**:
The admission criterion for Wiki content: if a host agent can rebuild a fact with search plus reading a few files, the Wiki must not carry it.
_Avoid_: Coverage requirement

**Locator**:
A workspace-relative path with symbol or line anchor that ties a claim to read evidence.
_Avoid_: Link, reference (unqualified)

**Coverage**:
A page-level marker, `full` or `partial`, declaring whether every obligation is evidence-backed or gaps were explicitly recorded.
_Avoid_: Quality score, completeness percentage

**Contract**:
The single shared writing contract (CONTRACT.md) that both the skill SOP and any future pipeline consume: admission rules, citation rules, managed-block format, ratification boundaries.
_Avoid_: Template pack, style guide

**Draft**:
A phase work product under `.okf-wiki/drafts/` that survives interruption and feeds later phases.
_Avoid_: Handoff, receipt, scratch file

**Proposal**:
A machine-generated file under `.okf-wiki/proposals/` awaiting human review before it may touch a Source: AGENTS.md block, CONTEXT.md draft, ADR stub.
_Avoid_: Auto-generated doc, output

**Managed Block**:
The delimited, version-stamped region of AGENTS.md that machines may replace; everything outside it is human-owned and untouchable.
_Avoid_: Generated section (unmarked), whole-file overwrite

**Ratification**:
The human act of canonizing a term, decision, or proposal. Machines detect drift and draft candidates; they never ratify.
_Avoid_: Auto-approval, apply-all
