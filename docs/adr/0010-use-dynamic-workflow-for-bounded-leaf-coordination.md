# Use DynamicWorkflow for bounded leaf coordination

For large Repository Snapshot Sets, keep the Root Agent responsible for the global Semantic Workflow, Planning, page decisions, and final Wiki publication. Use Harness `DynamicWorkflow` only at a single coordination layer—normally a Domain Agent fanning out to homogeneous Leaf research tasks and reducing their typed receipts—while `SubAgents` provide the bounded recursive decomposition. This preserves Root judgment between branches and avoids relying on nested `DynamicWorkflow`, which Harness does not support.

The model decides whether a scope needs another semantic split; the Host enforces the non-negotiable maximum depth, fan-out, budgets, timeouts, and mount permissions.

**Consequences:** the workflow catalog and direct-call budget are local to that layer; child `SubAgents` remain separately bounded and observed. A future change may move the coordination layer only after evaluation shows that Root-level choreography, rather than leaf coordination, is the measured bottleneck.
