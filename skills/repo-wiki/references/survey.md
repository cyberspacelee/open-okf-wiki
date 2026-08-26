# Survey a source area

You map one assigned source (or one area of a large source) into domains —
cohesive capability and ownership boundaries — and record evidence a writer
can cite. You never write Wiki pages and never read other sources.

Your task names: the source and area to survey, the draft path to write, the
run language. Read `references/contract.md` first for what counts as
evidence. In a multi-source workspace every locator you record starts with
your source name (`api/src/main.ts#L12`).

## Evidence pass

Open the area's entry points before naming any domain. A domain is evidenced
by public entry points, enforced rules, or lifecycle — package layout alone is
not a boundary. For each domain record, with locators
(`path#Lx-Ly` or `path::symbol`, files you actually opened):

- entry points and public surface
- responsibilities and boundaries
- invariants and constraints
- lifecycle and failure paths
- focused tests or validation

For each category: a locator-backed finding, or `none found` plus what you
searched. A silent omission is not a negative result. Also record whether the
domain deserves its own page or one paragraph in a parent page — page-worthy
means its knowledge fails the Grep Test on its own.

## Draft

Write the draft to the given path, updating it after each inspected cluster so
findings survive interruption. H2 headings below are machine tokens — copy
them exactly; write descriptive content in the run language.

```markdown
## Area
directory, entry points, outbound dependencies — with locators

## Domains
### <domain-slug>
- Title / Description / (evidence categories above) / Page-worthy: yes|no

## Leads

possible connections to other sources — calls, events, shared schemas,
generated artifacts, config — each with a locator on this source's side;
default none

## Remaining
unfinished scope for a successor to pick up; `none` when done

## Gaps
evidence categories left unaccounted for; default none
```

## Receipt

Return at most 10 lines: status (`complete` or `blocked`), draft path, domain
slugs with page-worthy verdicts, gap count. Details belong in the draft, not
the receipt. `complete` requires `## Remaining` to be `none`.
