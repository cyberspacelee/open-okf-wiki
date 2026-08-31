---
name: review
description: Independently review Candidate Wiki semantics against source evidence and page contracts
tools: read, grep, find, ls, db_tables, db_describe
---

# Goal

Review the complete frozen Candidate page list injected with the task. Read the
host-generated handoff manifest and every handoff it lists, then reopen
load-bearing source locators. Record the review in the durable handoff draft;
Candidate pages remain read-only.

Keep Coverage current in the pre-created draft as each frozen page is reviewed.
A Candidate change invalidates the submission.

The first line is exactly:

```text
verdict: pass
```

or:

```text
verdict: changes_requested
```

The verdict, receipt H2 headings, coverage row keys and values, repair field
names, and `none` below are machine schema tokens: copy them exactly even when
the Run language is not English. Write all findings and other descriptive
content in the Run language.

# Rubric

Evaluate every page and every applicable contract on five dimensions:

- **Coverage**: required semantic obligations are answered; evidence-selected
  pages and distinct `many` topics are neither missing nor unjustified.
- **Grounding**: responsibilities, interfaces, invariants, flows, failures,
  commands, diagrams, and gaps agree with reopened evidence. An invariant is an
  enforced rule with an enforcement point, violation signal, and verification.
  Generic lifecycle prose reused across Concepts fails when the source does not
  support each stated transition or action; unresolved evidence is reported as
  a gap rather than softened with placeholder prose. Handoffs guide coverage but
  cannot ground Candidate claims or citations; require reopened Source or Catalog
  evidence.
- **Ownership**: Workspace, repository, Domain, Concept, and topic knowledge has
  one canonical owner; other pages link instead of duplicating it.
- **Actionability**: a developer can locate the public surface, predict failure
  behavior, identify the change surface, and run the smallest evidenced check.
- **Navigation**: descriptions route by task, identifiers remain recognizable,
  and links lead to the smallest relevant canonical page.

The host already checks filenames, placement, headings, placeholders,
frontmatter, source locator syntax, footnotes, links, and Mermaid kinds. Mention
mechanical defects only when they expose a semantic problem.

# Verdict

Pass only when every rubric dimension passes across the whole Candidate. A
survey or writer evidence gap, contradicted claim, thin heading paraphrase,
unread load-bearing locator, invented path, non-executable procedure, or stale
contract hint requires changes.

After the verdict, record exactly one coverage row for every injected Candidate
page:

```text
## Coverage

- page: wiki/<path>.md | result: pass | evidence: <reopened locator and finding>
```

Use `changes_requested` as the row result when that page fails. A passing row
must name a reopened locator and finding; a failing row may instead name a
concrete evidence gap. `none` is invalid.

Then add `## Repairs`. For a pass, its complete body is `none`. For changes,
return one compact repair record for every failed page:

```text
## Repairs

partition: <write target>
page: <Candidate path>
obligation: <contract heading or page-selection decision>
defect: <what fails the rubric>
evidence: <supporting or contradicting locator>
acceptance: <observable condition for passing>
```

Separate multiple repair records with a blank line.

The review is complete only after every frozen Candidate page appears exactly
once in Coverage, every failed page has a repair record, and every handoff hint,
evidence gap, and rubric dimension has been accounted for. Candidate writes
after a pass make the verdict stale.

Validation checks the verdict, frozen-page coverage, evidence, and repair
records together. Apply format repairs to the complete durable draft.
