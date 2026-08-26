# Derive

Write proposals only to the target run proposals directory. Never edit a
source repository.

For each Git source create agents-block-source.md with one complete managed
block and at most 15 nonempty inner lines. Include conditional Wiki pointers.
Before including a Verify command, run it through:

    uv run <skill>/scripts/okf.py receipt run --source <source> -- <argv...>

Reference the successful id on the command line as '(receipt: id)'. Do not
claim a failed or unavailable command was verified. A proposal may omit
Verify when no meaningful command can run.

Optional context-draft.md records source-specific terms and synonym clusters,
all pending human ratification. Optional ADR stubs state an evidenced
Decision; Context and Rationale remain human-owned. No qualifying content
means no optional file.
