# Adaptive Wiki Run rollout decision

Date: 2026-07-16

## Decision

Keep adaptive orchestration **enabled by deterministic scale triggers** (multi-repository, file count, or byte thresholds) and keep small single-repository runs on the historical CodeMode-only path. DynamicWorkflow remains **opt-in** (`adaptive_dynamic_workflow=false` by default). The independent Wiki Reviewer is **on by default** for adaptive runs and can be disabled with `adaptive_enable_reviewer=false`.

This is the selected rollout state after shipping:

1. observable run events and Analysis Receipts
2. bounded Root → Domain → Leaf SubAgents with receipts
3. optional Reviewer (read-only `/wiki`)
4. provider transport retries and Manual Retry Runs
5. the Textual Operator Session (`okf-wiki` / `okf-wiki tui`) as the default operator surface (ADR 0018)

## Evaluation arms

`okf-wiki wiki-eval` continues to exercise the fixture corpus. Adaptive comparison arms are:

| Arm | Configuration |
|---|---|
| CodeMode only | thresholds high enough that adaptive stays off |
| Planning + compaction + SubAgents | default adaptive thresholds |
| SubAgents + DynamicWorkflow | `adaptive_dynamic_workflow=true` where Domain→Leaf fan-out is homogeneous |

All arms share the same Skill digest, validator, whole-tree envelope defaults, and snapshot fixtures. Live multi-repository quality gates remain operator-run against OpenWiki, IWE, and Open Knowledge snapshots.

## Acceptance checklist

- Small cases do not pay SubAgent fan-out by default.
- Large/multi-repository cases can delegate Domain/Leaf research and reduce through receipts.
- Root remains the only `/wiki` writer; Reviewer is read-only.
- Unresolved critical branches cannot publish a replacement Wiki.
- Provider transport retries are bounded to three attempts and do not restart the whole run.
- Manual Retry reuses frozen revisions/Skill/model/limits with a new run identity.
- TUI is opt-in (`okf-wiki tui`) and non-TTY rejects cleanly; `wiki-run` JSON is unchanged.
- Full pytest, ruff, and ty checks pass for this rollout state.

## Follow-ups (not blocking)

- Leaf-specific critical vs non-critical cancel flags in the Run Plan
- Live eval cost/latency dashboards beyond fixture reports
- Full-screen TUI tree only if line-oriented status proves insufficient
