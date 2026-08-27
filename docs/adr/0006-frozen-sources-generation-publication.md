# Generation-pointer publication

Publishing installs an immutable content-addressed directory, then atomically
replaces the small current.json file. A previous pointer provides rollback.
wiki/ is a separate recoverable export, because replacing a nonempty directory
is not one portable atomic operation and Windows link privileges make symlink
indirection unsuitable as the default.

Incremental reuse stays narrow: survey and source-owned plan shards require
that Source's commit; connect and workspace plan require all Git/files
commits and catalogs; pages require an identical Page Plan entry, unchanged
cited Git blob IDs and an unexpired stale_after. Live HEAD may move; workers
read Pins (ADR 0011). No generic dependency graph is kept.
