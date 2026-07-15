# Use CodeMode for dynamic repository work

The Agent receives Pydantic AI Harness `CodeMode` with `/source` and `/skill` read-only and `/wiki` staging read-write. Sandboxed model-authored code supplies loops, branches, batching, and aggregation over these mounts, so the product does not need a workflow DSL, a custom filesystem toolset, or host-Python Runtime Authoring.
