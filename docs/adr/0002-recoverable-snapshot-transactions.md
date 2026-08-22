# Recoverable Candidate install

Installing `wiki/` is a recoverable full replacement. Candidate validation
materializes generated indexes and publication metadata, then records the
final Candidate digest. Review attests exactly that digest; publication rejects
any later mutation.

The publisher writes `.okf-wiki/publication/journal.json`, moves the existing
`wiki/` to the transaction-only `previous/`, renames the current Candidate to
`wiki/`, and verifies the installed digest. Recovery completes the candidate
install when possible or restores `previous/`. Commit removes the journal and
backup, so no historical Wiki snapshot remains.
