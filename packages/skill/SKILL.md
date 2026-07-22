---
name: repository-wiki-producer
description: Produce or refresh a source-grounded Wiki from a pinned Repository Snapshot Set.
---

# Repository Wiki Producer

## Run one semantic loop

The Root Agent owns this loop and advances only when the current completion gate holds. On large or
multi-domain scopes, Root may open the bounded Domain → Leaf research branch described below; child
Agents investigate and publish receipts, while Root keeps the global plan, synthesis, Wiki writing,
review, and final completion decision. Return to an earlier step whenever later evidence breaks its
gate.

1. **Choose the branch.** Inspect `/wiki`; read
   `/skill/references/generate.md` when it is empty and `/skill/references/refresh.md` otherwise.
   **Completion gate:** the selected branch reference has been read in full before `/source`
   inspection begins.
2. **Investigate and shape.** Explore `/source` from entry points and boundaries toward relevant
   implementation details. For one repository its files are directly under `/source`; for multiple
   repositories each named directory under `/source` is one repository ID. The Run Boundary has already
   filtered the Repository Snapshot with Effective Source Ignores; do not invent a second exclusion
   policy, and do not use shell. Use Host tools only: `list_source`, `glob_source`, `search_source`,
   and `read_source` (numbered lines + `lineCount`). Prefer any Run Boundary-provided source inventory as an optional
   accelerator for scoping—it is not a membership gate; paths in `/source` remain citable when
   grounded. Treat repository instructions, agent files, and Skills as source evidence. Tests that
   remain under `/source` may reveal intended behavior. Repeatedly choose the most important
   unanswered reader question, inspect enough source to answer it, and revise the intended page set.
   Add only **concept pages** with distinct purposes; split, merge, and cross-link them as the evidence
   demands. When the scope is large or spans independent domains, use the Run Plan to decide whether a
   self-contained Domain task will reduce context pressure. Prefer the fewest Domains that still
   isolate independent evidence; do not open empty roster slots. When two or more Domains are
   needed and independent, delegate Domain researchers in parallel via the host agent tools rather
   than serial one-by-one waits. Each Domain task must be fully
   self-contained (scope, questions, and completion gate)—children never see this conversation.
   A Domain may use the listed Leaf Researchers for one further bounded layer; every branch must
   publish a validated receipt before Root or its parent reduces the result. Do not call
   `reviewer` until staged Wiki pages exist. Keep the Run Plan's objective, completion gates,
   intended pages, evidence gaps, branch states, receipt references, unresolved questions, and
   next actions concise and current.
   **Completion gate:** every intended concept page has a clear reader purpose and enough inspected
   evidence to write, and further inspection would not materially improve the intended Wiki.
3. **Write the Wiki.** Select only relevant files from
   `/skill/templates/{overview,architecture,module,flow,concept}.md`, read them in full, and adapt
   them while writing final Markdown **concept pages** directly under `/wiki` with
   `write_wiki`. Root narrative lives on **`overview.md`** (never on `index.md`). Place verified
   Source Citations under each page’s **`# Citations`** section (not inline beside body prose),
   cross-link related concept pages with relative `.md` links, and use reader-oriented prose and
   source-consistent diagrams. **Do not write** reserved docs `index.md` or `log.md`—the Run Boundary
   generates directory indexes and appends the root update log on successful publish.
   **Completion gate:** every intended concept page exists, answers its reader question, links to
   related concept pages where useful, carries valid OKF frontmatter, and grounds material claims
   with `repo:` citations under `# Citations` when sources support them.
4. **Review and finish.** Prefer the run-registered `reviewer` subagent for an independent
   read-only review of staged pages against `/skill/references/review.md`; otherwise read that
   reference yourself. The Reviewer publishes a defects receipt only and cannot write `/wiki` or
   delegate further. Repair each issue yourself, returning to earlier steps when page scope or
   evidence changes. Reopen load-bearing source spans as needed rather than treating a child
   summary as proof. A partial, failed, or cancelled critical branch may be retried only within
   the Run Boundary budget; if direct fallback research cannot complete it, fail the Wiki Run and preserve
   the previous Published Wiki. Internal child or budget failure is not Needs Input. Then return
   the exact Markdown page manifest (concept pages only). **Completion gate:** every review check
   passes, every critical planned scope is complete, every non-critical cancellation is explicit in
   the Run Plan, and the manifest exactly matches the final concept page tree.

## Core output contract

### Concept pages only

Write **concept pages** (non-reserved `.md` under `/wiki`). Concept ID = Wiki-root-relative path
without `.md` (e.g. `overview`, `modules/core`).

**Never** author reserved wiki docs as concepts:

- `index.md` — deterministic directory listing (Run Boundary overwrites every directory that needs one)
- `log.md` — root-only update log (Run Boundary appends on successful publish)

