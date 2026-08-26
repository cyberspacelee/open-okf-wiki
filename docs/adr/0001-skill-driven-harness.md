# Skill-driven harness replaces host-orchestrated pipeline

v1 drove Wiki generation from a ~9.6k-line Pi host that owned sessions,
budgets, worker contracts, and repair loops. v2 inverts the trust model: any
host coding agent orchestrates by following SKILL.md, while every guarantee
worth keeping (citation anchoring, structural validation, transactional
publish, read-only DB access, durable state) moves into deterministic CLI
scripts. We accept losing hard process control (turn/token caps, enforced
review isolation) because the thin-Wiki scope no longer needs it, and gain
portability across Claude Code, Amp, Codex, and future hosts. This branch is
an orphan restart: the deterministic kernel is ported from v1 code, the
orchestration layer is not.

Considered: incrementally slimming the v1 host. Rejected because most of its
complexity served the detailed-Wiki contract machinery that the thin-Wiki
decision (ADR 0002) removes wholesale.
