# Repository Wiki Producer

This context defines the language for deriving a source-grounded Markdown wiki from a fixed source repository.

## Language

**Wiki**:
A set of source-grounded Markdown pages that explains one Repository Snapshot for human readers.
_Avoid_: Knowledge Bundle, knowledge graph, model transcript

**Repository Snapshot**:
An immutable, read-only view of the target repository at the exact revision used by one Wiki Run.
_Avoid_: Live checkout, Source Set, Workspace

**Producer Skill**:
The trusted, product-provided method and template bundle that guides how a Repository Snapshot becomes a Wiki.
_Avoid_: Target-repository Skill, Python workflow, prompt fragment

**Skill Version**:
An immutable release of the Producer Skill identified by its exact content digest.
_Avoid_: Latest Skill, implicit override

**Skill Fork**:
An explicitly created editable copy of a Skill Version whose changes are owned and versioned separately from product releases.
_Avoid_: Hidden prompt override, automatically upgraded Skill

**Wiki Template**:
An adaptable page scaffold in the Producer Skill that guides structure, questions, style, and diagrams without fixing the final page set.
_Avoid_: Renderer schema, mandatory page taxonomy, typed content block

**Semantic Workflow**:
The model-directed sequence of repository exploration, page design, writing, review, and completion decisions for one Wiki Run.
_Avoid_: Python state machine, fixed role pipeline

**Wiki Run**:
One attempt to derive and publish a Wiki from a Repository Snapshot using one exact Skill Version or Skill Fork revision.
_Avoid_: Agent turn, chat session, Production Run

**Staging Wiki**:
The isolated candidate Wiki written during a Wiki Run and not visible as the published result until validation succeeds.
_Avoid_: Published Wiki, model memory

**Published Wiki**:
The complete validated Markdown tree made visible as the result of a successful Wiki Run.
_Avoid_: Staging Wiki, Accepted Knowledge Model

**Wiki Manifest**:
The bounded terminal summary of pages produced by a Wiki Run.
_Avoid_: Page contents, workflow state, knowledge graph

**Source Citation**:
A resolvable reference from a Wiki page to a path and line range inside the pinned Repository Snapshot.
_Avoid_: Unsupported filename mention, Claim record

**Refresh**:
A Wiki Run that updates an existing Published Wiki for a newer Repository Snapshot while following the selected Producer Skill.
_Avoid_: Knowledge-graph invalidation, patch-only rendering
