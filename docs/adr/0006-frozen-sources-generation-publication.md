# Generation-pointer publication

Publishing installs an immutable content-addressed directory, then atomically
replaces the small current.json file. A previous pointer provides rollback.
wiki/ is a separate recoverable export, because replacing a nonempty directory
is not one portable atomic operation and Windows link privileges make symlink
indirection unsuitable as the default.

Incremental reuse stays narrow: phase artifacts require unchanged Git commits
and captured catalogs; pages require an identical Page Plan entry, unchanged
cited Git blob IDs and an unexpired stale_after. No generic dependency graph
is kept.
