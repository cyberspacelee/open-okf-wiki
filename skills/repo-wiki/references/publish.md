# Publish

You (the coordinator) run this yourself. The script is the gate; your job is
just the order of operations:

1. `state start --phase publish --target wiki`
2. `uv run <skill>/scripts/okf.py publish` — regenerates the index,
   re-validates every page, computes the digest, and swaps `wiki/`
   transactionally. If it reports errors, route each one back to the owning
   write target as a repair task (start → fix → complete), then run publish
   again. Do not edit candidate pages yourself.
3. `state complete --phase publish --target wiki`
4. Report to the user: page count, digest, proposal paths awaiting human
   review under `.okf-wiki/proposals/`.

The previous Wiki, if any, is kept at `.okf-wiki/publication/previous/` until
the next publish.
