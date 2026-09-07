# Single-author Plan contract

Status: accepted. Supersedes the Plan authoring and compilation portions of
ADR 0025. The page evidence registry remains unchanged.

Plan Intent is the sole authored Plan Artifact. It contains semantic decisions
and Plan Analysis; the kernel compiles the Plan Ledger and renders the Plan
Narrative. This removes duplicated Gap IDs, citations and structural facts
without asking deterministic code to invent the planner's reasoning.

The agent interface exposes semantic ownership, logical table locators and
explicit evidence for judgments. The compiler derives reverse ownership,
Catalog references, scopes and complete Evidence Seeds. Collection budgets
belong to evidence consumption, not to loss of Plan facts. Compilation must
validate all derived units before returning success, and all independent
checks must report their execution state and actionable source locations.

This replaces the existing input contract without compatibility parsing or an
OKF version change. Old Run state is rejected using the Run contract identity.
The complete design and acceptance criteria are in
[the Plan contract design](../design/plan-contract.md).
