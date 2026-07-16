**Status:** superseded by ADR-0014

# Let one PydanticAI Agent own the semantic loop

A single `Agent.run()` owns exploration, planning, tool use, page selection, generation, review, and stopping according to the Producer Skill. Python does not recreate this loop as Scheduler, Planner, Worker, Verifier, or Renderer roles or as a `pydantic-graph`; official `SubAgents` are added only after evaluation shows a repeatable specialist need, and `DynamicWorkflow` only when coordinating those specialists is itself the bottleneck.
