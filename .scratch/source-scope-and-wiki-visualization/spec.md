# Source Scope and Wiki Visualization

Status: ready-for-agent

Extends: Repository Wiki Producer; Adaptive Repository Wiki Runs

Related ADRs: 0015 (Default Source Ignores with explicit disable); 0016 (run operator UI separate from Wiki Visualization)

## Problem Statement

Wiki Runs still materialize every tracked blob under a pinned revision except explicit per-repository `ignore` globs. Large repositories therefore pull dependency trees, build outputs, and other non-evidence paths into the Repository Snapshot, burning source file and byte quotas and wasting exploration budget. Operators cannot rely on product-default noise exclusion, and when they do add ignores they have no frozen **Effective Source Ignores** that Manual Retry and publication provenance can reproduce after product defaults evolve.

Exploration remains slow and undisciplined: there is no Host-owned inventory of what survived materialization, Agents have no supported fast search short of sandboxed Python walks, and any temptation to open host shell or ripgrep would violate the untrusted-repository boundary.

Operators and readers also cannot browse a finished Published Wiki as HTML with a simple link graph. The line-oriented TUI observes runs only; turning it into a product web app would confuse run operation with Wiki reading and expand the stack beyond the CLI-native product. Open Knowledge–style live backlink services and Google OKF bundle conformance are adjacent products, not this one, but the lack of any optional static visualization leaves a clear gap after publication.

Finally, Host safety text and the Producer Skill risk being mixed: ignore catalogs, budgets, and mounts must stay non-forkable Host policy, while investigation method and page craft stay versioned Skill content.

## Solution

Keep `WikiRunApplication.run(request) -> WikiRunResult` as the sole Wiki Run application seam. Before materializing each Repository Snapshot, compute **Effective Source Ignores** as the union of product **Default Source Ignores** (when enabled for that repository) and that repository’s configured ignore patterns. Apply the effective set with existing `fnmatch` semantics on tracked repository-relative paths. Persist the per-repository enable flag and the **expanded** effective pattern list in the Wiki Run Record and publication metadata so Manual Retry reuses the frozen list and does not re-resolve a later product default catalog.

Default Source Ignores are Host-owned platform policy (noise such as dependency and build trees). They are on by default, additive with user `ignore`, and disabled only by an explicit per-repository switch. There is no re-include/`!` negation and no gitignore import in this work. Tests remain in the Snapshot by default.

Optionally produce a deterministic Host-owned source inventory over the materialized Snapshot for Agent discovery. Inventory is an accelerator only: Agents may still inspect any path that is in the Snapshot, and Source Citations remain validated against the Snapshot, not against inventory membership.

Do not add host shell or ripgrep. If a bounded content search tool is added, it is read-only over the materialization mounts (or equivalent FileSystem-style search) and respects Snapshot membership.

Keep Host Instructions short and non-forkable: mounts, trust boundaries, Skill activation, role limits. Keep Default Source Ignores out of the Producer Skill. Update the Skill only with operational discipline (filtered Snapshot, inventory as accelerator, tests as behavioral evidence, no shell search).

Add optional **Wiki Visualization**: a deterministic, read-only static HTML presentation of a Published Wiki, including a link graph derived from page cross-links, generated beside or from the publication without embedding raw HTML into Wiki pages. Keep `wiki-run` JSON and the optional TUI as the run operator surface; do not replace the TUI with a product SPA or live run dashboard.

## User Stories

