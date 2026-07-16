# 04 — Add the Python TUI Operator Surface

**What to build:** An explicit terminal UI lets an operator start a configured Wiki Run, observe adaptive progress, answer Needs Input, cancel safely, and launch a Manual Retry Run without changing the machine-readable CLI path.

**Blocked by:** 01 — Establish Observable Wiki Run and Receipt Infrastructure; 02 — Ship Bounded Adaptive Wiki Orchestration; 03 — Make Provider Failures and Manual Retry Recoverable

**Status:** ready-for-agent

- [ ] `okf-wiki tui --config <run-config>` starts Generate or Refresh through the same Wiki Run application seam and uses no second workflow implementation.
- [ ] The line-oriented UI uses prompt-toolkit and Rich, displays Run Plan, Root/Domain/Leaf states, bounded tool labels, receipt publication, compaction, provider retry countdowns, validation, no-op, and final publication status.
- [ ] Needs Input answers create a fresh run with explicit bounded answers; Manual Retry uses the Wiki Run Record and clearly differs from starting against newer branch revisions.
- [ ] Ctrl+C cancels the active run safely, leaves Published Wiki unchanged, and records cancellation; no partial staging is presented as published.
- [ ] TUI output is redacted and excludes prompts, source excerpts, raw provider bodies, credentials, and model chain-of-thought.
- [ ] Non-TTY invocation fails clearly without raw-mode setup; existing `wiki-run` JSON behavior and CI/pipe/cron usage remain unchanged.
- [ ] UI tests use deterministic event streams and pseudo-TTY input to verify rendering/state transitions, retry/manual-retry actions, Needs Input, cancellation, redaction, and non-TTY fallback without asserting terminal color escapes.
