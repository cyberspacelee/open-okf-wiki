# Use CodeMode for dynamic repository work

**Status: superseded.** The TypeScript/Mastra product path does **not** register Code Mode (`execute_typescript`) or an agent shell. Dynamic repository work uses discrete Host path-policy tools (`list_source`, `glob_source`, `search_source`, `read_source`, `write_wiki`) plus optional Mastra Domain/Leaf/Reviewer subagents (see [ADR 0020](0020-typescript-mastra-web-workspace.md)).

---

Historical decision (Pydantic AI era): The Agent receives Pydantic AI Harness `CodeMode` with `/source` and `/skill` read-only and `/wiki` staging read-write; when a run has multiple repositories, `/source` contains one directory per repository ID. Sandboxed model-authored code supplies loops, branches, batching, and aggregation over these mounts, so the product does not need a workflow DSL, a custom filesystem toolset, or host-Python Runtime Authoring.