1. As a repository owner, I want dependency and build output trees excluded from the Repository Snapshot by default, so that source quotas and investigation focus on real evidence.
2. As a repository owner, I want Default Source Ignores applied without editing YAML for every repository, so that common noise does not require ritual configuration.
3. As a repository owner, I want my configured `ignore` patterns always applied on top of defaults, so that adding one custom pattern never silently disables product noise exclusion.
4. As a repository owner, I want to disable Default Source Ignores for one repository when tracked vendor or dist trees are load-bearing evidence, so that I can still ground citations in those paths.
5. As a repository owner, I want disabling defaults to force me to list the exclusions I still want, so that “include noise” is an explicit full-control choice rather than a hidden re-include language.
6. As a repository owner, I want no gitignore semantics in this release, so that Snapshot membership stays explainable from product defaults plus my globs.
7. As a repository owner, I want test paths kept in the Snapshot by default, so that intended behavior encoded in tests remains citable evidence.
8. As a repository owner, I want Effective Source Ignores frozen at run start, so that the same YAML later does not silently change membership when product defaults change.
9. As an operator, I want the Wiki Run Record to store the per-repository default-ignore switch and expanded effective patterns, so that audit and Manual Retry are reproducible.
10. As an operator, I want publication metadata to record the same effective ignore information that affected the Snapshot, so that Published Wiki provenance matches what the Agent saw.
11. As an operator, I want Manual Retry to reuse frozen Effective Source Ignores rather than today’s product default catalog, so that retry analyzes the same Snapshot membership.
12. As an operator, I want a clear failure when frozen ignore provenance cannot be applied, so that the system never substitutes a different filter set.
13. As an operator, I want multi-repository runs to configure the default-ignore switch per repository, so that one noisy monorepo does not dictate another repository’s evidence surface.
14. As a security-conscious user, I want ignore policy owned by the Host, so that a Skill Fork cannot weaken Snapshot filtering.
15. As a security-conscious user, I want Host Instructions to keep stating untrusted-source and mount rules, so that safety cannot be forked away with the Skill.
16. As a product maintainer, I want Default Source Ignores versioned with the product release while their expansion is frozen per run, so that defaults can improve without breaking historical retries.
17. As a Root Agent, I want `/source` to already reflect the filtered Snapshot, so that I do not invent a second exclusion policy in CodeMode.
18. As a Domain or Leaf Agent, I want the same filtered Snapshot membership as Root, so that child research cannot “see” paths the Host excluded.
19. As a research Agent, I want optional inventory of top-level layout and path samples after materialization, so that large trees can be scoped without blind root globs.
20. As a research Agent, I want inventory treated as a hint only, so that a missing inventory entry never blocks a valid Source Citation inside the Snapshot.
21. As a research Agent, I want any Host search capability limited to Snapshot paths, so that search cannot escape materialization or reintroduce ignored noise.
22. As a research Agent, I want no host shell and no ripgrep binary, so that repository content cannot gain an execution channel.
23. As a Producer Skill author, I want Skill text to describe investigation and page craft only, so that method changes stay digest-versioned without owning platform filters.
24. As a Skill Fork user, I want to change writing and research guidance without changing Default Source Ignores, so that forks remain safe customizations.
25. As a reader, I want published pages to keep requiring Source Citations into the frozen Snapshot, so that better filtering does not weaken grounding.
26. As a reader, I want optional HTML visualization of a Published Wiki, so that I can browse pages without a separate knowledge app.
27. As a reader, I want a link-graph view derived from wiki cross-links, so that navigation structure is visible at a glance.
28. As a reader, I want clicking a graph node or index entry to show the corresponding page content, so that the visualization is useful, not decorative.
29. As a reader, I want Mermaid fences rendered in the visualization layer when present, so that architecture and flow diagrams are viewable in the browser.
30. As a reader, I want Wiki Visualization to leave the Markdown Wiki itself unchanged, so that git-diffable portable pages remain the source of truth.
31. As a security-conscious user, I want Wiki pages to continue forbidding raw HTML at publication validation, so that visualization cannot push unsafe markup into the Wiki tree.
32. As an operator, I want Wiki Visualization generation to be deterministic and free of model calls, so that the same Published Wiki always yields the same view for the same generator version.
33. As an operator, I want visualization generation failure not to roll back a successful publication, so that optional browsing never endangers the Published Wiki.
34. As an operator, I want an explicit way to generate or regenerate visualization for an existing publication, so that I can visualize wikis produced before this feature.
35. As a CLI user, I want `wiki-run` JSON output to remain stable for CI, so that scripts do not depend on HTML artifacts.
36. As a terminal user, I want the existing TUI to remain the interactive run operator surface, so that run status is not moved into a browser SPA.
37. As a terminal user, I want successful runs to report where visualization was written when generated, so that I can open it without hunting paths.
38. As a product maintainer, I want run operator UI and Wiki Visualization kept as separate presentation concerns, so that neither becomes a second workflow engine.
39. As a product maintainer, I want no product web server requirement for v1 visualization, so that a static `file://` or simple static host remains enough.
40. As a product maintainer, I want no knowledge-graph database or entity triple store, so that “graph” means page cross-links only.
41. As a product maintainer, I want no OKF v0.1 conformance claim for the Published Wiki, so that frontmatter and index rules stay repository-wiki contracts.
42. As a consumer of docs, I want product language to distinguish Host Instructions, Producer Skill, Effective Source Ignores, and Wiki Visualization, so that contributors do not merge those responsibilities.
43. As an evaluator, I want fixtures that include noise paths and test paths, so that default exclusion and test retention are both proven.
44. As an evaluator, I want publication provenance changes when effective ignores change even if page text is identical, so that `publication_changed` remains honest.
45. As an operator, I want Refresh runs to use Effective Source Ignores for the new Snapshot Set, so that refresh does not reintroduce noise the generate path would drop.
46. As a repository owner, I want YAML configuration to express the per-repository default-ignore switch beside existing `ignore` lists, so that run configs stay the single non-secret input document.
47. As a repository owner, I want direct CLI single-repository runs to receive the same default-ignore behavior as YAML runs, so that the short path is not a weaker filter.
48. As a security-conscious user, I want receipt evidence and Source Citations to hash only materialized bytes, so that excluded paths cannot appear as validated evidence.
49. As a product maintainer, I want Host search and inventory (if present) to share Snapshot path containment rules with citation validation, so that discovery and grounding agree.
50. As a Root Agent, I want Skill guidance that inventory is optional acceleration, so that I do not treat Host inventory as a second membership gate.
51. As a reader, I want broken internal links in visualization to be visible rather than silently invented, so that the graph reflects the published tree.
52. As an operator, I want visualization to tolerate only the Published Wiki’s validated page set as nodes, so that temporary files and non-markdown artifacts are not graph nodes.
53. As a product maintainer, I want live backlink APIs, collaborative editors, and SPA run dashboards out of this effort, so that delivery stays a thin Host extension.
54. As a product maintainer, I want DynamicWorkflow defaults and recursive topology left unchanged by this effort, so that source-scope work does not reopen orchestration topology.
55. As an operator, I want Needs Input and Manual Retry flows unchanged except for frozen effective ignores in retry inputs, so that recovery behavior stays familiar.

