# Portable Host Filesystem and Directory-Rename Publication

Status: ready-for-agent

Extends: Repository Wiki Producer

Related ADRs: 0002 (repository as untrusted data); 0006 (Python as thin harness); 0007 (write Markdown to staging, atomic publication); 0012 (Manual Retry as a new run); 0017 (portable Host filesystem and same-volume directory-rename publication)

## Problem Statement

Operators who need a source-grounded Wiki today can only run full Wiki Run publication on Linux. Staging creation and atomic publication depend on Unix directory file descriptors and `/proc/self/fd`, and the Published Wiki path is required to be a producer-managed symlink into a releases directory. Windows hosts (without WSL or Docker) cannot complete `wiki-run` / publication even though configuration init already works and the CodeMode sandbox dependency ships Windows wheels.

That platform gate is an implementation choice, not a product need: the valuable promises are an isolated Staging Wiki, mechanical validation before exposure, and a failed or incomplete Wiki Run never leaving a half-written tree as the Published Wiki. Operators who always full-generate and re-run failures as separate Wiki Runs still need those promises, but they do not need Linux-only path armor or historical symlink layout compatibility.

## Solution

Keep the Wiki Run application as the single orchestration seam. Replace the Linux-only Host filesystem gate with a portable path policy and replace symlink-pointer publication with same-volume directory-rename exposure of a complete validated release tree.

Default path policy: absolute non-overlapping roots; reject symbolic links and detectable host reparse points on controlled paths; single-file durable writes via temporary file then same-filesystem replace. Default threat model: single-operator Host-controlled workspace. Stricter openat-style backends are not required for this release.

Publication: write each successful candidate under a sibling releases root on the same volume as the Published Wiki path, validate that complete tree, then rename so readers see either the previous complete Published Wiki or the new complete tree—not a partial tree. On mid-swap failure, best-effort restore of the previous tree; if restore fails, leave recoverable paths and a clear operator error. Never leave a half-written directory as the Published Wiki.

Cross-volume publication layouts fail closed at prepare time. Concurrent Wiki Runs targeting the same Published Wiki path fail closed under a Host exclusive publication lock. No migration of legacy symlink publications: if the Published Wiki path is a symlink (or otherwise not a regular directory layout the Host owns), fail with an operator-actionable message; operators delete or clear and full-generate again. Operating model remains full Generate (and optional Refresh as whole-wiki re-evaluation with prior pages as non-authoritative context); failures are separate new Wiki Runs, not resume.

After this work, Wiki Run and publication are not inherently Linux-only; Windows is an in-scope Host platform for the portable policy.

## Proposed test seams (confirm before implementation)

Prefer the fewest, highest seams:

1. **Primary seam (preferred):** `WikiRunApplication.run(request) -> WikiRunResult` with fixture model/Skill/repos, as in existing wiki-run tests. Assert prepare failures, successful publication shape (Published Wiki is a real directory tree with metadata), failed/incomplete runs leave the prior Published Wiki bytes and identity unchanged, Refresh against the new layout, concurrent second run fail-closed, and (where the test host is Windows or a simulated non-Linux policy) absence of a Linux-only hard reject for portable-capable hosts.

2. **Narrow Host-only seam (only if swap/recovery cannot be forced through the application without flaky fault injection):** a Host publication operation used solely by the application (e.g. publish validated staging to destination under path policy). Use only for mid-swap recovery and lock behavior that are awkward to trigger end-to-end. Do not introduce a second public product API.

No new product CLI surface is required beyond removing the Linux-only error and updating operator docs.

## User Stories

