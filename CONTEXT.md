# OKF Knowledge Bundle Producer

This context defines the language for turning source repositories into auditable Open Knowledge Format knowledge bundles.

## Language

**Workspace**:
A user-initialized local working directory representing one product or project. It holds one Producer Project's configuration and runtime state for producing one Knowledge Bundle from one or more source repositories.
_Avoid_: Producer Project, Source Set, repository

**Workspace Definition**:
The shareable declaration of a Workspace's Sources, Source Revision Policies, Producer Profile, and publication intent.
_Avoid_: Local Workspace Settings, Production Run snapshot

**Local Workspace Settings**:
Machine-specific Workspace bindings and preferences that must not be required to reproduce the shared knowledge-production intent.
_Avoid_: Workspace Definition, Producer Profile

**Workspace Console**:
The local browser interface for configuring a Workspace, managing Source Checkouts and model connections, observing Production Runs, reviewing accepted knowledge, reading the Knowledge Bundle, and asking grounded questions. It is an adapter over the Deterministic Control Plane, not an authoritative state owner or Wiki editor.
_Avoid_: Remote administration platform, Markdown editor, source of truth

**OKF Knowledge Bundle Producer**:
A system that derives an Open Knowledge Format Knowledge Bundle from a versioned Source Set.
_Avoid_: OKF Wiki Agent, Wiki generator

**Producer Project**:
A named knowledge-production scope that combines one or more versioned sources into one Knowledge Bundle.
_Avoid_: Repository, Production Run

**Deterministic Control Plane**:
The part of the Producer that owns the source universe, coverage obligations, evidence acceptance, validation, and publication outcome.
_Avoid_: Agent workflow, orchestration agent

**Semantic Execution Plane**:
The probabilistic work that explores sources and proposes claims, concepts, relations, and dispositions for deterministic acceptance.
_Avoid_: Control plane, source of truth

**Agent Runner**:
The execution environment that performs work in the Semantic Execution Plane on behalf of the Producer.
_Avoid_: Producer, workflow owner

**Scheduler**:
The deterministic authority that advances a Production Run from persisted state and accepted results.
_Avoid_: Orchestrator Agent, Planner

**Planner Agent**:
A short-lived Agent that proposes a bounded set of analysis tasks from the current run summary.
_Avoid_: Scheduler, persistent Orchestrator

**Worker Agent**:
A short-lived Agent that investigates a bounded source scope and proposes typed semantic results.
_Avoid_: Autonomous peer, recursive Subagent

**Agent Role**:
A defined semantic responsibility such as planning, extraction, verification, or rendering that is independent of any particular model assignment.
_Avoid_: Model, persistent Agent identity

**Gateway Profile**:
A reusable machine-local connection to an LLM gateway, including its endpoint, secret reference, headers, and verified capabilities. A Workspace selects a Gateway Profile and model assignment without copying credentials into shared configuration or Production Run records.
_Avoid_: Producer Profile, model, API key

**Query Agent**:
A short-lived read-only Agent that answers a Knowledge Query from accepted Claims and Evidence References without changing authoritative knowledge.
_Avoid_: Worker Agent, Web Enrichment, chat memory

**Production Run**:
One attempt to derive and publish a Knowledge Bundle from a fixed Source Set under a declared Coverage Policy.
_Avoid_: Agent session, conversation

**Run Worker**:
The isolated process or container that executes one Production Run and owns its local scheduling, state, and staging area.
_Avoid_: Distributed platform, Worker Agent

**Analysis Task**:
A bounded assignment of source scope and coverage obligations to a Worker Agent.
_Avoid_: Production Run, free-form investigation

**Coverage Obligation**:
A source-derived knowledge item that requires an explicit disposition before a Production Run can publish.
_Avoid_: Prompt instruction, suggested topic

**Coverage Policy**:
The declared rules that determine which source-derived knowledge is mandatory, supporting, or excluded for a Production Run.
_Avoid_: Prompt, best-effort scope

**Producer Profile**:
A versioned declaration of coverage, verification, authority, and bundle-organization rules applied to a Production Run.
_Avoid_: Agent prompt, ad hoc configuration

**Major Obligation**:
A Coverage Obligation that must be covered or explicitly excluded before publication.
_Avoid_: Priority hint, optional topic

**Supporting Obligation**:
A Coverage Obligation that may be explicitly deferred without blocking publication.
_Avoid_: Ignored content, Major Obligation

**Source Universe**:
The complete versioned source material considered by a Production Run before the Coverage Policy classifies it.
_Avoid_: Model context, selected files

