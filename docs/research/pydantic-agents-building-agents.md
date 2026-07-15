# Pydantic “agents building agents” 对 OKF Wiki 的适用性

> **已被 greenfield 分析取代。** 本文假设现有确定性控制平面必须保留；从“repo → wiki”目标重新设计时，请以 [`pydanticai-greenfield-repo-to-wiki.md`](./pydanticai-greenfield-repo-to-wiki.md) 为准。本文保留用于追溯该前提下的 API 边界判断。

核验日期：2026-07-15。

## 结论

Pydantic 所说的 agent loop 有两个增量：让模型自行选择子任务结构，以及让工作跨越单次 run。这个方向适合增强 OKF Wiki 的**语义执行平面**，但不应替代现有确定性控制平面。Coverage Obligation、固定 Source Snapshot、预算、验收、审核、渲染和发布仍应由代码拥有；模型可以决定“怎样调查一个已分配任务”，不能决定“哪些义务可以消失”。这与官方文章中“给目标而不是给计划”的通用 agent 方向有意不同，因为本项目需要机器可审计的完整性。

当前不建议直接增加 `pydantic-ai-harness` 依赖。最值得先验证的是在非权威的 Source Investigation 中使用 `SubAgents`；只有 benchmark 证明固定委派不足，再试 `DynamicWorkflow`。`StepPersistence` 只可能是单个语义任务的辅助恢复层；`RuntimeAuthoring` 不应进入生产运行时。

## 官方能力的实际边界

