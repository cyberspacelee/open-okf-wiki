# 07 — Start and watch a deterministic Production Run

**What to build:** A user can start a Production Run from the Console and watch its recorded phases and events using deterministic fixtures, making the complete GUI lifecycle testable before a live model gateway is required.

**Blocked by:** 05 — Pull safely and resolve Source Revision Policies.

**Status:** ready-for-agent

- [ ] Run creation starts from the resolved Workspace configuration and exact Source Set shown during preflight.
- [ ] A deterministic fixture can drive a complete Run without live LLM credentials.
- [ ] The Runs page lists historical and active Runs with phase, timestamps, Source Set identity, and terminal outcome.
- [ ] Run detail shows Preparing, Exploring, Verifying, Rendering, Checking, Review Required, Publishing, Published, Failed, and Cancelled states as recorded.
- [ ] A phase stepper and event timeline update through bounded polling without requiring a streaming transport.
- [ ] Failures show actionable errors and preserve the last valid state rather than presenting indefinite loading.
- [ ] The UI displays typed task and state outcomes but never chain-of-thought, hidden reasoning, or simulated progress.
- [ ] Refreshing or reopening the browser reconstructs the same Run view from persisted state.
- [ ] CLI and HTTP creation/status paths produce equivalent authoritative state and state-transition errors.
- [ ] Browser and end-to-end tests cover creation, progress, reload, completion, failure, event ordering, exact Source inputs, and no-gateway operation.

