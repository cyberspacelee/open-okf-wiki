# Publish

An approved run is immutable. Publish with:

    uv run <skill>/scripts/okf.py publication publish

The command revalidates trust and citations, generates conforming index.md
and log.md, writes a content manifest, installs a content-addressed
generation, then atomically replaces current.json. A lock prevents
concurrent publishers; the previous pointer supports rollback.

Consumers read the generation returned by `publication current`. For a
Git-managed copy at wiki/:

    uv run <skill>/scripts/okf.py publication export --to wiki

Export refuses to replace an unmanaged directory and restores the old export
if replacement fails (directory replacement is not atomic on Windows).

Report generation digest, page count, log events and pending proposal paths.
