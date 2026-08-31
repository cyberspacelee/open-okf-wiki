# Repo Wiki simplification: comparative implementation analysis

Date: 2026-08-29

## Executive conclusion

The current `repo-wiki` is no longer merely a skill with a deterministic
kernel. It is a workflow engine whose protocol is exposed to the executing
agent: the agent must carry a Run session, Target ID, random Attempt token,
Attempt-specific Artifact, separate checkpoint, reviewer session, dependency
graph and reopen graph. Comparable agent systems keep most of that identity in
the host runtime. Their skills describe the work, inputs, outputs and quality
checks; they do not ask the model to administer the scheduler.

The right simplification is not to copy a low-assurance one-shot wiki
generator. Keep the parts that create OKF's value: frozen revisions, compact
deterministic Index, bounded evidence access, locator validation, composition
before physical path binding, link validation, review and atomic Publication.
Remove the orchestration machinery that does not improve those guarantees.

Recommended lifecycle:

```text
Capture + Index (kernel)
  -> Plan (one long-lived planner, parallel evidence workers when useful)
  -> Plan review (independent agent)
  -> Compose (research as needed, then page map)
  -> Composition review (independent agent; optional for a one-page Wiki)
  -> Write pages (parallel workers)
  -> Wiki review (one bundle gate, parallel critics optional)
  -> Validate + bind + publish (kernel)
```

The coordinator should run one explicit loop: read status, execute the exact
next actions, dispatch independent work, merge handoffs, repeat. It should not
construct commands or invent IDs.

## What comparable systems actually do