本文以 2026-07-14 的官方文章 [When agents build agents](https://pydantic.dev/articles/when-agents-build-agents) 和官方 `pydantic-ai-harness` [`v0.7.0`](https://github.com/pydantic/pydantic-ai-harness/tree/v0.7.0) 为证据基线。0.7.0 在 PyPI 仍标记为 [Alpha](https://pypi.org/project/pydantic-ai-harness/0.7.0/)，且官方 [version policy](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/README.md#version-policy) 允许 0.x minor release 引入 breaking changes。

| 能力 | 官方现状 | 对本项目的判断 |
|---|---|---|
| [`SubAgents`](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md) | 一个 `delegate_task(agent_name, task)`；child 有隔离 message history；支持 per-delegate token/request、wall time、调用次数和错误 containment。也可从 `.agents/agents/*.md` 加载 agent 定义。 | **有条件适用。** 可用于来源间相互独立的 provisional 调查；生产 Worker 暂无必要。应显式构造可信 roster，不自动读取被分析仓库里的 agent 定义。 |
| [`DynamicWorkflow`](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md) | 模型在 Monty sandbox 中写一个 Python 脚本，以一次 `run_workflow` 完成 fan-out、chain、vote；只有最终值回到 parent context。提供 `max_agent_calls`、sub-agent usage 和 sandbox resource limits。workflow 不能嵌套，sub-agent 当前只有 `task: str` 输入；**durable workflow 尚未实现**。 | **暂缓。** 它适合复杂语义调查，不适合承载 Production Run 状态机。现有任务需要 typed scope、精确 obligations 和可审计中间结果，当前 call contract 仍偏弱。 |
| [`RuntimeAuthoring`](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/runtime_authoring/README.md) | Agent 写 `.py` capability，宿主 import、构造并做有限静态检查；能力只在下一次 run 生效。官方明确这是任意 Python 在宿主进程执行的 trust boundary。 | **生产禁用。** 与“不执行不可信 source、无 shell/任意代码、能力集固定可复现”的安全模型冲突。若用于开发，只能生成待人工 review/test 的候选代码，不能自动激活。 |
| [`StepPersistence`](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/step_persistence/README.md) | 记录 append-only step event、provider-valid message snapshot、tool-effect ledger 和 run lineage；可 `continue_run` / `fork_run`。它不是 graph-state checkpoint，不恢复 capability state、retry counter 或 in-flight stream，也不自动去重 side effect。 | **仅作辅助。** 可减少长时间只读 Agent task 崩溃后的重复 token 消耗，但不能成为业务状态或发布恢复机制。 |

官方 0.7.0 [capability matrix](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/README.md#capability-matrix) 仍把第一方 **Skills** 标为建设中。`SubAgents` 的磁盘 agent 定义也不是 `SKILL.md` 编排。因此现在不能把这些能力描述成已经成熟的动态 skill workflow；本仓库 `.agents/skills/` 仍只是开发 agent 的工作说明，产品运行时没有加载它们。

## 与当前架构的对应

当前项目只依赖 `pydantic-ai==2.8.*`，未依赖 Harness（[`pyproject.toml`](../../pyproject.toml#L6-L12)）。现有设计已经把该动态与确定性的 seam 放对了：

- Planner 是短生命周期 typed call，接收 bounded summary，并被明确要求不创建 Agent、不保留状态（[`planner.py`](../../src/okf_wiki/planner.py#L49-L88)）。
- Worker 在一个 `AnalysisTask` 内自主循环调用三个只读工具，受 request/tool/token/wall-time budget 约束，只返回 `WorkerProposal`（[`worker.py`](../../src/okf_wiki/worker.py#L299-L322)、[`worker.py`](../../src/okf_wiki/worker.py#L377-L447)）。这已经是需要保留的动态 loop。
- Scheduler 校验模型计划不能越过 Source、path、tool 和 budget，并以 SQLite task 状态、有限 replan、并发 Worker 和固定五视角 verifier 推进（[`scheduler.py`](../../src/okf_wiki/scheduler.py#L547-L705)、[`scheduler.py`](../../src/okf_wiki/scheduler.py#L871-L958)、[`scheduler.py`](../../src/okf_wiki/scheduler.py#L1112-L1197)）。
- Production Run 状态与事件是权威记录（[`run_state.py`](../../src/okf_wiki/run_state.py#L9-L60)）；恢复会把未决 task 回退到可重跑状态并继续确定性阶段，而不是恢复模型上下文（[`workspace.py`](../../src/okf_wiki/workspace.py#L462-L544)）。
- Markdown 从 Accepted Knowledge Model 确定性渲染，Agent 不直接写正式 Bundle（[`cli.py`](../../src/okf_wiki/cli.py#L641-L720)、[`bundle.py`](../../src/okf_wiki/bundle.py#L273-L301)）。

因此，把 top-level Scheduler 改成模型编写的 workflow 会降低 locality：coverage、恢复、权限和验收复杂度会从一个确定性模块散到 prompt、sub-agent task string 与 message history 中。Harness 能力只应放在 `Worker.run()` 或 provisional investigation 这类已有语义 seam 后面，并继续返回当前 typed interface。

## 建议的演进顺序

1. **保持现状。** 不因文章发布就替换 Scheduler，也不先抽象通用 workflow DSL。
2. **做一个 Source Investigation spike。** 仅当问题跨多个 Source 时，显式创建每 Source 一个只读 child，加一个 synthesizer；使用 `SubAgents` 的 per-delegate limits、timeout、`max_calls`，禁止 tool inheritance 和磁盘 auto-discovery。对照现有单 Agent 测 citation validity、insufficient-support precision、成本、延迟和失败隔离。
3. **收益成立后再试 DynamicWorkflow。** 复用相同固定 roster，只让模型选择 fan-out/chaining；设置精确 `max_agent_calls`、sub-agent token limits 和 sandbox CPU/resource limit。最终仍必须产出当前 typed draft/proposal，并经过现有 evidence digest、coverage、verifier 和 acceptance transaction。
4. **只在重跑成本成为实测问题时加 StepPersistence。** 独立存储 semantic message snapshot，记录 `run_id/task_id/candidate_id` 关联；恢复结果重新走全部结构、证据和验收校验。控制平面的 `runs.db`、task state 和 event log 继续权威。由于 snapshot 会持久化 source excerpt 和完整消息，还必须先定义 retention、权限、redaction 与升级兼容策略。
5. **不部署 RuntimeAuthoring。** 若以后需要“Agent 提议新能力”，最小安全路径是写入 staging/branch，人工 review，运行测试和 benchmark，随后正常发布；绝不让生产 Agent import 自己刚写的代码。
6. **Skill 等稳定后再评估。** 若未来引入产品 skill，只加载产品自带、版本固定、可散列的说明，并把 digest 写入 Run snapshot；被分析 Source 中的 `SKILL.md`、`AGENTS.md` 和其他指令仍只作为不可信证据。

最小目标不是“Agent 自己造一个新平台”，而是让现有深模块保持不变：Scheduler 负责可恢复的确定性进度，Worker/Investigation adapter 可选择更强的内部 agent choreography，Accepted Knowledge interface 继续隔离所有概率性实现。
