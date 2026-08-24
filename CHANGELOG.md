# Changelog

All notable changes to `@okf-wiki/wiki-workflows` are documented here.

## [Unreleased]

### Breaking: structured page contracts

- Template packs now require explicit `id`, `type`, placement, `filename`,
  `cardinality`, `required`, and `purpose` fields. Evidence-selected contracts
  also require `applies_when`; diagrams name their section and allowed kinds.
  Legacy `optional`, `instructions`, and output-placeholder bodies are rejected.
- Each Wiki directory kind has one explicit `identity` contract, independent
  from other required singleton contracts at the same placement.
- Template bodies define H2 semantic obligations and guidance. The host derives
  writer skeletons and mechanical validation from the same contract.
- `many` contracts support separate topic pages such as `flow-<slug>.md`,
  `api-<slug>.md`, and `runbook-<slug>.md`.
- Survey handoffs now account for public surfaces, boundaries, invariants,
  lifecycle/failure paths, verification, and evidence gaps. Semantic review uses
  one Coverage/Grounding/Ownership/Actionability/Navigation rubric.

### Breaking: one current full-generation Run

- A Workspace stores at most one current Run in `.okf-wiki/run/`. Run lists,
  Run-id arguments, historical lookup, and terminal Run retention are removed.
- Every Run starts from an empty Candidate. Starting deletes the legacy
  `.okf-wiki/runs/` tree; there is no state migration or incremental refresh.
- Pause and failure retain the current Candidate, Board, handoffs, receipts,
  and Lead session for `/wiki resume`. Success and cancel remove them.
- Run records use schema 3 and are accepted only when their Workspace and
  Candidate paths match the current layout. Malformed or foreign records fail
  closed instead of being normalized as legacy state.
- Workspace transition and owner files prevent concurrent starts and reject
  control from another live process.

### Recoverable full replacement

- Candidate validation now materializes generated files before review and
  freezes their digest. Review and publication must refer to that exact digest.
- Publication replaces the whole `wiki/` directory through a recoverable
  journaled transaction. The previous Wiki exists only as a rollback backup
  during the transaction and is removed on commit.
- Recovery completes an installed Candidate when its digest matches or restores
  the previous Wiki. Removed pages therefore cannot survive a successful Run.

### Evidence boundary

- Agent filesystem reads are limited to pinned Sources, the current Candidate,
  and current handoffs. Real paths are checked so Source symlinks cannot escape
  their pinned root.
- Runtime state, the published Wiki, `workspace.yaml`, and private dotenv files
  are excluded from implicit-Source evidence even when default ignores are
  disabled. `.env.example` and `.env.sample` remain readable.
- Citation validation rejects symlinked files and verifies the cited file's real
  path remains inside its pinned Source.

### Wiki contract

- Explicit Workspaces organize repository, Domain, and Concept knowledge under
  `wiki/<scopeId>/`; root pages own cross-Source composition. Implicit
  Workspaces keep Domain and Concept pages directly under `wiki/`.
- Multi-Source generation requires every Source survey before one cross-Source
  synthesis pass. Writers are confined to disjoint Candidate prefixes and must
  read every cited source file or exact cited range in their own session.
- Template packs define required page placement, H1/H2 structure, evidence,
  and Mermaid requirements. Host-generated `index.md` and `log.md` are included
  in the frozen Candidate before review.
- Writers receive one runtime citation contract with the current Source roots,
  optional line ranges, Catalog syntax, and complete footnote shape. Validation
  rejects an inline `[^id]` reference without its `[^id]: ...` definition.
- Optional openGauss Catalog evidence remains on-demand and read-only through
  `db_tables` and `db_describe`; pages cite described tables as `catalog:table`.

### Commands

- Current Run commands are `/wiki [focus]`, `/wiki status`, `/wiki pause`,
  `/wiki resume`, and `/wiki cancel`.
- Workspace setup remains `/wiki init` and `/wiki source add link|clone`.