**Source Unit**:
A stable, addressable portion of the Source Universe from which obligations or evidence can be derived.
_Avoid_: Chunk, prompt context

**Source Snapshot**:
An immutable, read-only representation of the Source Universe at the revision used by a Production Run.
_Avoid_: Working directory, build workspace

**Source Checkout**:
A mutable local Git working copy registered in a Workspace for clone, pull, and revision selection before a Production Run pins a Source Snapshot. A managed checkout lives under the Workspace; a linked checkout is an existing repository owned outside it.
_Avoid_: Source Snapshot, Source Unit, repository configuration

**Source Revision Policy**:
A Workspace rule that either follows a named branch or pins an exact commit for a Source Checkout. A Production Run always resolves the policy to an exact Source Snapshot revision.
_Avoid_: Source Snapshot, floating Production Run revision

**Source Set**:
The named collection of independently versioned Source Snapshots used by one Production Run for a Producer Project.
_Avoid_: Monorepo, model context

**External Knowledge Source**:
An explicitly configured source outside the Source Set that may supplement knowledge at a declared Authority Level.
_Avoid_: Unrestricted web, implicit source

**Authority Level**:
The declared degree to which a source may support or resolve Claims relative to the Source Snapshot.
_Avoid_: Model confidence, search ranking

**Data Carrier**:
A source type whose primary meaning is its fields and constraints rather than executable domain behavior.
_Avoid_: Domain Concept, unimportant class

**Data Contract**:
An aggregated description of data shape and constraints at a meaningful interface or persistence seam.
_Avoid_: DTO page, one-class Concept

**Claim**:
An atomic proposition about the source domain that is grounded by one or more Evidence References.
_Avoid_: Paragraph, summary, unsupported assertion

**Evidence Reference**:
A resolvable locator to a Source Unit at its fixed Source Snapshot revision that grounds a Claim.
_Avoid_: Citation text, filename mention

**Concept**:
A stable knowledge identity defined and supported by accepted Claims.
_Avoid_: Source symbol, file, page

**Accepted Knowledge Model**:
The authoritative set of accepted Claims, Concepts, relations, and their Evidence References from which a Knowledge Bundle is rendered.
_Avoid_: Markdown output, Agent memory

**Knowledge Query**:
A read-only question against a fixed Accepted Knowledge Model, scoped to one Concept or the complete Knowledge Bundle and answered with explicit Claim and Evidence References.
_Avoid_: Analysis Task, Web Enrichment, knowledge mutation

**Source Investigation**:
An explicitly requested read-only investigation of a fixed Source Snapshot when accepted knowledge cannot answer a question. Its result is provisional, source-cited, and never part of the Accepted Knowledge Model unless it later passes the normal production and review process.
_Avoid_: Knowledge Query, accepted Claim, Web Enrichment

**Source Investigation Agent**:
A short-lived read-only Agent that performs one Source Investigation with bounded list, literal search, and read tools against fixed Source Snapshots without changing authoritative knowledge.
_Avoid_: Query Agent, Worker Agent, knowledge editor

**Verification Finding**:
A typed assessment of a proposed or accepted knowledge item from one explicit semantic verification perspective.
_Avoid_: Vote, direct state mutation

**Acceptance Policy**:
The deterministic rules that translate structural validation, Verification Findings, risk, and review outcomes into accepted, rejected, or review-required states.
_Avoid_: Verifier prompt, model judgment

**Review Required**:
A publication state in which accepted knowledge changes require an explicit human disposition before publication.
_Avoid_: Failed Run, Markdown proofreading

**Guarded Auto-publish**:
An explicitly enabled publication mode that skips human approval only when the Acceptance Policy finds no review trigger.
_Avoid_: Unconditional publishing, default mode

**Benchmark Corpus**:
A versioned set of representative Source Snapshots with human-reviewed expected obligations, knowledge, evidence, conflicts, and exclusions.
_Avoid_: Demo repository, ad hoc evaluation

**Mutation Case**:
A controlled source change used to verify invalidation, preservation, deletion, and incremental equivalence behavior.
_Avoid_: Random edit, model prompt variation

**Agent Evaluation**:
A repeatable assessment of an Agent Role's decisions, tool trajectory, typed results, and contribution to end-to-end knowledge quality.
_Avoid_: Final-page review, model self-rating

**Knowledge Impact Graph**:
The traceable dependencies from Source Units through Evidence References, Claims, Concepts, and rendered pages used to determine incremental invalidation.
_Avoid_: Wiki link graph, model context

**Run Event**:
An immutable record of an accepted Production Run state transition.
_Avoid_: Agent message, model output
