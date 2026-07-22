# Wiki writing adopts OKF page format

**Status:** accepted
**Date:** 2026-07-21
**Related:** ADR 0007 (Markdown → Staging + mechanical validation), ADR 0005 (Producer Skill), ADR 0019 (Run Boundary), ADR 0020 (TypeScript stack)
**Supersedes (partial):** title-only Wiki frontmatter contract implied by current Skill + `validateWikiTree` practice; Skill/narrative use of root `index.md` as overview
**Wayfind source:** [OKF page-format compliance map](../../.scratch/okf-page-format-compliance/map.md) (tickets 01–10)
**Index:** [docs/adr/README.md](README.md)

## Context

The product produces a **Wiki** (Staging / Published Markdown tree), not a Knowledge Bundle or claim ledger. Google OKF v0.1 defines a page-tree format (concept documents, reserved `index.md` / `log.md`, dual link model). OpenWiki implements a soft, index-heavy variant without a hard publish gate or log append.

Today this product enforces only a **title-only** frontmatter gate and treats overview narrative inconsistently with reserved indexes. The wayfind map locked a product-tightened OKF **page-format contract** so Skill, Run Boundary validation, and tests can implement without re-deciding scope.

Domain terms: [CONTEXT.md](../../CONTEXT.md) — **Concept page**, **Concept ID**, **OKF frontmatter**, **Reserved wiki doc**, **OKF page format**.

## Decision

1. **Product artifact remains Wiki**
   Operators and docs say **Wiki**. OKF is the **page-tree writing contract**, not a product rename. Do not reintroduce Knowledge Bundle / Accepted Knowledge Model / claim ledger as product models.

2. **Enforcement: Skill + Review + Run Boundary hard gate**
   - **Producer Skill** teaches concept frontmatter, dual-link model, recommended `type` vocabulary, and reserved-name rules.
   - **Review** owns semantic quality (claims supported by citations, structure, junk types).
   - **Run Boundary** hard-fails mechanical OKF checks on Staging at validate/publish → **no publish**; prior Published unchanged. Soft-only compliance is rejected.

3. **Concept pages (non-reserved `.md`)**
   - **Concept ID** = Wiki-root-relative path without `.md`.
   - Hard-required OKF frontmatter (agent-authored; Boundary does **not** stamp/backfill):
     `type`, `title`, `description`, `timestamp` — all non-empty strings after trim; `timestamp` parseable ISO 8601 datetime (page last change; not publish time).
   - Gate: `type` is an **open** string (no enum). Optional keys (`tags`, `resource`, …) type-checked if present; unknown extension keys allowed and preserved.
   - **Recommended `type` vocabulary** (Skill only; English tokens, not localized with `wikiLanguage`):
     `overview` | `architecture` | `module` | `flow` | `concept`. Custom types allowed when those do not fit; Review flags junk/drift, never hard-fails on vocabulary membership.

4. **Reserved wiki docs**
   - `index.md` and `log.md` are **not** Concept pages.
   - Root overview narrative lives on concept page **`overview.md`** (OKF frontmatter). **`index.md` is never overview.**
   - Agent must not write reserved names as concepts.

5. **Deterministic `index.md` (every indexable directory)**
   - Run Boundary **full-tree overwrite** at validate/pre-publish, **before** concept frontmatter + internal-link hard gates.
   - **No frontmatter** on any `index.md` (including root — **no** `okf_version`).
   - H1: root = Workspace name; nested = directory basename.
   - `## Files` / `## Directories` (omit empty sections). Files: `- [<title>](<basename>.md) - <description>` from concept FM (no inventing). Root pins `overview.md` first, then sort by title / basename. Directories: `- [<dirname>](<dirname>/)`.
   - Exclude reserved names, non-`.md`, dot entries; do not follow symlinks. Empty leaves: no index.

6. **Root-only `log.md` append on successful publish**
   - Only wiki-root `log.md`; subdirectory `log.md` → hard fail. Boundary-owned inside the publish transaction.
   - Shape: `# Wiki Update Log`; UTC `## YYYY-MM-DD` newest-first; Publish entry with runId / skill / time + Added / Updated / Removed concept paths (not generated index churn).
   - Missing → create; corrupt → replace with skeleton + this publish. **No** truncation. First publish: all concepts Added.

7. **Dual-link model**
   - **Concept edges:** relative Markdown links between concept pages. Gate **resolves internal concept link targets** (broken → fail).
   - **Source Citations:** `repo:` URIs only under page section **`# Citations`** (fixed English heading). No inline `repo:` body links; no `[n]` footnotes.
   - Forms: single-repo `repo:path#L10-L20`; multi-repo `repo:<repository-id>/path#L…`. Gate checks format/placement only — **not** Snapshot path/line existence. Review owns citation quality.

8. **Hard-cut migration**
   - No refresh-migrate of non-OKF trees; no runtime pre-OKF detector or regenerate wizard product.
   - Greenfield / OKF-native assumption. Recovery = full regenerate under OKF Skill + successful publish. Auto-publish has **no** gate bypass.
   - `refresh.md` must not preserve pre-OKF structure against the contract.

## Non-goals (this decision)

- Full OKF Knowledge Bundle producer / claim ledger / Accepted Knowledge Model.
- OpenWiki-style soft-only validation or migrate-wiki-to-okf as primary path.
- Web OKF graph UI, type browser, or log timeline product.
- Multi-repository Wiki **directory layout** under Concept IDs (prefix vs flat) — open for a later decision; citation multi-repo form is already fixed.
- Exact Web frontmatter display chrome (hide vs show) beyond “read compliant Markdown safely.”
- Skill Fork upgrade policy beyond “output trees must pass the gate.”

## Consequences

- Implementation changes (separate session): Producer Skill + templates; `validateWikiTree` / publish path (index generate, log append, FM + link + citation gates); path policy forbidding agent writes to reserved docs; fixtures and tests.
- CONTEXT glossary already carries T1 format terms; keep product language Wiki-first.
- Prior Published trees that are title-only will fail the new gate until regenerated — intentional hard cut.
- OpenWiki is a reference for index shape and dual links, **not** for soft gate or optional log.

## Implementation entry (handoff checklist)

Not decided again here — execute against this ADR + wayfind ticket answers:

1. Skill: required FM, recommended types, overview vs index, dual-link + `# Citations`, forbid reserved writes.
2. Boundary: generate indexes → validate concepts/links/citations → on publish success append root log → atomic replace.
3. Tests: fixture trees for pass/fail each hard rule; no soft-only path.
4. Docs: operator language stays Wiki; point at this ADR for format contract.
