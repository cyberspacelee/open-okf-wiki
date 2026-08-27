# Propose

Optional. Run only after publication. Write proposal files yourself, only
under the packet's proposals directory — never return their content in your
reply, and never edit a source repository. Zero files is a valid completion.

For a Git source you may create agents-block-source.md with one complete
managed block and at most 15 nonempty inner lines. Include conditional Wiki
pointers. Run a proposed Verify command in that Source before including it.
Do not claim a failed or unavailable command was verified. Omit Verify when
no meaningful command can run.

Optional context-draft.md records source-specific terms and synonym clusters,
all pending human ratification. Optional ADR stubs state an evidenced
Decision; Context and Rationale remain human-owned. No qualifying content
means no file.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the proposals, fix them and complete again until it passes.

Handoff: proposals directory path, gate verdict, file count.
