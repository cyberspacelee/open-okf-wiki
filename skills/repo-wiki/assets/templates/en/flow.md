<!-- okf:todo
-->

## Call chain

<!-- okf:hint From the trigger to the outcome across repositories: one row per hop, naming the repository, the entry point and the contract that carries the call to the next hop (- for a hop inside one repository). Stop each hop at its entry and link the source's workflow or module page that explains the inside. Add a mermaid sequenceDiagram with the repositories as participants; back every arrow with a cited row. -->

| Step | Source | Entry | Contract | Next |
|---|---|---|---|---|

## Making changes

<!-- okf:hint List in the table the changes this flow really gets across repositories (take them from git log of both sides): where to start, what else must change in the other repository, which tests on each side verify it. -->

| Change | Start at | Also change | Verify |
|---|---|---|---|

<!-- okf:hint Add sections that fit this flow, with sourced content only. Common ones: consistency across repositories (header Invariant | Enforced at | Breaks when), timeouts, retries, idempotency and compensation across the boundary, where to look when it breaks. Leave out any section with nothing to say. -->
