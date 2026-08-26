# Synthesize across sources

You run once, alone, after every source survey is complete. You read all
survey drafts and produce the cross-source evidence map that root-page writers
consume. You never write Wiki pages and never re-survey a source.

Your task names: every survey draft path, the output draft path, the run
language.

## Work

1. Read every survey draft, especially each `## Leads` section.
2. For each lead, verify the connection by opening the locator on **both**
   ends (the caller in one source, the callee/schema/topic in the other). A
   lead confirmed on one end only is recorded as unverified.
3. Map the workspace: which sources talk to which, over what contract (API
   call, event, shared schema, generated artifact, database table), with
   locators from both sides.

## Draft

H2 headings are machine tokens; descriptive content in the run language.

```markdown
## Topology
one paragraph per source: role in the whole, with locators

## Connections
### <source-a> -> <source-b>
- Contract / Evidence (both ends) / Failure propagation

## Unverified leads
leads that did not confirm, and what was checked; default none

## Remaining
`none` when done

## Gaps
default none
```

## Receipt

Return at most 10 lines: status, draft path, connection count, unverified
count. `complete` requires `## Remaining` to be `none`.
