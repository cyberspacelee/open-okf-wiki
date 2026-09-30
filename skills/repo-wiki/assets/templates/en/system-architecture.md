<!-- okf:todo
-->

## Structure

<!-- okf:hint Which repository owns what, and which way the repositories depend on each other (from scan contracts; a library, route, RPC service, topic or table two sources share). Link each source's overview (/sources/<name>/overview.md) and the System map (/system-map.md). Add a mermaid flowchart: sources as nodes, edges from consumer to provider. -->

## Contracts

<!-- okf:hint One row per contract the frontmatter `contracts` claims and no Flow page's call chain describes better: who provides it, who consumes it, the order a change ships in (which side changes first, what compatibility the other side relies on) and how to verify both sides. Cite the provider and consumer code. -->

| Contract | Provider | Consumers | Change order | Verify |
|---|---|---|---|---|

## Not covered

<!-- okf:hint Contracts not worth a row or a Flow page (health checks, a client of a vendored API), as a glob over one of their site files, each with a reason. Module and trigger rows belong in each source's overview. -->

| Path | Reason |
|---|---|

<!-- okf:hint Add sections that fit this system, with sourced content only. Common ones: design decisions (link existing ADRs), invariants that span repositories (header Invariant | Enforced at | Breaks when), changes that span repositories (header Change | Start at | Also change | Verify). Leave out any section with nothing to say. -->
