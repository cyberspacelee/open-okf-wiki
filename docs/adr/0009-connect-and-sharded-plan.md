# Connect slot and sharded Page Plan

Cross-source boundaries are N `connect:<source>` tasks (zero when only one
Git/files Source exists), not a single `synthesize:workspace` worker.
Connection is multi-participant with optional contract locators on a files
Source. Plan is sharded: `plan:<source>` plus `plan:workspace`. A CLI Compose
Gate unions shards, enforces global finding/connection coverage and spawns
writes. The kernel has no intra-phase dependencies, so connect completes
before any plan shard is dispatched.

Considered: merging connections into one `plan:wiki` worker; considered
running connect in parallel with `plan:<source>` and letting the CLI assign
connection ids. Rejected: the former inflates the largest decision artifact;
the latter cannot feed `plan:workspace` connection ids without intra-phase
deps. Per-source connect (not C(n,2) pair tasks) keeps fan-out linear.

Amends ADR 0005's "single synthesize pass".