1. As an operator on Windows, I want to run a full Wiki Run without WSL or Docker, so that my workstation can produce a Published Wiki.
2. As an operator on Linux, I want existing successful Generate behavior preserved in product terms, so that CI and local runs keep working after the Host filesystem change.
3. As an operator, I want a failed Wiki Run to leave the previous Published Wiki unchanged, so that readers never depend on a broken partial tree.
4. As an operator, I want a cancelled or Needs Input Wiki Run to leave the previous Published Wiki unchanged, so that incomplete work is never exposed.
5. As an operator, I want mechanical validation failure to refuse publication, so that invalid Staging content cannot become the Published Wiki.
6. As an operator, I want a successful Wiki Run to expose a complete validated Markdown tree at the configured Published Wiki path, so that tools and humans open a stable location.
7. As an operator, I want the Published Wiki path to be a real directory of pages after success, so that I do not need symlink privileges or symlink-aware tooling.
8. As an operator, I want publication to use same-volume directory rename, so that exposure is atomic relative to partial file copies into the live path.
9. As an operator, I want cross-volume publication and releases layouts to fail before model work when rename cannot be atomic, so that I am not surprised by a silent copy fallback.
10. As an operator, I want a clear error when staging, skill, snapshot, and publication paths overlap, so that Host isolation remains enforceable.
11. As an operator, I want path components that are symbolic links rejected on Host-controlled roots, so that path swaps cannot redirect staging or publication.
12. As an operator on Windows, I want detectable reparse points on Host-controlled paths rejected where the Host can detect them, so that junction-style redirects are not treated as ordinary directories.
13. As an operator, I want single-file Host writes (run records, receipts, publication metadata) to use temporary file then replace, so that readers do not observe half-written JSON.
14. As an operator, I want concurrent Wiki Runs against the same Published Wiki path to fail closed, so that two renames never interleave.
15. As an operator, I want mid-swap crash recovery to attempt restoring the previous complete tree, so that the stable path usually recovers without manual surgery.
16. As an operator, I want mid-swap unrecoverable failure to leave diagnosable aside and release paths plus a clear error, so that I can restore without guessing.
17. As an operator, I want the Host never to leave a half-written directory named as the Published Wiki, so that “path exists” still means “complete tree or absent/recoverable failure.”
18. As an operator, I want a brief absence of the stable Published Wiki path under extreme interruption to be acceptable only when recovery artifacts remain, so that product promises stay honest.
19. As an operator, I want no automatic migration of legacy symlink publications, so that the Host does not rewrite disks in surprising ways.
20. As an operator, I want a clear error if the Published Wiki path is still a producer-managed symlink layout, so that I know to delete or clear it and full-generate again.
21. As an operator, I want first-time publication when the path is absent to create the new directory layout without requiring a prior wiki, so that greenfield Generate works.
22. As an operator, I want full Generate (empty Staging) to remain the default operating mode, so that each attempt is a complete production of the Wiki.
23. As an operator, I want failure recovery to be a separate Wiki Run (Manual Retry or a new generate), so that I never resume partial staging or partial receipts.
24. As an operator, I want Manual Retry to keep frozen inputs and a new run identity, so that retry stays reproducible without checkpoint resume.
25. As an operator, I want optional Refresh to still mean whole-wiki re-evaluation with prior pages as non-authoritative context, so that I am not promised mechanical page-level incremental updates.
26. As an operator, I want Refresh to load the prior Published Wiki from a real directory layout under the new policy, so that refresh works after the symlink layout is retired.
27. As an operator, I want Refresh to refuse unsafe or non-producer publication trees before model work, so that tampered published content cannot seed staging.
28. As a reader, I want successful publication to present complete pages and navigation at the Published Wiki path, so that I can browse without knowing about releases directories.
29. As a reader, I want a failed run not to change what I already read at the Published Wiki path, so that documentation remains stable under producer failures.
30. As a visualization operator, I want `viz` and other read-only consumers to work against a real-directory Published Wiki, so that visualization does not require following a symlink pointer.
31. As a visualization operator, I want reserved visualization artifacts under publication to remain non-semantic for page validation where already specified, so that viz output does not break refresh or publish checks.
32. As a security-conscious user, I want Repository Snapshots to remain untrusted data with no repository script execution, so that portable FS work does not weaken ADR 0002.
33. As a security-conscious user, I want CodeMode mounts for source and skill to stay read-only and staging write-scoped, so that Agents cannot publish by writing outside Host publication.
34. As a security-conscious user, I want publication to remain Host-owned after validation, so that the model cannot flip the live Published Wiki without mechanical checks.
35. As a product maintainer, I want Linux-only `dir_fd` / `/proc/self/fd` gates removed as hard requirements, so that portable hosts are not rejected up front.
36. As a product maintainer, I want an optional future strict openat backend not to be the default, so that baseline complexity stays portable.
37. As a product maintainer, I want historical release museums out of scope, so that successful swaps may delete superseded release directories.
38. As a product maintainer, I want git-ref publication backends out of this effort, so that the Published Wiki remains a plain directory tree of Markdown.
39. As a product maintainer, I want no mechanical source-diff incremental wiki updater in this effort, so that scope stays Host filesystem and publication layout.
40. As a product maintainer, I want ADR 0017 and README to describe accepted portable policy while implementation lands, so that docs do not claim Windows support before behavior exists—and do claim it once tests prove it.
41. As a CI owner, I want Linux tests to continue proving Generate, failure non-publish, and Refresh semantics, so that the default CI host remains authoritative.
42. As a CI owner, I want Windows (or equivalent) smoke coverage when available for prepare + publish layout, so that portability is not Linux-only in practice.
43. As a developer, I want existing application-level wiki-run tests updated for real-directory publication instead of symlink assertions, so that the suite matches the product.
44. As a developer, I want publication noop behavior when content and required provenance are unchanged to remain meaningful under the new layout, so that Refresh does not churn the live tree unnecessarily where already specified.
45. As an operator, I want staging to remain empty at prepare for Generate, so that each full run starts clean.
46. As an operator, I want analysis receipts and run records to keep secret-free, atomic single-file handoff behavior, so that audit artifacts stay trustworthy across platforms.
47. As an operator, I want exclusive publication lock release on process end (success or failure), so that a dead run does not permanently block the path without a documented recovery story.
48. As an operator, I want lock contention to produce an actionable error naming the Published Wiki path, so that I can find the conflicting run.
49. As an operator, I want Host path policy violations to fail before expensive model work when detectable at prepare, so that bad layouts fail fast.
50. As an operator, I want successful publish to remain all-or-nothing relative to the previous Published Wiki content digest readers observe, so that “updated” means a complete new tree.
51. As a Skill author, I want Generate and Refresh Skill references unchanged in method ownership, so that Host FS portability does not rewrite investigation guidance.
52. As a Skill Fork user, I want forks to keep working without embedding Linux-only path assumptions, so that customization stays content-only.
53. As a TUI user, I want run observation to keep reporting publication success or failure without assuming symlink layout, so that the operator UI stays accurate.
54. As a package consumer, I want `init` and YAML editing to remain available on all Python platforms, so that project setup is not regressed.
55. As a package consumer, I want `wiki-run` help and errors to stop recommending Linux-only as a permanent product limit once portable implementation ships, so that messaging matches capability.
56. As an operator recovering from failure, I want Manual Retry not to require the failed run’s staging directory, so that separate re-runs stay practical.
57. As an operator, I want releases root naming to remain Host-managed beside the Published Wiki path, so that I do not configure a second publication root unless already required.
58. As a product maintainer, I want Adaptive orchestration, provider transport retries, and evaluation fixtures left behaviorally unchanged except for publication layout assumptions, so that this effort stays focused.
59. As a security reviewer, I want “plain pathlib with no symlink checks” rejected as the default, so that portability does not equal no path policy.
60. As a future multi-tenant operator, I want the default threat model documented as single-operator workspace, so that I know stricter FS backends are a separate decision.

