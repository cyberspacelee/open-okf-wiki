---
name: repository-wiki-producer
description: Produce or refresh a source-grounded Wiki from a pinned Repository Snapshot Set.
---

# Repository Wiki Producer

## Run one semantic loop

The Root Agent owns this loop and advances only when the current completion gate holds. Maintain a
living **WikiRunSpec** (domains, pages, questions, acceptance, changelog) via Host `read_spec` /
`write_spec` tools. On large or multi-domain scopes, Root opens the bounded Domain → Leaf research
branch; children investigate and return evidence, while Root keeps Spec synthesis, Wiki writing, and
repair after the Host review council. Return to an earlier step whenever later evidence breaks its
gate. The Host always runs review and **fails the run** if blocking defects remain after repair
rounds.

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
   Add only pages with distinct purposes; split, merge, and cross-link them as the evidence demands.
   When the scope is large or spans independent domains, maintain a living Spec (domains, pages,
   questions, changelog) and decide whether a self-contained Domain task will reduce context
   pressure. Prefer the fewest Domains that still isolate independent evidence; do not open empty
   roster slots. When two or more Domains are needed and independent, delegate Domain researchers
   in parallel via the host agent tools rather than serial one-by-one waits. Each Domain task must
   be fully self-contained (scope, questions, and completion gate)—children never see this
   conversation. A Domain may use the listed Leaf Researchers for one further bounded layer; every
   branch must return evidence before Root reduces the result. Do not call Reviewer until staged
   Wiki pages exist. Keep the Spec's objective, acceptance gates, intended pages, open questions,
   and changelog concise and current. Replan the Spec when discovery changes the page set.
   **Completion gate:** every intended page has a clear reader purpose and enough inspected evidence
   to write, and further inspection would not materially improve the intended Wiki.
3. **Write the Wiki.** Select only relevant files from
   `/skill/templates/{overview,architecture,module,flow,concept}.md`, read them in full, and adapt
   them while writing final Markdown directly under `/wiki`. Place verified Source Citations beside
   the facts they support, cross-link related pages, and use reader-oriented prose and
   source-consistent diagrams. **Completion gate:** every intended page exists, answers its reader
   question, links to related pages where useful, and is grounded by nearby verified Source
   Citations.
4. **Review and finish.** The Host always runs an independent Reviewer (and may run a review
   council). Read `/skill/references/review.md` and treat Reviewer defects as blocking work: repair
   each issue, returning to earlier steps when page scope or evidence changes. Reopen load-bearing
   source spans as needed rather than treating a child summary as proof. Do not claim completion
   while blocking defects remain — the Host fails the run if review is unclean after repair rounds.
   A partial, failed, or cancelled critical branch may be retried only within the Run Boundary
   budget; if direct fallback research cannot complete it, fail the Wiki Run and preserve the
   previous Published Wiki. Internal child or budget failure is not Needs Input. Then return the
   exact Markdown page manifest. **Completion gate:** every review check passes, every critical
   planned scope is complete, every non-critical cancellation is explicit in the Spec, and the
   manifest exactly matches the final page tree.

## Core output contract

Begin every page with unique-key YAML frontmatter containing a non-empty `title`; keep internal Wiki
links relative and ending in `.md`. For one repository, write Source Citations as
`[Source](repo:path/to/file.py#L10-L20)`. For multiple repositories, prefix the path with the
repository ID: `[Source](repo:repository-id/path/to/file.py#L10-L20)`. Use repository-relative POSIX
paths and one-based inclusive line ranges. Line numbers must come from `read_source` (`lineCount`
and numbered `N|` lines) or `search_source` hits — never invent or estimate ranges. The `N|` prefix
is tool metadata only; do not copy it into page prose.

Return Needs Input only when missing external information makes a trustworthy Wiki impossible;
resolve routine uncertainty by continuing the semantic loop.
