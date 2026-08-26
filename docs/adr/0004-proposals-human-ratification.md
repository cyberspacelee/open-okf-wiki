# Proposals with human ratification; machines never canonize

Everything that would touch a Source repository (AGENTS.md content, CONTEXT.md
terms, ADR records) is generated only as a Proposal under
`.okf-wiki/proposals/` and applied through explicit human review. AGENTS.md is
writable solely inside a version-stamped Managed Block; human text outside it
is never touched. CONTEXT.md is never auto-ratified: machines detect drift and
draft candidates with synonym clusters marked "pending ratification", and a
human canonizes terms — normative language is team consensus, not a derivable
fact. ADR stubs carry machine-filled Decision + evidence; Context/Rationale is
human-filled, because code records what was chosen but never why. No apply-all:
item-by-item confirmation is the review, not overhead on it.

This mirrors the industry-wide generate-refine-commit loop (/init scaffolds)
and the deliberate absence, across all major agent vendors, of glossary
auto-generation.
