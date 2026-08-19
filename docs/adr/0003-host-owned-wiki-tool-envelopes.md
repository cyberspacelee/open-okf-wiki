# Generic subagent tool

The Lead has one business tool, `subagent({ agent, task } | { tasks })`. Agent
names resolve to `agents/*.md`. Output format lives in those files. Stage order
lives in `prompts/lead.md`.

`publish` validates OKF, topology, and citations, then installs `wiki/`.
There is no empty-parameter envelope and no parallel file protocol for the same
fact.
