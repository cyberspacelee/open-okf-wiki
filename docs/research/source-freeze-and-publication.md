# Source freeze and publication research

## Question

How do comparable documentation and build systems avoid mutable-input races,
and how should a local publisher expose one current result across Windows and
POSIX platforms?

## Findings

Antora distinguishes worktree content from Git tree content and lets a build
exclude worktree changes. The important reproducibility boundary is the Git
revision, not a second copy of files: Git's object database already preserves
the exact blobs for a recorded commit.

Hosted documentation builders conventionally build a selected Git revision in
an isolated environment. Nix shows the stronger content-addressed alternative,
but applying it on top of Git duplicates an object store the project already
has. For a workspace-local agent harness, a clean mounted worktree plus a
recorded commit gives both direct source access and immutable citation bytes.

On Windows, MoveFileEx documents replacement for files, while populated
directory replacement has different restrictions and open handles commonly
cause sharing violations. The portable commit point is therefore a small JSON
file, not a populated directory or privileged symlink. Immutable generation
directories make rollback a pointer switch; wiki/ remains an explicit export.

## Decision influence

- Git sources are mounted inside the Workspace; URL sources clone there once.
- Formal Runs record clean HEAD and reject drift at every State Gate.
- Citation validation reads recorded Git objects, not mutable worktree bytes.
- Publication authority is generations plus current.json.
- Pointer replacement has bounded retry for transient Windows sharing errors.
- Export is recoverable but is not described as atomic.
- Paths are checked for Windows reserved names, illegal characters, trailing
  dots or spaces and case-fold collisions before a Run starts.

## Primary sources

- [Antora content source URLs and bypassing worktrees](https://docs.antora.org/antora/latest/playbook/content-source-url/)
- [Antora worktrees configuration](https://docs.antora.org/antora/latest/playbook/content-worktrees/)
- [Nix content-addressed store research](https://nixos.org/~eelco/pubs/secsharing-ase2005-final.pdf)
- [Microsoft MoveFileEx documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa)
