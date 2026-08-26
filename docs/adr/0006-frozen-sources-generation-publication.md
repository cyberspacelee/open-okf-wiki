# Frozen sources and generation-pointer publication

Formal Runs reject dirty Git sources and read a content-addressed archive of
HEAD. Every citation binds source, commit, path and lines. This prevents a
long Run from mixing revisions and gives incremental refresh deterministic
per-file drift signals. Local author-mode generation from a mutable worktree
is deliberately outside the formal path.

Publishing installs an immutable content-addressed directory, then atomically
replaces the small current.json file. A previous pointer provides rollback.
wiki/ is a separate recoverable export, because replacing a nonempty directory
is not one portable atomic operation and Windows link privileges make symlink
indirection unsuitable as the default.

Incremental reuse stays narrow: phase artifacts require unchanged source
hashes; pages require an identical Page Plan entry, unchanged cited file
hashes and an unexpired stale_after. No generic dependency graph is kept.