## Implementation Decisions

- This specification extends the existing Repository Wiki Producer and Adaptive Repository Wiki Runs. Snapshot freezing, untrusted-source policy, Producer Skill digests, CodeMode mounts, adaptive orchestration, validation, staging, and atomic publication remain authoritative unless this document explicitly changes them.
- The primary application seam remains `WikiRunApplication.run(request) -> WikiRunResult`. CLI, TUI, CI, and tests continue to use that operation for Wiki Runs.
- Wiki Visualization may use a second narrow Host operation that reads an existing Published Wiki (or a successful run’s publication path) and writes visualization artifacts; it must not open a second semantic Agent loop.
- Effective Source Ignores for each repository are computed once at materialization time as: if default source ignores are enabled for that repository, the product Default Source Ignores catalog union the repository’s configured ignore patterns; otherwise only the configured ignore patterns.
- User `ignore` is always additive. Presence of a non-empty user ignore list never disables defaults.
- The configuration name for the per-repository switch is `apply_default_source_ignores`, defaulting to true when omitted.
- There is no `!` re-include syntax and no parsing of repository `.gitignore` / `.okignore` in this effort.
- Default Source Ignores are Host-owned. The first catalog includes at least: `node_modules/**`, `.venv/**`, `venv/**`, `env/**`, `__pycache__/**`, `dist/**`, `build/**`, `coverage/**`, `.git/**`, `.next/**`, `.turbo/**`, `.cache/**`, and common package-manager/build-cache directory patterns already used as noise in comparable tools. Exact catalog literals live in product code and may grow in later releases; runs freeze the expansion they used.
- Tests are not part of Default Source Ignores.
- Pattern matching remains repository-relative POSIX `fnmatch` against tracked paths from the pinned commit tree, consistent with current materialization.
- Wiki Run Record and `.okf-wiki.json` (or equivalent publication metadata) store per repository: id, revision, `apply_default_source_ignores`, user `ignore`, and expanded `effective_ignore` (or equivalently named) pattern list. Manual Retry rebuilds Snapshot membership from the frozen effective list (and the stored switch for audit), not by reloading the live product default catalog.
- Provenance comparison treats a change in effective ignore membership as a publication provenance change even when page bytes are unchanged.
- Optional source inventory is Host-generated after successful materialization into a run-local readable location available to Agents (for example under Analysis Workspace or an agreed read-only mount). It summarizes path layout and counts; it is not a second ignore engine.
- Inventory non-membership must not cause citation validation failure for paths that exist in the Snapshot.
- No `os_access` host shell and no bundled ripgrep execution channel. Any search addition is read-only over Snapshot mounts with result caps and path containment.
- Host Instructions remain the short non-forkable shell: activate Producer Skill, mount and trust rules, role limits. They do not absorb the full Semantic Workflow.
- Producer Skill may gain brief discipline lines about filtered Snapshots, inventory-as-accelerator, tests-as-evidence, and no shell search; it must not define the Default Source Ignores catalog.
- Wiki Visualization inputs are the Published Wiki markdown tree (and publication metadata as needed). Outputs are static artifacts (HTML and optional graph JSON) written outside the semantic page set or under a reserved visualization directory that publication validation does not treat as Wiki pages requiring Source Citations.
- Visualization link graph nodes are published markdown pages; edges are internal markdown links that resolve under the same rules the validator uses for internal links. External URLs are not graph edges. Source Citations are not graph edges unless they are also ordinary internal page links.
- Visualization is deterministic for a given generator version and Published Wiki content digest. It does not call the model provider.
- Optional generation may run after successful publication when configured, or via an explicit CLI command against an existing publication path. Failure is reported without unpublishing.
- The TUI remains line-oriented run observation and is not replaced by a browser run dashboard in this effort.
- Product positioning remains Repository Wiki, not OKF Knowledge Bundle conformance: required page frontmatter stays `title`; root `index.md` remains a required narrative entry page; Source Citations remain repo path line ranges.
- Adaptive topology, DynamicWorkflow opt-in defaults, provider retry, and Manual Retry mechanics are unchanged except for carrying frozen effective ignores in retry inputs.

