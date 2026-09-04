# ADR 0025: Compile Plan Intent and prepare page evidence

## Status

Accepted. Supersedes the authored-ledger and writer-owned citation portions of
ADR 0024.

## Context

The Plan Ledger mixed semantic decisions with deterministic normalization.
Agents repeated Source paths, evidence locators, Catalog table associations and
derived model units, then learned hidden cross-record constraints through
serial validation failures. Page writers repeated the same evidence reads and
manually joined locators, source metadata and footnotes. Large runs therefore
spent context on internal consistency instead of domain explanation.

## Decision

`plan.md` and `plan-intent.json` are authored. Intent contains Domains,
Concepts, relationships, ownership, Catalog classifications, participants and
Gaps. `plan compile` validates all independent semantic constraints, merges
participants, derives Catalog associations and model units, and writes
`plan-ledger.json`. The generated ledger is never edited.

After Plan approval, `composition prepare` writes the complete effective-unit,
slot, page-type, Reference Root and path contract. Composition remains one
global exact-once assignment.

After Composition approval, `page prepare` resolves each page's allowed
evidence into stable logical IDs and content-hashed, revision-bound cache
entries. Writers consume those bounded entries and cite IDs. Candidate binding
generates source metadata and footnote definitions. Catalog descriptions are
compact by default; full physical detail remains available explicitly.

The Run contract is `compiled-plan-evidence-registry`. Older Run state is
rejected without migration or dual parsing.

## Consequences

Semantic judgments remain reviewable authored data while deterministic facts
have one source of truth. Plan diagnostics can report independent failures in
one pass. Composers see derived obligations before writing. Writers no longer
construct locators or reread shared evidence, and draft readability is
independent of provenance plumbing. Cache files are disposable optimization,
not evidence authority; their binding and content digest are verified before
use.
