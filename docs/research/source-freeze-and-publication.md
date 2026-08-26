# Source freeze and publication research

## Question

How do comparable documentation and build systems avoid mutable-input races,
and how should a local publisher expose one current result across Windows and
POSIX platforms?

## Findings

Antora distinguishes local author mode, which may read a worktree, from Git
tree input; its official content-source documentation exposes worktrees:
false specifically to bypass mutable worktree content. That validates keeping
author convenience separate from formal reproducible generation.

Hosted documentation builders conventionally build a selected Git revision in
an isolated environment. Nix goes further: store identity derives from content
hashes. A Git archive plus per-file hashes captures the useful property here
without importing a build system.

On Windows, MoveFileEx documents replacement for files, while populated
directory replacement has different restrictions and open handles commonly
cause sharing violations. The portable commit point is therefore a small JSON
file, not a populated directory or privileged symlink. Immutable generation
directories make rollback a pointer switch; wiki/ remains an explicit export.

## Decision influence

- Formal runs reject dirty sources and snapshot HEAD.
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
