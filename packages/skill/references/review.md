# Review

Review the Wiki as both a first-time reader and a source verifier. Repair before completing:

## Narrative and structure

- unclear purpose, audience, terminology, or navigation from root concept page **`overview.md`**
- an important boundary, module, flow, or concept that readers need but cannot find
- pages or sections that are thin, duplicated, stale, or better merged or split
- broken concept cross-links, orphan pages, heading mismatches, raw HTML, or temporary artifacts
- **Related pages / 相关页面** lists that pack multiple links on one line, omit the relationship
  phrase after `—`, or only restate the target title without saying how *this* page relates
- diagrams that add no clarity or disagree with prose and source

## OKF page format (semantic quality)

- missing or empty required frontmatter fields (`type`, `title`, `description`, `timestamp`)
- junk or drifting `type` values that do not help readers (recommended: `overview` \| `architecture`
  \| `module` \| `flow` \| `concept`; custom allowed when needed—flag junk, do not invent an enum hard fail)
- overview narrative living on `index.md`, or other concept-shaped content written as reserved
  `index.md` / `log.md` (agent must not own those names)
- inline body `repo:` links, `[Source](repo:…)` beside prose, numeric footnotes, or missing
  `# Citations` when the page lists source evidence
- claims that overstate the cited source, empty or misleading citation lists, or material claims
  with no supporting entry under `# Citations`

**Note:** the Run Boundary hard gate checks mechanical placement and URI shape only. It does **not**
resolve Snapshot path/line existence and does **not** require ≥1 citation. Citation **quality** and
claim support are Review responsibilities.

## Completion

Complete only when every manifest **concept** page exists, has a distinct reader purpose, is
reachable from the Wiki narrative (`overview.md` and concept edges), carries compliant OKF
frontmatter, and passes this review without a known defect.
