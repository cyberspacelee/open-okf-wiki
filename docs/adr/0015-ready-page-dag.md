# Ready-set Page DAG replaces the phase pipeline

The producer keeps deterministic Source capture, Pin/Catalog Indexing and
Publication, but agent work is now only one bounded Workspace `plan` Target,
`page` Targets that combine research and writing, and per-page `review`
Targets. The Page Plan assigns each concept an owner, Source-plus-path
`scopes` and child dependencies. Source-owned pages live under
`data/<source-slug>/`; workspace root pages use owner `workspace`; every page
with children is a synthesis page. The State Gate exposes dependency-ready
Targets, a parent waits for Machine-confirmed children, and review binds the
exact page digest in an independent session. Attempt Artifacts remain isolated
until their gate promotes them. This gives the host one status/dispatch loop,
keeps worker input local and lets unrelated Page DAG branches progress
independently.

This decision supersedes ADR 0009, ADR 0013 and ADR 0014. There is no legacy
Run migration, compatibility branch or OKF version change: old phase-shaped
state is rejected and new Runs use the new contract.

## Considered Options

- Keep `triage -> survey -> connect -> plan -> write -> review`: rejected
  because exact file coverage and global barriers spend agent context without
  improving a Thin Wiki.
- Create one Target per package or file: rejected because package structure is
  navigation, not a useful page boundary, and enterprise repositories would
  create thousands of low-value Targets.
- Keep Claims, Connections or Evidence Cache sidecars: rejected because page
  workers can investigate their bounded scopes directly and page review can
  verify canonical Locators; the extra artifacts duplicate decisions and
  enlarge dispatch.
- Add LSP, embeddings, a semantic graph or dynamic split: rejected until
  bounded `outline`, `search` and `read` fail measured enterprise evaluations.
- Give one autonomous worker the whole Run: rejected because resumability,
  independent verification and coordinator context would share one failure
  domain.
