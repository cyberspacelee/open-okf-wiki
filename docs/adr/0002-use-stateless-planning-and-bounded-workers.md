# Use stateless planning and bounded workers

The Producer uses a deterministic Scheduler, short-lived Planner Agent calls, and single-level Worker Agents instead of a persistent Orchestrator Agent. Durable run state and full artifacts live outside model context; planners receive bounded summaries, workers receive explicit scope and budget, and accepted results return to the Deterministic Control Plane so context growth cannot become the system's memory model.
