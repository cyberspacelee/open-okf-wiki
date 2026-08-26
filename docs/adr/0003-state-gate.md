# State Gate: scripts are the only writers of Run state

`.okf-wiki/state.json` is the single durable source of truth for Run progress,
and only the state script may mutate it. Completing a phase target is not an
agent self-declaration: the `complete` transition runs validation as a
precondition and refuses to advance on failure. Resume is therefore trivial
and host-agnostic — any agent, any session, any model reads `state status`
and continues from the earliest incomplete phase. `publish.js` re-validates
the whole Candidate transactionally as the final backstop, so a derailed
orchestration can waste tokens but cannot install a bad Wiki.

Considered: conversation-checkpoint injection as in v1. Rejected: it binds
resume to one host's compaction machinery, while on-disk state works in every
host including dumb ones.
