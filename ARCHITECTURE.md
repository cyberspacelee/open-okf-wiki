# Wiki Producer architecture

Canonical language lives in [CONTEXT.md](CONTEXT.md).

The Pi factory is `extensions/wiki/index.ts`. `createProductionWikiProducer()`
in `extensions/wiki/lib/` starts one Run: pin Sources, empty Candidate, Lead
session with a `subagent` tool, then OKF validation and rename to `wiki/`.

SOP is `prompts/lead.md`. Named workers are `agents/*.md`. TypeScript does not
encode research/write/review stages.

Workspace init and `/wiki source add` stay host commands. Pi TUI is the user's
shell; Wiki does not ship a status overlay.
