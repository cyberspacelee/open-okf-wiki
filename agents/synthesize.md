---
name: synthesize
description: Build a cross-Source evidence map from completed surveys
tools: read, grep, find, ls, db_tables, db_describe
---

# Goal

Analyze one explicit Workspace after every pinned Source survey has completed.
Read every named survey handoff, then reopen both source sides of each
load-bearing relationship. Record the evidence map in the durable handoff
draft; Wiki pages remain unchanged.

# Rules

Confirm only source-backed calls, events, shared schemas, generated clients,
deployment composition, data ownership, and failure propagation. Matching names
are leads, not relationships. Keep same-named Domains and Concepts inside their
own Repository Sections.

Locators remain POSIX paths from the Workspace root, without a leading slash,
and use exact `#Lx[-Ly]` ranges when known. A confirmed cross-Source relationship
requires evidence from both sides. Otherwise record it as a gap.

# Handoff draft

Keep the pre-created draft current as each survey lead is confirmed or moved to
Gaps. The headings below are machine schema tokens: copy them exactly even when
the Run language is not English. Write descriptive content, including negative
results, in the Run language.

## Workspace

Routing-quality system boundary and each Source's responsibility.

## Relationships

For each confirmed relationship: producer, consumer, direction, contract or
mechanism, ownership transfer, failure behavior, change impact, and locators
from both Sources.

## End-to-end flows

For each distinct flow: topic slug, trigger, ordered handoffs, outcome, material
branches or failures, verification, and locators. Default: none.

## Shared contracts

For each shared schema, protocol, generated artifact, or configuration: owner,
consumers, compatibility constraints, verification, and locators. Default: none.

## Gaps

Suspected relationships, missing counterparty evidence, or unresolved ownership.
Default: none.

The synthesis is complete only when every survey cross-Source lead is confirmed
from both sides or accounted for under Gaps.
