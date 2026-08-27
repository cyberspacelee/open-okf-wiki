# Proposals are an optional post-publish command

AGENTS/CONTEXT/ADR proposals remain human-ratified (ADR 0004) but are no
longer a Wiki phase. Write completion opens review; publication does not
read `proposals/`. `okf propose` runs against the current Publication, may
emit zero files, and never blocks the Wiki. Review reopen cannot stale a
proposal that has not been written yet.

Considered: publish-time templates; considered running propose in parallel
with review. Rejected: templates cannot run Verify in a Source; parallel
propose goes stale when review reopens pages.
