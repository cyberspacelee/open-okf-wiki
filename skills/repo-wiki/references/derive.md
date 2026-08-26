# Derive proposals

You generate the human-reviewed proposals from the finished Candidate and
drafts. You write only under `.okf-wiki/proposals/` — never touch AGENTS.md,
CONTEXT.md, or `docs/adr/` directly.

Read `references/contract.md` (Proposals section) first. Inputs: the published
page list with descriptions, the survey drafts, the run id.

## AGENTS.md managed block → `proposals/agents-block.md`

In a multi-source workspace, produce one block per source
(`proposals/agents-block-<source>.md`) — each source repo gets its own
AGENTS.md, pointing into the workspace Wiki's pages for that source plus the
cross-source architecture page.

Produce only the content between `<!-- okf-wiki:begin run=<id> -->` and
`<!-- okf-wiki:end -->`, two short sections:

1. **Pointers**: one line per domain — "working on X? read `wiki/<...>.md`
   first" — built from page descriptions. Plus one line for the architecture
   map. Nothing that duplicates what the pages themselves say.
2. **Verify**: the smallest real verification entry point for this source's
   build system — look it up in pom.xml / build.gradle / package.json / CI
   config (`mvn -q test`, `pnpm test`, …) and run it once to confirm it
   works. If it cannot run in this environment, record the command with a
   note saying why it was not executed. A generic command unrelated to the
   source's build (e.g. a bare git check) is worse than an honest note —
   agents will trust whatever stands here.

Keep the whole block under 15 lines. Every line must pass: "would an agent
without this line make a worse first move?"

## CONTEXT.md draft → `proposals/context-draft.md`

From survey drafts, collect candidate terms: recurring domain concepts with
their definitions and evidence locators. Where source uses competing names for
one concept, list the cluster under `<!-- pending-ratification -->` and do not
choose a winner. Skip general programming vocabulary — only terms unique to
this codebase belong.

## ADR stubs → `proposals/adr/NNNN-<slug>.md`

For each observed decision that is hard to reverse, surprising without
context, and a real trade-off: fill `Decision` (what was chosen, with
locators) and leave `Context / Rationale: (human)`. Commit messages and code
comments may serve as rationale evidence when they exist — cite them. No
qualifying decision found means no stub; do not manufacture significance.

## Receipt

Return at most 10 lines: proposal paths written, term count, stub count.
