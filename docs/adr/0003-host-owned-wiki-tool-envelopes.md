# Generic subagent tool

The Lead has one business tool, `subagent({ agent, task } | { tasks })`. Agent
names resolve to `agents/*.md`. Output format lives in those files. Stage order
lives in `prompts/lead.md`.

Worker output is draft-first: the host creates one execution-owned durable
draft, the worker edits and submits it through a bound tool, and the host seals
the final Handoff only after validating the current draft and Candidate. Raw
assistant text is activity, not a stage result. This keeps progress available
through compaction and process interruption without granting general write
access to Run ledgers.

`publish` validates OKF, topology from the template pack, sources, and a review pass, then installs `wiki/`.
There is no empty-parameter envelope and no parallel file protocol for the same
fact.