## Testing Decisions

- Prefer the highest existing seam: the Wiki Run application operation. Given fixed repositories (including tracked noise paths and tests), Skill, model fixtures, limits, and ignore configuration, assert materialized Snapshot membership, terminal result, run record fields, publication metadata, and citation validation behavior.
- Good tests assert external behavior: which paths exist under the materialization mount, whether a citation to an excluded path fails, whether defaults+user ignore union holds, whether disabling defaults reintroduces noise, whether Manual Retry reuses frozen effective patterns, whether `wiki-run` JSON shape stays stable. They do not assert model reasoning, exact tool order, or incidental filesystem walk counts.
- For inventory (if implemented), assert that inventory absence of a Snapshot path does not block a valid citation, and that inventory generation failure either fails closed before model work or is explicitly non-fatal per the chosen implementation—pick one and test it; recommended: inventory failure is non-fatal and does not change Snapshot membership.
- For Wiki Visualization, use a narrow Host seam: given a fixture Published Wiki tree, generate visualization and assert nodes/edges for internal links, absence of model calls, no mutation of wiki page bytes, and that generation failure does not delete publication. Prefer filesystem and CLI-level assertions over browser automation in unit tests; optional smoke that HTML files exist and graph JSON parses.
- Prior art: existing Wiki Run tests for ignore filtering, materialization limits, publication metadata, refresh provenance, Manual Retry frozen inputs, CLI entry points, and package release checks. Documentation link gates remain for product docs.
- Do not require live provider tests for ignore, inventory, or visualization correctness.

### Behavioral seams (test at these boundaries)

1. **Wiki Run application / materialization** — Effective Source Ignores, Snapshot membership, provenance, Manual Retry freeze.
2. **Same application seam for optional inventory** — accelerator only; citation authority remains Snapshot.
3. **Wiki Visualization generator** — deterministic HTML/link graph from Published Wiki; non-destructive.
4. **CLI contracts** — `wiki-run` JSON unchanged; TUI unchanged in role; viz optional and non-rollback.

## Out of Scope

- OKF v0.1 conformance export (`type`-required concepts, OKF index shape, log.md mandate, soft broken-link consumption as the publication gate).
- Knowledge graph databases, entity extraction, or OKF-style interactive catalog viz as a product runtime.
- Replacing the TUI with a web SPA or live browser run dashboard.
- Open Knowledge–style live backlink index service, collaborative editor, or MCP knowledge server.
- Host shell execution, ripgrep binary, or repository script execution for search.
- gitignore / `.okignore` import or `!` re-include semantics.
- Default exclusion of tests or a test ignore profile.
- Runtime authoring of Host capabilities; mid-run Skill mutation.
- Changing recursive SubAgent topology, making DynamicWorkflow default-on, or durable Agent tree resume.
- Embedding raw HTML into published Wiki pages.
- Multi-tenant hosted visualization service, authentication UI, or cloud deployment console.

## Further Notes

- Domain vocabulary for this work lives in root `CONTEXT.md`: Default Source Ignores, Effective Source Ignores, Host Instructions, Producer Skill, Wiki Visualization, and existing Wiki Run terms.
- ADR-0015 and ADR-0016 record the hard-to-reverse presentation and ignore-policy choices; this spec is the implementable PRD for the delta.
- OpenWiki is a reference for run-oriented CLI/TUI, not for HTML viz. Open Knowledge is a reference for link-graph *consumption* services, not for this product’s generation core. Google OKF SPEC is a related markdown knowledge format, not the publication contract of this repository wiki.
- Suggested implementation order: (1) Effective Source Ignores + provenance + tests, (2) Skill/Host Instructions copy alignment, (3) optional inventory, (4) Wiki Visualization CLI/generator, (5) optional post-publish hook and TUI path reporting.
