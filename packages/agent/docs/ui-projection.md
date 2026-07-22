# Operator Session UI projection

Model tool loops keep **full fidelity** inside Mastra. What operators see and
what is persisted on `OperatorSession.messages` is shaped by
`packages/agent/src/ui-projection.ts` and applied in `session-turn/`.

## Tool payload rules

| Tool | Session / UI projection |
|------|-------------------------|
| `write_wiki` | Drop `input.content`; keep `path`, `contentPreview` (≤2KB), `contentChars`, `truncated` |
| `read_source` / `read_skill` / `read_wiki` | Truncate `content` to ≤4KB; set `contentChars`, `truncated` |
| `list_source` / `list_skill` / `list_wiki` | Cap `entries` at 200; set `entryCount`, `truncated` when capped |
| `glob_source` | Cap `paths`; set `pathCount`, `truncated` |
| `search_source` | Cap `matches`; truncate match text; set `matchCount`, `truncated` |
| unknown | JSON-bounded + secret redaction |

Server chat turns project tool parts via `projectSessionMessages` on load (structural bridge is `sessionMessagesToUIMessages`); live stream uses `projectUiMessageChunk` / `projectSessionToolPart` in `session-turn/`.
On-disk sessions require `schemaVersion: 3` (unsupported versions are rejected — no migrate; wipe `.okf-wiki/sessions/*.json`).

## Product data parts

| Part | When | Who emits | Purpose |
|------|------|-----------|---------|
| `data-plan` | Plan gate | Session shell / Produce | Full `WikiRunPlan` for PlanViewer |
| `data-gate` | Plan / publish HITL | Session shell | Decision chips only (sole HITL part type) |
| `data-run` | Run start / resume | Session shell | Linked run id badge |
| `data-progress` | Phase changes | **Produce only** | Human phase chip (`planning` → … → `done`) |
| `data-plan-progress` | Spec queue + each write | **Produce only** | Page checklist status |

Do **not** invent fake tool HITL parts or `data-choice` for gates (ADR 0025/0026/0029).
Session **must not** synthesize business progress (`data-progress` / `data-plan-progress` / defects / spans / sources) — see operator-event contract + ADR 0029.

## Non-goals

- External web search tools / AI Elements `sources` / `web-preview` (ADR 0002)
- Truncating model-side tool results inside Mastra agent memory
