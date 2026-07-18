# Remaining technical debt (post-ADR 0018)

Updated after debt remediation pass.

## Closed in this pass

- Bare `okf-wiki` on TTY → Operator Session (`tui`) via argv normalize
- `wiki-run` without approval exits **3** when `awaiting_publication` (CI fail-closed) + stderr hint
- Publication status dict helpers (`publication_status.py`)
- Session `/mode build|ask` and `/usage`
- Preflight for Anthropic / Google families (in addition to OpenAI)
- Session TTY errors already redacted (`safe_error_message`)

## Still open (deliberate / larger)

| Item | Why deferred |
|---|---|
| Full conversation `Agent.iter` ask/chat agent | Needs design for Host-free turns vs Wiki Runs; ask mode records history only for now |
| Publish as model-invoked `requires_approval` tool | Host gate uses pydantic-ai DeferredTool *types* + handler; wiring into agent graph is a separate cut |
| harness `StepPersistence` as Session store | File SessionStore is multi-session index; StepPersistence attaches to a conversation Agent when that exists |
| Default entry without subcommand on non-TTY | Still requires explicit subcommand (wiki-run / doctor) — intentional for CI |
| Multi-model reviewer panel | Explicitly out of scope (single Reviewer + optional model) |

## Operator notes

- Interactive: `okf-wiki` or `okf-wiki tui`
- Automation: `okf-wiki wiki-run --yes` (or `--yolo`)
- Session: `/mode ask` to avoid accidental Wiki Runs while exploring