## Implementation Decisions

- Respect ADR 0017 as authoritative for portable Host filesystem policy and directory-rename publication; this spec is the delivery contract for that ADR.
- Primary application seam remains the Wiki Run application operation used by CLI, TUI, and tests today. Do not add a second semantic Agent loop or a second public “publish-only” product command unless required for tests; if a Host publish helper exists, it is internal.
- Remove hard runtime rejection of Windows (and of hosts lacking `/proc/self/fd`) as the Wiki Run entry gate. Replace with portable capability checks: path policy enforceable, same-volume rename possible for configured publication and releases roots.
- Host-controlled paths (staging creation, releases root, publication parent, analysis workspace files as applicable) must reject symlink path components; on Windows, reject detectable reparse points where the implementation can detect them without requiring admin rights for normal directory use.
- Published Wiki path after successful publish is a regular directory tree (pages + publication metadata), not a symlink to a release.
- Release materialization continues under a Host-managed sibling releases directory on the same volume; validate the complete release tree before swap.
- Swap algorithm (product-level): install new complete tree at the stable Published Wiki path via same-volume directory renames; if a previous tree exists, move it aside then move the new tree into place; on failure after aside, attempt to restore the previous tree; never expose a partially copied tree at the stable name. Exact temporary names are implementation details.
- Cross-volume: detect at prepare (or at publish preflight) and fail closed; no copy-based publication fallback in this effort.
- Concurrent publish: Host exclusive lock keyed by the Published Wiki path (or canonical parent+name); second run fails closed with a clear error; lock must not survive a clean process exit without recovery documentation if stale locks are possible.
- Legacy symlink Published Wiki: no auto-migration. Fail with operator guidance to remove/clear and full-generate. No dual-layout support.
- Operating model assumptions: default Generate is full production into empty Staging; failure recovery is a new Wiki Run (Manual Retry or new generate), not resume of staging/receipts/message history. Refresh remains available as whole-wiki re-evaluation seeded from the prior Published Wiki as non-authoritative context; implement Refresh against real-directory publication only.
- Superseded release directories may be deleted after successful swap; long-term release history is not a product feature.
- Single-file atomic writes remain temporary-file-then-replace for Host metadata/records/receipts.
- Do not adopt git as publication storage in this effort.
- Do not implement mechanical source-diff incremental page updates.
- Do not make strict openat/`dir_fd` the default; optional future backend only.
- Agent loop, Producer Skill ownership, Snapshot materialization, adaptive orchestration, provider retries, and citation validation rules remain as today except where they assert symlink publication layout.
- Documentation: README platform requirements and operator refresh/publish prose must match the new layout once implemented; ADR 0007 remains the semantic atomicity promise, ADR 0017 the portable mechanism.
- Analysis workspace and any shared atomic write helpers should follow the same portable single-file handoff rules so Windows does not silently drop no-follow flags without policy.

