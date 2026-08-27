# Publish

An approved run is immutable. Publish with:

    uv run <skill>/scripts/okf.py publication publish

The command revalidates trust and citations, generates conforming index.md and
log.md, writes a content manifest, installs a content-addressed generation,
then atomically replaces current.json. A lock prevents concurrent publishers.
The previous pointer supports publication rollback.

Consumers should read the generation returned by 'publication current'.
To place a Git-managed copy at wiki/, run:

    uv run <skill>/scripts/okf.py publication export --to wiki

Export refuses to replace an unmanaged directory and restores the old export
if replacement fails. Directory replacement itself is intentionally not
claimed atomic on Windows.

Report generation digest, page count, log events and pending proposal paths.
