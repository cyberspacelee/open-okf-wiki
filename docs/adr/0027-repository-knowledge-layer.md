# Repository Knowledge Layer replaces the Run-based Domain Wiki pipeline

Status: accepted. Supersedes ADRs 0003, 0005–0026. Amends 0001, 0002 and
0004. Design: [repository knowledge layer](../design/repository-knowledge-layer.md).
Evidence: [research notes](../research/repository-knowledge-layer-evidence.md).

## Decision

repo-wiki produces a **pull-based knowledge layer for coding agents**. The
knowledge layer is an OKF v0.2 bundle that is versioned in Git next to the code
it describes. It records only knowledge that is expensive to rediscover:

- architecture boundaries and design rationale
- invariants and failure modes
- workflows and lifecycles
- project terminology
- development conventions
- extension points and change impact

It is not a code encyclopedia. Nothing in it is loaded into an agent's context
by default. A short pointer in AGENTS.md is the only always-loaded content.

### Workflow

The skill runs five stages: **Discover, Structure, Research, Write,
Review & Stamp**. **Update** re-enters only the pages that `okf impact`
reports as stale.

### Kernel responsibilities

The deterministic kernel owns:

- repository scanning (`scan`)
- derived status
- validation, with a repair hint on every issue
- review-subject binding
- stamping: provenance frontmatter and the root `index.md`
- impact analysis

The agent owns judgment. SKILL.md is a control plane of about 150 lines, not
a protocol.

### What persists and where

- **Page frontmatter is the page map.** Each page declares `scope` globs.
  Scope globs plus the cited files form the page-to-source mapping. This one
  mapping drives impact, staleness and coverage.
- **Claims link to sources through ordinary OKF footnotes** whose definition
  starts with a plain `path#Lx-Ly` locator. Some content must carry a
  citation:
  - glossary rows
  - convention rules
  - command rows
  - invariant rows
  - change impact rows
  - causal claims (the "why")

  Ordinary description does not need one.
- **Git is the transaction and history layer.** Every page records a
  `revision`: the source commits it was written against while in draft, and
  verified against once stable. Stamping requires clean source trees and
  `revision == HEAD`, so no page can be stamped against code it was not
  written from. Staleness is `git diff <revision> -- <scope ∪ cited files>`.
- **One directory holds everything.** The skill writes only the wiki
  directory, plus an optional managed pointer block in AGENTS.md. There is no
  runtime directory, no cache and no `.gitignore` edit. Work state lives in
  the pages themselves:
  - `status: draft`
  - a `revision` baseline
  - `<!-- okf:todo -->` blocks holding discovery briefs and pending changes

  The only transient file is the reviewer's review report, `_review.json`,
  which holds one round and which stamping deletes. The config file `repo-wiki.yaml` sits inside the wiki and
  marks its root. Everything else is recomputed from HEAD:
  - scan results
  - the review subject
  - history, from `git log`
- **The review subject is bound by hash.** An independent reviewer checks the
  exact set of changed pages, and the approval is tied to their content hash.
  Each repair round goes to a fresh reviewer context, which reads only the
  pages, the sources and the previous round's review report as an input
  artifact. Issues carry no IDs or status, and after three rounds the
  remaining issues go to the user. Same-context re-review loses
  precision, while fresh-context review finds more errors and two or three
  rounds catch most of what review can catch. Approval is recorded as OKF
  `verified`. A human stamp records a human reviewer.
- **Change impact has one home.** Cross-module co-change rows live in the
  Architecture change impact table, module-local ones in that module's Change
  guide; both are cited tables, not convention rules.

## Why

- **Generated overviews do not help, and cost more.** LLM-generated overview
  context files did not improve task success and raised cost by over 20%. The
  cause was redundancy with existing documentation (Gloaguen et al. 2026).
  Anthropic's just-in-time context and OpenAI's "AGENTS.md as table of
  contents" point the same way: agents should pull knowledge through
  lightweight identifiers, not carry an encyclopedia. This is ADR 0002's Grep
  Test, now applied to all authored content.
- **The previous pipeline protected coverage, not usefulness.** Its guarantees
  were:
  - closure over Source Areas, Domains, Concepts and tables
  - three digest-bound reviews
  - page packets and an evidence cache
  - frozen worktree pins and generation-pointer publication

  These forced one page per concept and per table, blocked authors from
  reading source directly, and made one factual fix restart Plan and
  Composition approval. None of these guarantees measured whether an agent
  could route a task or trust a claim.
- **Git already provides the rest.** It gives atomic commits, history,
  rollback and diffs. The one remaining correctness need is binding every
  stamped claim to the revision it was checked against. A per-page revision
  plus a content hash is sufficient for that.
- **Runtime directories held nothing that could not be recomputed.**
  - The old scan cache, index, progress file and review subject were all
    functions of HEAD or of the pages.
  - A hidden directory is skipped by default grep tools.
  - `.git/` can be read-only in agent sandboxes.
  - A directory outside the repository is lost when another machine or agent
    picks up the work.

  Keeping draft state in visible pages makes resumption and handoff ordinary
  file reads.
- **Terminology and conventions are the knowledge agents apply on every
  edit.** The old contract had no place for conventions. They become
  mandatory canon pages. They are written before other pages, so every writer
  uses one vocabulary and the validator can lint alias drift.

## Consequences

- **No migration.** Existing Run state, Plan and Composition artifacts, page
  packets and publications are not read or converted. The kernel is rewritten
  around the new contract. Reusable modules are copied and trimmed, not
  wrapped:
  - frontmatter and Markdown parsing
  - locator checks
  - index rendering
  - OpenGauss capture
- **ADR 0004 amended.** Machine-proposed text still never enters source files
  silently. The Wiki itself is reviewed as an ordinary Git diff before commit.
  The AGENTS.md pointer is generated deterministically (how to use the wiki,
  glossary and conventions as must-read, `okf impact --files`, an `rg` pattern
  for invariant rows, verified commands) and written only
  with approval; in a hub a human pastes it into each source's AGENTS.md.
- **ADR 0002 amended.** The Grep Test gates every authored page and section,
  not only optional depth pages. The only coverage obligation is that every
  scanned module is in some page's scope or explicitly excluded with
  a reason.
- **Scope of the first release.** Multi-repository hubs are supported as a
  mode: the hub is a Git repository holding only the wiki, with the sources as
  ignored child directories. OpenGauss is supported as an extension that
  renders Schema and Table pages directly, with no catalog cache. Neither
  shapes the core contract. Files Sources, commit-message citations and
  semantic dependency graphs are deferred until evaluations show they are
  needed.
- **Evaluation measures agent utility**, not artifact closure:
  - task-to-page routing recall, replayed from real commits
  - citation support rate
  - terminology and convention recall
  - update recall
  - with-and-without-Wiki task success and cost
