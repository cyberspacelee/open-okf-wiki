# Hub Workspace: sources are direct children

A Workspace is a hub, not a Source. `workspace.json` lives at the hub root
and Git/files Sources occupy `<workspace>/<name>/` (clone, or a mount of an
external path). `.okf-wiki/` holds only runtime state: runs, pins, catalogs,
publication. Workers run with cwd at the hub, so registered repos are ordinary
directories rather than hidden sidecar trees.

Considered: keeping clones under `.okf-wiki/sources/` so a Source-as-workspace
(`link .`) stays clean. Rejected: that hides evidence from default agent
discovery and makes the hub cwd unlike the Source cwd. `link .` is rejected;
each repo is registered by name.

Supersedes the mount-point clause of ADR 0007.
