# Multi-source knowledge layer: evidence

Date: 2026-09-29. Input to [ADR 0028](../adr/0028-multi-source-layout-contracts-and-derived-navigation.md).
The question: how should a knowledge layer that spans several repositories be
laid out, express cross-repository collaboration, and support navigation and
change tracking?

## Sources and what they say

| Source | Practice | Consequence for repo-wiki |
|---|---|---|
| Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Agents keep lightweight identifiers and load data just in time; "folder hierarchies, naming conventions, and timestamps all provide important signals" | Directories must mean something; an index is a table of identifiers, pages load on demand |
| Anthropic, [Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | Three disclosure levels (metadata, body, linked files); "if certain contexts are mutually exclusive or rarely used together, keeping the paths separate will reduce the token usage" | Layered indexes; one repository's commands and rules apart from another's |
| [Claude Code memory](https://code.claude.com/docs/en/memory) | Nested CLAUDE.md files load only when files below them are read; keep one file under ~200 lines | `scope` plus `okf impact --files` is path-scoped loading; indexes get a line budget |
| Karpathy, [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | `index.md` catalogs every page with a one-line summary by category; `log.md` is append-only, greppable, and tells a new session what happened recently; periodic lint finds contradictions, stale claims and orphan pages | Keep a root index, add a log, add an orphan check |
| [Devin DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki) | Page hierarchy through `parent`; page caps (30, 80 enterprise); no cross-repository features | Hierarchy plus bounded size; cross-repository knowledge is unserved |
| [CodeWiki](https://arxiv.org/html/2510.24428v5) (ACL 2026) | Hierarchical decomposition from the dependency graph; leaves first, parents synthesized from children, then the repository overview; a global registry resolves cross-module references | Overview pages are assembled after the pages below them |
| Meta, [tribal knowledge engine](https://engineering.fb.com/2026/04/06/developer-tools/how-meta-used-ai-to-map-tribal-knowledge-in-large-scale-data-pipelines/) (via [Riftmap](https://riftmap.dev/blog/meta-tribal-knowledge-engine-build-the-graph-first/)) | 59 context files of 25–35 lines ("compass, not encyclopedia"); a cross-repo dependency index turns "what depends on X" from ~6000 to ~200 tokens; critic passes; periodic self-repair | Cross-repository relations as a lookup, not prose; short upper layers |
| Mabl repo coordination graph (via [Riftmap](https://riftmap.dev/blog/ai-coding-agents-need-cross-repo-context/)) | 79 repositories: dependency graph, Pub/Sub topic map, table ownership, release ordering; agents query it at planning time for which repositories to change and in which order; context-drift failures fell from ~40% to <5% | The contract, its owner and the change order are the core cross-repository knowledge |
| Riftmap | Parser-derived graphs "don't decay"; build the graph first because it constrains what the LLM may say | The kernel derives the contract graph; authored prose is checked against it |
| [Backstage catalog](https://backstage.io/docs/features/software-catalog/descriptor-format/) | `providesApis`, `consumesApis`, `dependsOn` | Provider/consumer vocabulary for contracts |
| [Codified Context](https://arxiv.org/abs/2602.20478) | Hot memory (always loaded constitution), specialist agents, cold memory (specs loaded on demand) | AGENTS.md pointer, then indexes, then pages |
| OKF v0.2 `refs/knowledge-catalog/okf/SPEC.md` §8–9 | `index.md` MAY appear in any directory (only the root one carries `okf_version`) and MAY link subdirectories; `log.md` is date-grouped, newest first, ISO dates | Per-directory indexes and a root log are in-spec |

## Findings about the current kernel

- Page paths are unconstrained (`_page._check_path` checks only syntax), so
  parallel writers in a hub invent inconsistent paths.
- `render_index` lists pages flat by type; same-named modules of two sources
  collide by title.
- One Conventions page must hold the commands of every source, whatever the
  language.
- Scan finds cross-source imports and names shared topics and tables, but not
  service contracts: `_code.triggers_in` drops the HTTP hits of a Feign
  interface and never matches a client call to the route it reaches, and topic
  sites carry no producer/consumer direction.
- Nothing checks that a cross-source relation is written down; the Kill Bill
  multi-repository QA ([notes](repo-wiki-killbill-multirepo-qa.md)) ended with
  no architecture or overview page at all.
- `log.md` is a reserved OKF name but `_page.is_page_path` treats it as a
  concept page.

## Rejected

- Embedding or RAG retrieval: structured just-in-time retrieval (index,
  scope, contracts) is preferred by Anthropic's guidance and sufficient at
  this size.
- A hand-appended log: it is a ledger, cannot be validated and conflicts on
  every merge.
- A fixed page cap: size budgets per layer plus the Structure stage's deletion
  rule bound the wiki instead.
