# Use Planning and bounded recursive SubAgents for large scopes

For a Wiki Run whose source scope can exceed one model context, keep the Root Agent responsible for the global Run Plan, page decisions, synthesis, review, and publication, and let it delegate bounded research to Harness `SubAgents`. The default topology is an acyclic `Root → Domain → Leaf` tree: the model may choose whether a scope needs another semantic split, while the Host enforces maximum depth, fan-out, concurrency, budgets, timeouts, and mount permissions. Each research branch returns a bounded evidence receipt through the run-local Analysis Workspace; Root remains the only writer of the Staging Wiki.

Small scopes may remain single-agent. A single Domain→Leaf homogeneous fan-out/reduce may use `DynamicWorkflow`, but it is not the recursive backbone. This supersedes the earlier decision to defer SubAgents until a specialist bottleneck is observed; the scale-driven context boundary is already present.
