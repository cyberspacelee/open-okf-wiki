# Operator Session UI projection

Model tool loops keep **full fidelity** inside Mastra. What operators see and
what is persisted on `OperatorSession.messages` is shaped by
`packages/agent/src/ui-projection.ts` and applied in `session-stream.ts`.

## Tool payload rules

| Tool | Session / UI projection |
|------|-------------------------|
| `write_wiki` | Drop `input.content`; keep `path`, `contentPreview` (≤2KB), `contentChars`, `truncated` |
| `read_source` / `read_skill` / `read_wiki` | Truncate `content` to ≤4KB; set `contentChars`, `truncated` |
| `list_source` / `list_skill` / `list_wiki` | Cap `entries` at 200; set `entryCount`, `truncated` when capped |
| unknown | JSON-bounded + secret redaction |

Historical sessions are re-projected on load via `sessionMessagesToUIMessages`.

## Product data parts

| Part | When | Purpose |
|------|------|---------|
| `data-plan` | Plan gate | Full `WikiRunPlan` for PlanViewer |
| `data-gate` | Plan / publish HITL | Decision chips only |
| `data-run` | Run start / resume | Linked run id badge |
| `data-progress` | Phase changes | Human phase chip (`planning` → … → `done`) |
| `data-plan-progress` | After plan + each `write_wiki` | Page checklist status |

Do **not** invent fake `tool-request_user_decision` for HITL (ADR 0025/0026).

## Non-goals

- External web search tools / AI Elements `sources` / `web-preview` (ADR 0002)
- Truncating model-side tool results inside Mastra agent memory
