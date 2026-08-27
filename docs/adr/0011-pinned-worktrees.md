# Pin the recorded Revision; live HEAD may move

A Run records each Git Source's HEAD commit and materializes a detached
worktree Pin under `.okf-wiki/pins/<run>/<name>`. Workers and citation
resolution read the Pin / object database at that commit. The live Source
tree may receive new commits without failing the Run. `source refresh --name`
updates one Source's commit and Pin and invalidates only that Source's
tasks. Files Sources are pinned by copy.

Considered: failing the whole Run when any live HEAD moves; considered
following branch HEAD. Rejected: the first kills long multi-repo runs; the
second drops citation reproducibility. ADR 0006/0007 still freeze the
commit; they no longer freeze the live worktree.
