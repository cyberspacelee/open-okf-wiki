# 04 — Wiki Reviewer before publish (optional model)

**What to build:** A single independent Wiki Reviewer runs before the publication approval gate on both adaptive and non-adaptive paths; operators may configure a separate reviewer model; defects are summarized into the approval context; policy can still disable the reviewer.

**Blocked by:** 02 — HITL publish: approve path

**Status:** completed

- [x] Wiki Reviewer runs before publish HITL when enabled (default on for production publish paths covered by the spec).
- [x] Non-adaptive generate/refresh also gets a Reviewer pass before publish when enabled (not only adaptive roster).
- [x] Optional reviewer model identity falls back to the producer model; Reviewer agent uses that identity.
- [x] Defects summary is available on the publish gate (bounded, secret-safe).
- [x] Disabling the reviewer via existing/extended policy skips the Reviewer agent but not Host mechanical validation.
- [x] Tests cover reviewer invocation, optional model wiring, disable flag, and gate visibility of defects with fakes.

## Comments

- 2026-07-18: Approved vertical slice from `/to-tickets` (single Reviewer, not multi-model panel).

## Answer

### Design choice

**Host-owned pre-publish Reviewer step** reusing `_make_reviewer`, not a second multi-model panel.

After Host mechanical validation of Staging succeeds and `summary.publication_changed` is true:

1. If `limits.adaptive_enable_reviewer` (existing policy flag) is true, Host runs `run_host_wiki_reviewer` once with node id `publish-reviewer` (distinct from adaptive mid-run roster `reviewer` so attempt/retry budgets do not collide).
2. Reviewer model = `WikiRunRequest.reviewer_model` when set, else the producer model (settings follow the same fallback).
3. Soft-fail: Reviewer exceptions become a bounded `failed` defects summary; the publication gate still opens (operator decides). Mechanical validation remains independent and already passed.
4. Bounded, secret-redacted defects attach to deferred `publish_wiki` approval args and to Wiki Run Record `publication.reviewer`.
5. Then existing HITL gate (`resolve_publication_approval`) runs — YOLO / handler / awaiting unchanged. Review never auto-publishes.
6. Adaptive roster still includes optional mid-run `reviewer` SubAgent when adaptive is enabled; Host pre-publish is the guaranteed gate for both adaptive and non-adaptive paths.

### Config

- `WikiRunRequest.reviewer_model: ModelProviderConfig | None`
- YAML `reviewer_model:` (string or object form, same as `model`)
- CLI `--reviewer-model provider:name` (combinable with `--config`)
- Disable: existing `adaptive_enable_reviewer=false` / `--adaptive-enable-reviewer false`

### Files changed

- `src/okf_wiki/adaptive_orchestration.py` — `ReviewDefectsSummary`, `run_host_wiki_reviewer`, optional `reviewer_model` on roster
- `src/okf_wiki/publication_gate.py` — defects on deferred publish args
- `src/okf_wiki/wiki_run.py` — Host review before gate; lifecycle + record fragment
- `src/okf_wiki/run_models.py` — `reviewer_model` on request
- `src/okf_wiki/run_config.py` / `cli.py` — YAML + CLI wiring
- `src/okf_wiki/evaluation/wiki_evaluation_fixture.py` — fixture model handles Reviewer
- Tests: wiki_run, publication_gate, adaptive, config, cli, security, evaluation, package_release helpers