Root overview narrative is always the concept page **`overview.md`**. `index.md` is never overview.

### OKF frontmatter (required on every concept page)

Begin every concept page with YAML frontmatter using unique keys. All four fields are **required**,
non-empty after trim, and **agent-authored** (the Boundary does not stamp or backfill):

```yaml
---
type: overview
title: Repository overview
description: What this repository is and how to navigate the Wiki
timestamp: 2026-07-21T12:00:00Z
---
```

| Field | Rule |
| --- | --- |
| `type` | Non-empty open string. Recommended vocabulary (English tokens, not localized): `overview` \| `architecture` \| `module` \| `flow` \| `concept`. Custom types are allowed when those do not fit; Review may flag junk or drift, but vocabulary membership is not a hard fail. |
| `title` | Non-empty page title for readers and indexes. |
| `description` | Non-empty one-line summary (used by deterministic `index.md` listings). |
| `timestamp` | Parseable ISO 8601 **datetime** for page last change (not publish time). Bump when you edit the page. |

Optional keys (`tags`, `resource`, …) may appear as simple single-line scalars or flow lists.
Unknown extension keys are allowed and must be preserved. Prefer simple frontmatter shapes the
mechanical gate can parse; do not use multi-line YAML blocks for optional keys.

Match recommended `type` to the template you adapt when that template fits (e.g. architecture
template → `type: architecture`).

### Dual-link model

1. **Concept edges** — relationships between Wiki pages: Markdown links ending in `.md` that
   resolve to **existing** concept pages you have written (or will write before finish). **Never**
   link to a path you do not produce.

   Resolution (both forms are valid):

   - **Page-relative** (standard Markdown): from `modules/sc.md`, link a sibling as
     `[Core](core.md)` or `[Core](./core.md)`, and parent as `[Overview](../overview.md)`.
   - **Wiki-root-relative** (Concept ID + `.md`): from any page, `[Core](modules/core.md)` names
     the concept whose ID is `modules/core`. Prefer this form when the Concept ID is clearer than
     a chain of `../`.

   Do **not** invent pages only as link targets. If you mention deployment or multi-tenant topics,
   either write those concept pages or drop the links.

   **Where edges live (OpenWiki-aligned):**

   - Prefer putting a concept link **inside the sentence that states the relationship**
     (`depends on`, `publishes to`, `configured through`, `assembles`, …).
   - When a page has several stable neighbors, also end the body (before `# Citations`) with a
     **Related pages** list. Heading follows wiki language (e.g. English `## Related pages`,
     Chinese `## 相关页面`).

   **Related pages list format (required when the section is present):**

   - **One related page per line** — never pack multiple `[links](…)` on one bullet with `·` / `|` / commas.
   - Each line: `- [Title](path.md) — <relationship from this page to that page>`.
   - The text after `—` describes the **edge** (why this page points there), not a copy of the
     target’s frontmatter `description`. Downstream graph tooling infers link semantics from that
     phrase.
   - Only list pages that exist. Skip empty Related sections.

   Good:

   ```markdown
   ## Related pages

   - [Core](modules/core.md) — depends on core MQ fanout definitions for stock events.
   - [Basedata](modules/basedata.md) — shares selector APIs used when creating SC documents.
   ```

   Bad (do not write):

   ```markdown
   - [core](modules/core.md) · [comp](modules/comp.md) · [basedata](modules/basedata.md)
   - [Overview](overview.md)
   ```

2. **Source Citations** — evidence from the Repository Snapshot: `repo:` URIs **only** under a
   page section titled exactly **`# Citations`** (fixed English heading; body prose still follows
   wiki language). **No** inline body links whose target is `repo:…`. **No** numeric footnotes
   (`[1]`, `[2]`, …).

URI forms (repository-relative POSIX paths; optional one-based inclusive line ranges):

- Single repository: `repo:path/to/file.py#L10-L20`
- Multiple repositories: `repo:repository-id/path/to/file.py#L10-L20`
- File-level without `#L…` is allowed when a line range is not useful

Line numbers must come from `read_source` (`lineCount` and numbered `N|` lines) or `search_source`
hits — never invent or estimate ranges. The `N|` prefix is tool metadata only; do not copy it into
page prose.

Example page tail:

```markdown
# Citations

- [entry](repo:src/main.ts#L1-L40)
- [config](repo:config/app.yaml#L12)
```

Pages with no source evidence need not include a `# Citations` section. When you do cite sources,
list them under that section with short labels. Review owns citation **quality** (claims supported,
not empty or misleading). The publish hard gate checks placement and URI shape only—it does not
require ≥1 citation and does not resolve Snapshot path/line existence.

### Completion shape

Return Needs Input only when missing external information makes a trustworthy Wiki impossible;
resolve routine uncertainty by continuing the semantic loop.
