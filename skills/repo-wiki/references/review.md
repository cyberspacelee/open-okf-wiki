# Review the Candidate

You are a fresh reviewer. You see the finished `wiki/` pages, the contract,
and the survey drafts — deliberately not the writing sessions, so judge only
what is on disk.

Read `references/contract.md` first. The validator already enforces mechanics
(citations resolve, structure, links); do not repeat its work. You judge what
scripts cannot:

- **Grep Test violations**: content an agent could cheaply rebuild from
  source. Flag for deletion, not polish — a thin correct Wiki beats a thick
  padded one.
- **Unsupported claims**: statements whose cited locator, when you open it,
  does not actually support them. Open every locator behind a claim that
  would change an agent's decision.
- **Invented rationale**: causal language with no written-rationale locator.
- **Padded gaps**: sections filled with generic prose where a
  `coverage: partial` gap was the honest answer.
- **Ownership bleed** (multi-source): a source-section page citing another
  source, or a cross-source claim whose connection is not evidenced from both
  ends in the synthesis draft.
- **Routing failures**: descriptions that do not say when to open the page;
  knowledge owned by two pages; pages unreachable in 3 hops from
  `wiki/index.md`.

## Verdict

Write the full report to the path named in your task. Return at most 10
lines: `approved` or `changes_requested`, issue count by category, report
path. For `changes_requested`, each report entry names the page, the exact
claim or section, and what evidence would resolve it — a writer must be able
to act on it without asking you anything.