## Testing Decisions

- Good tests assert external behavior at the Wiki Run application boundary: given fixtures (repos, Skill, model behavior, paths, limits), assert terminal result, whether the Published Wiki changed, the shape of the live publication (directory vs symlink), metadata presence, and prepare/publish error messages. Avoid asserting internal use of specific OS flags or `/proc` paths.
- Prefer updating and extending existing wiki-run application tests (complete publish, failure leaves publication unchanged, refresh replace, refresh noop, publication failure, staging validation) over new low-level suites.
- Replace assertions that require the Published Wiki path to be a symlink with assertions that it is a regular directory tree containing expected pages and publication metadata after success.
- Add prepare/publish tests for: overlapping paths; symlink (or reparse where simulable) on controlled path; cross-volume fail closed when the test environment can construct it; exclusive lock fail-closed for a second concurrent or overlapping publish attempt; legacy symlink publication path rejected without migration.
- Add mid-swap recovery tests via the narrow Host publish seam only if application-level fault injection is impractical; assert restore-of-previous or recoverable aside paths and that the stable name is never a partial tree.
- Linux CI remains mandatory green for the suite. Windows smoke (or job) is desirable for “not rejected at runtime” + successful fixture publish when the project CI can provide it; if Windows CI is unavailable in-repo, document the gap and still remove the hard Linux-only gate with tests that do not require Linux-only APIs.
- Prior art: existing `test_wiki_run` application tests for atomic publish, refresh, and failure non-mutation; package/docs tests only if README platform claims are machine-checked.

## Out of Scope

- WSL/Docker packaging as the primary Windows solution (operators may still use them; product must not require them for Wiki Run after this work).
- Automatic migration of existing symlink-based Published Wiki trees.
- Long-term multi-version release retention, rollback UI, or release museums.
- Git-backed publication or refs as the atomic pointer.
- Mechanical incremental wiki generation from source diffs; checkpoint/resume of a failed Wiki Run’s conversation, staging, or receipts.
- Multi-tenant hostile concurrent mutation threat model and default openat armor.
- Changing Producer Skill investigation method, adaptive orchestration topology, provider transport retry budgets, or evaluation scoring beyond publication layout assumptions.
- New product web app, SPA run dashboard, or changes to Wiki Visualization product scope beyond consuming a real-directory Published Wiki.
- Raising or lowering Python version requirements.

## Further Notes

- Product vocabulary: use Staging Wiki, Published Wiki, Wiki Run, Wiki Run Record, Manual Retry Run, Repository Snapshot / Snapshot Set, Refresh, Producer Skill—not “deploy,” “symlink pointer,” or “incremental compile” unless describing rejected alternatives.
- User operating intent captured in design discussion: full Generate each attempt; on failure, run again separately (new Wiki Run). That reinforces no resume and no mechanical incremental scope.
- ADR 0017 already records the architectural decision; this spec is the implementation and acceptance contract for agents.
- Implementation may delete superseded Host code paths that only served `/proc/self/fd` stable paths and symlink-only publication once tests enforce the new external behavior.
