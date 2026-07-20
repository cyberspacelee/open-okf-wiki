# Keep Python as a thin harness

**Status:** superseded  
**Date:** (historical)  
**Superseded by:** [ADR 0020](0020-typescript-mastra-web-workspace.md) (partial — TypeScript product surface), then fully by [ADR 0021](0021-retire-python-primary-path.md) (Python primary path removed).

## Historical decision (do not implement)

Python owns only non-negotiable execution boundaries: Repository Snapshot Set and Producer Skill freezing, mount permissions, model and provider credentials, official usage limits and retries, a typed terminal result, mechanical output validation, staging, and atomic publication. Semantic workflow and Wiki composition stay out of Python; the harness does not implement its own scheduler, retry engine, context compactor, subagent dispatcher, filesystem layer, or durability system when PydanticAI or Pydantic AI Harness already provides one.

## Current reading

Those **Run Boundary** duties live in TypeScript `@okf-wiki/core` ([ADR 0020](0020-typescript-mastra-web-workspace.md) §3, [ADR 0019](0019-prefer-run-boundary-over-host.md)). Semantic Workflow is Mastra in `@okf-wiki/agent` ([ADR 0025](0025-mastra-wiki-workflow-and-ai-sdk-bridge.md)). Do not revive a Python product harness.