| System | Orchestration and parallelism | Identity and recovery | Artifacts and gates |
|---|---|---|---|
| GitHub Copilot | A skill is a `SKILL.md` plus optional resources. Custom agents are lightweight named prompt/tool configurations; the runtime matches intent, runs a sub-agent in isolation and integrates its result. Parallel work belongs to Fleet/runtime orchestration. | Agent authors provide a stable agent name. Runtime events carry `toolCallId` and `agentId`; these are telemetry, not values that a skill asks the worker to invent or echo through every command. | Skills provide procedure. Runtime lifecycle events and the surrounding PR workflow provide execution and review boundaries. [Agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), [custom agents and delegation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents) |
| Claude Code | Subagents have isolated contexts and return a summary. Official guidance recommends parallel subagents for independent investigations and the main conversation when phases share substantial context. | Claude Code creates the agent ID. The parent can resume the agent by ID/name; transcripts survive main-context compaction. No per-Attempt checkpoint protocol is placed in the skill. | Skills are prompt-based procedures and should stay concise. Host transcripts, optional persistent memory and normal repository files carry durable state. [Subagents](https://code.claude.com/docs/en/sub-agents), [skills](https://code.claude.com/docs/en/skills) |
| OpenAI Codex | Skills package one reusable workflow and use progressive disclosure. OpenAI recommends keeping a skill focused on one job and preferring instructions unless deterministic behavior or external tooling requires a script. | AGENTS guidance is assembled once per run by the host. For multi-hour work, the official ExecPlan pattern uses one self-contained living Markdown document that is revised in place and is sufficient to restart the work. | OpenAI's agent-first workflow uses standard tools plus iterative agent reviews. Repository Markdown is the system of record; linters enforce structural invariants. [Build skills](https://learn.chatgpt.com/docs/build-skills), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [ExecPlans](https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md), [harness engineering](https://openai.com/index/harness-engineering/) |
| DeepWiki-Open | A task deterministically moves through Index, one LLM structure call, bounded parallel page generation, save and complete. Page retries are an integer loop inside the service. | The task has one internal ID and pages have IDs. Workers do not receive Run sessions, random Attempt tokens or checkpoint commands. | The LLM emits one small Wiki structure; the service fans pages out with `asyncio.gather` and stores the final structure/pages. It has materially weaker evidence and review guarantees than OKF, but demonstrates that wiki generation itself does not require a dynamic Target graph. [task pipeline](https://github.com/AsyncFuncAI/deepwiki-open/blob/c6bea82b68d47fd81f514e96025de90698030708/api/services/wiki/tasks.py#L212-L312), [Wiki schema](https://github.com/AsyncFuncAI/deepwiki-open/blob/c6bea82b68d47fd81f514e96025de90698030708/api/schemas/wiki.py#L8-L42) |
| Docusaurus | Markdown files are the source; the build derives navigation deterministically from files or an explicit sidebar. | A document ID defaults from its relative file path; an explicit slug is only needed when URL stability must be decoupled from the file. | Relative Markdown file links are resolved by the build. Docusaurus recommends mirroring the sidebar in the filesystem instead of maintaining another hierarchy where possible. [document identity and slugs](https://docusaurus.io/docs/create-doc), [Markdown links](https://docusaurus.io/docs/markdown-features/links), [autogenerated sidebars](https://docusaurus.io/docs/sidebar/autogenerated) |

These implementations target different assurance levels, so line-for-line
imitation would be wrong. The consistent boundary is nevertheless clear:
semantic work is described in the skill; scheduling identity, retry mechanics,
parallel execution and telemetry belong to the host or deterministic runtime.

## Which current mechanisms are unusually complex

### 1. User-supplied session identity is ceremony, not independence

The superseded lifecycle required caller-supplied scheduler identity at Run and
review start. The kernel could prove only that two strings differed, not that a
fresh reviewer context produced the second value.

GitHub and Claude establish subagent isolation in the runtime. Claude's
documentation explicitly states that a normal subagent starts with a fresh
context and does not see the parent conversation history. Review independence
should therefore be a dispatch rule: spawn a distinct review agent with a
read-only packet. Delete producer/reviewer session parameters and their state.

### 2. Random Attempt tokens add no useful correctness

`task_start` already increments `target["attempts"]`, then appends 64 random
bits to produce tokens such as `a2-...`; every packet/checkpoint/complete call
must carry the token ([`_state.py`](../../skills/repo-wiki/scripts/_state.py)).
The needed invariant is only "a result belongs to the currently active
attempt." A monotonic integer is sufficient.

If stale-worker rejection remains necessary, keep an internal integer
`attempt` and embed it in the packet's exact completion command. The
coordinator and user must never invent or transcribe it. Randomness does not
make the comparison stronger.

### 3. The checkpoint duplicates the Artifact

Every Attempt receives a checkpoint path, even though only Plan and Composition
use it. Those two Targets cannot complete until a second Markdown file with five
exact headings has been submitted. A retry creates a new Attempt-specific
checkpoint while only the latest one is operationally relevant.

The official Codex long-task pattern is simpler: one living, self-contained
Markdown plan is continuously updated and is enough to restart from disk. The
Plan and Composition Artifacts can already serve this role. Write partial
progress directly to their stable working files, validate them on completion,
and reuse the same files after retry or context compaction. Delete:

- `task checkpoint`;
- Attempt-specific `*.checkpoint.md` files;
- `checkpoint_digest`, `checkpointed_at` and `previous_checkpoint`;
- the mandatory checkpoint completion gate;
- checkpoint-only headings from the runtime contract.

### 4. Dynamic dossiers turn semantic uncertainty into scheduler topology

A Knowledge Dossier may recursively split into two to eight children. The
kernel then mutates Targets, marks parents superseded, checks depth and global
counts, waits for leaves and later reconciles Composition against the dynamic
graph. This is substantially more machinery than the comparable wiki pipeline,
and it makes the scheduler responsible for a judgment the planner/reviewer can
make directly.

Keep evidence fan-out, but make it host orchestration rather than persisted
domain state. A long-lived planner or composer can dispatch bounded evidence
workers by Source or question. Workers return small Markdown evidence notes;
the owner merges them into the living Plan/Composition. If a topic is too
broad, edit the Plan's topic list and re-review it. Delete recursive dossier
`split`, child Target creation, depth/count limits and superseded states.

### 5. Two page graphs encode more hierarchy than Publication uses

Composition currently asks the LLM for both `parent` and `depends_on`, validates
both DAGs, and schedules synthesis through page review dependencies. Physical
paths already encode the published tree; Publication does not need a second
`parent` hierarchy. Docusaurus makes the same pragmatic choice by recommending
that filesystem structure mirror navigation.

Delete `parent`. Keep `depends_on` only if a writer demonstrably needs reviewed
child page drafts as inputs; otherwise generate all pages independently from
the evidence set and let the final Wiki review check cross-page synthesis.

### 6. Per-page review Targets optimize local state at the expense of the Wiki

The current graph creates `page:write/<page-id>` and `review:<page-id>` for
every page, then implements dependency closure, targeted reopen, metadata-only
refresh and path-move preservation. A Wiki's main risks are global: missing
coverage, duplicate pages, bad hierarchy, inconsistent terminology and broken
cross-links. Per-page approval cannot establish those properties.

Use one persisted `review:wiki` gate over the candidate bundle. The reviewer may
spawn parallel page critics, but one reviewer synthesizes a single report with
issues keyed by page ID. Repair only the named draft files, then rerun the one
bundle gate. Keep a separate Composition review only when there are multiple
pages; a one-page Wiki does not need it.

### 7. `next_actions` and prose describe two coordinators

`run status --json` already calculates `next_actions`, while the skill also
instructs the coordinator to inspect `ready_targets`, start each Target,
recover packets and assemble attempt commands. This duplication is why the
Target loop disappeared conceptually even though state machinery grew.

Restore one explicit loop in `SKILL.md` and make `next_actions` authoritative:

```text
repeat:
  status = okf run status --json
  execute status.next_actions exactly
  dispatch each returned packet to the required worker/reviewer
  collect path-only handoffs
until status says publish or blocked
```

The coordinator should never read `state.json`, derive Target commands or
choose Attempt values.

## ID policy after simplification

| Identifier | Decision | Visibility |
|---|---|---|
| Source name | Keep. It disambiguates multi-Source locators and scopes. Infer a default for a one-Source workspace. | User chooses once only when ambiguity exists. |
| Topic/unit key | Keep only as a short, human-readable coverage key in the Plan if deterministic coverage mapping is still required. Remove it from CLI Target identity. | Generated once by planner; Artifact-only. |
| Page ID | Keep during Composition because paths remain intentionally late-bound and logical links need a stable key. | Generated once by composer; Artifact-only. |
| Final path | Bind after Composition review. It becomes publication identity, not a scheduler identity. | Visible in Composition and output. |
| Target name | Derive from the fixed stage and, for writers, page ID. | Kernel/packet only. |
| Attempt | Replace random token with an incrementing integer, or remove it where the host guarantees one active worker. | Packet-generated command only. |
| Run ID | An internal storage key may remain, but `run status` and `current` resolve it. | Never supplied by the agent/user. |
| Producer/reviewer session | Delete. Require a distinct reviewer subagent instead. | None. |
| Diagram ID | Keep only to pair a planned diagram with its rendered fence and validation. | Page/Composition Artifact only. |
| Content digest | Keep. It binds reviews and immutable Publication to exact bytes. | Kernel and review packet. |

The important distinction is semantic identity versus execution identity.
Source/page keys express durable relationships in the generated knowledge.
Run/Attempt/session values are runtime bookkeeping and should not leak into the
skill's cognitive workload.

## Proposed Artifact contract

Keep four LLM-authored formats:

1. `plan.md`: small YAML topic list plus the living cross-Source analysis,
   findings, gaps and decisions. This is also the planner's recovery file.
2. `composition.md`: page ID, title, final path, assigned topic keys and optional
   diagram specs. The body explains global information architecture. This is
   also the composer's recovery file.
3. `drafts/<page-id>.md`: ordinary Markdown with evidence locators. Writers may
   run in parallel.
4. `review.json`: one strict, small control report for Plan, Composition or the
   final Wiki bundle. JSON remains appropriate here because it drives a state
   transition rather than carrying long-form knowledge.

Evidence-worker notes can be plain Markdown under `evidence/`; they need no
Pydantic domain schema and no Target lifecycle. The deterministic kernel should
own only facts it can prove: revisions, paths, scope boundaries, locator syntax,
unique page IDs/paths, topic coverage, link resolution, digests, candidate
validation and atomic Publication.

## What remains intentionally stricter than comparable tools

DeepWiki-Open allows a page that exhausts retries to become an error placeholder
and still completes the Wiki. That is unsuitable for OKF. The simplified design
should still fail Publication on invalid locators, unknown logical links,
uncovered required topics, failed page generation or a rejected final review.

Likewise, late path binding remains justified because it directly implements
the desired separation between knowledge discovery and information
architecture. The over-design is not the existence of a Page ID; it is making
the coordinator repeatedly carry that ID through a random Attempt/session
protocol and maintaining parallel hierarchy/review graphs around it.

## Recommended deletion order

1. Remove session parameters and random Attempt suffixes; make packet commands
   authoritative.
2. Make Plan and Composition stable living Artifacts and delete checkpoints.
3. Restore the explicit status/dispatch/handoff loop and require subagents for
   independent review and parallel ready work when the host supports them.
4. Remove recursive dossier split and dynamic research Target mutation; use
   bounded evidence workers owned by Plan/Compose.
5. Remove `parent` and the hierarchy DAG.
6. Replace per-page review Targets with one final Wiki review gate.
7. Collapse state reconciliation/reopen logic after the contract is flat, then
   rewrite lifecycle tests around observable Run outcomes rather than internal
   Target bookkeeping.

This order removes exposed ceremony first, then deletes the kernel branches
that existed only to support that ceremony. It preserves the deterministic
guarantees while returning `SKILL.md` to its proper role: a concise SOP for an
agent, not a manual for operating a custom workflow engine.
