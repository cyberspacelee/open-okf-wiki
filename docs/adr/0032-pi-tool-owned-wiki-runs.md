# Let a real Pi tool own each Wiki Run

**Status:** accepted  
**Date:** 2026-07-24  
**Refines:** ADR 0030 and ADR 0031  
**Supersedes:** ADR 0030's WikiRunShell clauses, ADR 0031's product-inject stream, and the session side-metadata design

The Agent Workspace is the only operator interface. An Operator Agent starts a Wiki Run by calling the real Pi custom tool `wiki_produce`; that single tool execution owns planning, production, review, and the plan/publication waits. Pi therefore writes the tool lifecycle to its own Session, while the Run Boundary owns immutable inputs, Staging, validation, publication, and a required `okf.wiki-run/v2` Run Record. In-process plan/domain/leaf/reviewer children stay off the Operator Session transcript; progressive disclosure of their text and tool calls is allowed only as structured fields on the parent `wiki_produce` tool result (`details.children`).

`SessionManager` is the sole Session authority. Server-sent events begin with a current server snapshot, then forward only genuine Pi events and heartbeat frames; there is no product event injection, sequence/replay protocol, ring buffer, session metadata file, or reconstructed tool lifecycle. Deleting a Session deletes its associated Run work data, but retains the Published Wiki, Workspace, source checkout, and Skill Fork.

Repository Snapshots are materialized from exact Git revisions into run-owned ordinary file trees. Effective Source Ignores are removed during materialization, Git symlinks remain inert text, and the copied Producer Skill digest is verified before execution. Old Session metadata, cwd JSONL files, and pre-v2 Run Records are ignored without migration or automatic deletion.

The retained product packages are `contract`, `core`, `agent`, `server`, `web`, and `skill`. The CLI, desktop placeholder, mutable Run HTTP routes, independent Run page, WikiRunShell, and compatibility adapters are removed because each duplicated an existing product interface or authority.
