# Skill-driven harness replaces host-orchestrated pipeline

An earlier host-orchestrated pipeline drove Wiki generation from a ~9.6k-line
Pi process that owned sessions, budgets, worker contracts, and repair loops.
The skill harness inverts the trust model: any host coding agent orchestrates
by following SKILL.md, while every guarantee worth keeping (citation
anchoring, structural validation, transactional publish, read-only DB access,
durable state) moves into deterministic CLI scripts. Review isolation is an
explicit distinct-session gate without owning the host process. We accept
losing hard process control (turn/token caps) because the thin-Wiki scope no
longer needs it, and gain portability across host agents and Windows, Linux
and macOS. The host session only coordinates workers and deterministic gates;
it does not execute content phases itself.

Considered: incrementally slimming the previous host. Rejected because most of
its complexity served the detailed-Wiki contract machinery that the thin-Wiki
decision (ADR 0002) removes wholesale.
