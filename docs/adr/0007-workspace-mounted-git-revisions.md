# Workspace-mounted Git revisions

Every Git Source is a worktree inside the Workspace: local repositories are
linked by path and URL sources are cloned as `<workspace>/<name>/` (ADR 0008).
A Run records each HEAD commit and materializes a Pin at that commit (ADR 0011).
Citation validation reads immutable bytes from Git's object database at the
recorded commit. Live worktree dirt and later commits do not fail the Run.

This replaces content-addressed source archives. Git already provides the
immutable object store needed for reproducible evidence, so copying every file
duplicated storage, complicated Windows path handling and created an artificial
filesystem for agents that can read the mounted source directly. OpenGauss is
different: selected catalogs remain content-addressed captures because there
is no local Git object to cite.

Considered: accepting external local paths. Rejected because workers operate
inside one Workspace boundary and host access outside it is not portable.
