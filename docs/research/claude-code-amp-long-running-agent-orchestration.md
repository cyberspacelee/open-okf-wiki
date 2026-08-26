# Claude Code、Amp 与 OpenAI 的长时 Coding Agent 编排实践

日期：2026-08-26

## 范围与证据边界

本文只使用 Anthropic / Claude Code、Amp 与 OpenAI 的官方文档、工程文章和 API 参考，校准
`open-okf-wiki` 实际 Run 问题清单中关于并发、状态、上下文、重试、预算、handoff、
可观测性、校验和证据链的归因。

Amp 在 2026 年重新启用了自动 compaction，并已改变模型与产品架构；因此本文以当前
`ampcode.com/docs` 和 2026 年文章为准，不把 2025 年“用 handoff 取代 compaction”
当作现行设计。[Amp, Rebuilt](https://ampcode.com/news/neo)

## 结论

1. **最高优先级不是提高并发，而是修正执行状态和长尾控制。** Claude Code 的后台
   session 明确区分 `working`、`blocked`、`done`、`failed`、`stopped`；Amp thread
   区分 `idle`、`running`、`awaiting-approval`、`error`。将尚未获得执行槽的任务预先
   记成 `running`，会同时污染耗时、僵尸判断和 Board 状态。
2. **默认并发 2 不能仅凭 17 小时墙钟判错。** 官方共同前提是只并行 ownership
   独立的任务。Claude Code 建议多数协作先从 3–5 个 teammate 起步，但其 workflow
   同样设置 16 个并发硬上限；Amp 只给出独立 fan-out 示例，没有发布通用最优并发。
   应先区分排队与执行并记录 p95，再按配额和独立性调参。
3. **单 worker 缺少 turn / cost 预算是真缺口，但不是 Amp 的共识。** Claude Agent
   SDK 明确提供 `maxTurns` 与 `maxBudgetUsd`，并称生产 agent 默认设置预算是好做法；
   Amp 选择 unconstrained token usage，但同时暴露逐 thread token、请求和费用统计。
   对无人值守 Wiki Run，20 分钟 timeout 不能代替 token / turn 保护。
4. **repair loop 应是“精确诊断、有限修复、无进展即停”，不是盲目重跑。** Claude
   Code 官方 workflow 示例在 checker 通过前循环，但连续两轮无进展即停止；Claude
   Code 最佳实践还建议同一问题纠正超过两次后，用包含已知诊断的 clean context
   重开。Amp 没有推荐对业务合同失败做通用自动 retry。
5. **普通 subagent 隔离不是缺陷。** Claude Code 与 Amp 都让 focused subagent 使用
   独立 context，并只回传结果。Amp 甚至明确说明普通 subagent 互不通信、不能中途
   steer。应由 orchestrator 在后续 retry 中注入前次精确诊断；不应默认广播给所有
   同批 worker。只有任务确需协作时才升级到 shared task list / messaging。
6. **receipt 是否 Markdown 不是核心问题。** 机器消费的调用参数、状态、错误码和路径
   应结构化；丰富证据 artifact 可以继续是 Markdown。`concept is not allowed at ...`
   属于确定性页面路径合同失败，改成 JSON receipt 不会修复 Domain / Concept 层级理解。
7. **compaction 只能维持会话，不能充当事实数据库。** Claude Code 会压缩历史，Amp
   当前在窗口约 90% 时自动压缩；两者都通过 fresh context / thread isolation 控制污染。
   Amp 对超长 thread 的最新实践更明确：摘要只用于定位，精确要求、代码、命令、时间线
   和验证结果必须回读原始消息；tool call 只是尝试，不是成功证据。
8. **C11/C12 的可观测性缺口成立。** Claude Code workflow 显示 phase / agent 的状态、
   token、耗时、近期 tool calls，并允许停止或重启；Amp 提供 thread usage API、stream
   JSON、生命周期与 tool result 事件。只有最终 `run.json` 无法可靠诊断 59.5M token
   来自排队、重复读取、repair、compaction 还是 provider 重试。
9. **验证应是可运行的反馈环。** Claude Code 用 hook 在完成前阻断，并明确示范
   “checker -> fix -> repeat -> no-progress stop”；Amp 要求 prompt / `AGENTS.md` 写清
   test、URL 和 log，并推荐把稳定 test 命令封成窄工具。`host runs exhaustive checks`
   这种描述不如直接给 writer 可执行 checker 和结构化诊断。
10. **证据质量看 claim 是否被来源支撑，不看 source 数量。** Anthropic 的 Research
    系统另设 CitationAgent 定位具体引用，并按 factuality、citation accuracy、
    completeness、source quality 评估。官方没有“少于 3 个 source 必须暂停”的规则；
    也没有要求每个代码 claim 必须带行号。行号是本产品可选择的审计合同，不应包装成
    Claude / Amp 通用标准。
11. **OpenAI 同样要求 outcome、evidence、stop rule 与结构化机器接口分离。** 当前模型指南
    建议 prompt 只保留目标、成功标准、允许副作用、证据和输出形状；对长时工具流程显式
    给出并发、重试和停止上限，并用 Structured Outputs 取代 prompt 内的机器 schema。
    这支持压缩 writer prompt 和结构化诊断，但不支持继续堆自然语言格式规则。

## 1. 并发、队列与状态

Claude Code 根据协调方式区分 subagent、agent view、agent team 与 dynamic workflow：
少量有界委派由主 agent 收集；独立后台任务由 agent view 展示；需要互相通信的团队才用
shared task list；规模化且可重复的编排把计划放进脚本。官方明确要求并行编辑时按文件
ownership 拆分，避免多个 worker 修改同一文件。[Run agents in parallel](https://code.claude.com/docs/en/agents)

Agent team 的 task 状态是 `pending -> in progress -> completed`，依赖未完成时 pending
task 不可领取；后台 session 则公开 `working | blocked | done | failed | stopped`，并将
等待权限、等待输入等原因放在 `waitingFor`。这说明队列状态、真实执行状态和阻塞原因应是
不同 control-plane 字段。[Agent teams](https://code.claude.com/docs/en/agent-teams)
[Agent view](https://code.claude.com/docs/en/agent-view)

Claude Code 建议多数 team 从 3–5 个 teammate 开始，15 个独立任务也可先由 3 个 worker
领取；同时提醒 token 线性增长、协调开销和边际收益递减。Dynamic workflow 为本机资源
设置最多 16 个并发 agent、每 Run 1,000 个 agent 的硬上限。[Agent teams](https://code.claude.com/docs/en/agent-teams)
[Dynamic workflows](https://code.claude.com/docs/en/workflows)

Amp 同样只建议对独立代码区或会产生大量一次性输出的任务使用 subagent；其 agent-to-agent
文档强调 child thread 有独立 context 和 workspace，未提交文件不会自动共享，必须显式
发送。[Modes & Models](https://ampcode.com/docs/models-and-subagents)
[Agent to Agent](https://ampcode.com/docs/orbs/agent-to-agent)

Amp Plugin API 把 thread 公开为 `idle | running | awaiting-approval | error`，等待 response
默认 10 分钟超时，并支持 `cancel()`。虽然它没有单独公开调度队列状态，但不会把未开始
的工作混入 `running`。[Plugin API](https://ampcode.com/docs/plugin-api)

**对清单的裁决：** C1/R8 只能判为待测容量问题，C2 的 16 硬上限本身也不是反模式；
A2/A9/C9/C14 最先暴露的是 `queued` 与 `running` 混淆。只有真实开始后超过 heartbeat / timeout
且进程不存在，才能判定僵尸。

## 2. 上下文、handoff 与证据传递

Claude Code 明确把 context 当作主要约束：不相关任务使用 clean session，调查工作交给
fresh-context subagent；长期不变量放入 durable project instructions，而不是只留在早期
conversation。其官方长时 harness 还证明 compaction 不足以独立完成跨窗口恢复，建议把
完整 feature list、进度和可恢复工作状态留在文件与 git 中，并按有界 feature 增量推进。
[Best practices](https://code.claude.com/docs/en/best-practices)
[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

Anthropic 的多代理 Research 将计划存进外部 Memory，给每个 subagent 明确 objective、
output format、tool / source guidance 和边界；长输出直接持久化为 artifact，主 agent 只接收
轻量引用，减少 token 和“传话”损失。[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

Amp 当前也建议“一 thread 一 task”，并要求用户把已知文件、命令和验证方法直接写入
prompt。[Prompting](https://ampcode.com/docs/prompting) 普通 subagent 不继承完整 conversation，
只获得主 agent 显式传入的 instruction / context。[Modes & Models](https://ampcode.com/docs/models-and-subagents)

Amp 在 2026 年 5 月恢复了 90% 触发的自动 compaction；7 月又为超长 thread 重写
`read_thread`：先搜索再读取，并检查后续消息是否修订、撤销或否定早期结论。官方明确要求
把 compaction 当 orientation，而精确要求、代码、命令、时间线、edit 和 verification
应回读原始记录。[Amp, Rebuilt](https://ampcode.com/news/neo)
[Read Bigger Threads](https://ampcode.com/news/read-bigger-threads)

**对清单的裁决：** A8/A10 的反复读取与压缩后恢复方向可信，但“compaction 导致失败”
不能直接成立。B9/R2 应修成 orchestrator 在重试 assignment 中带上前次 issue code、location、
message 与 artifact refs；不需要同批广播。C5 的模板 fingerprint 不可热修没有得到官方反例；
Anthropic 反而提醒运行中 agent 需要稳定版本，部署不能破坏已有状态。

## 3. Retry、repair 与预算

Claude Agent SDK 的 `maxTurns` 限制 tool-use round trips，`maxBudgetUsd` 限制整个 query
成本并包含 subagent；命中上限会返回可区分的 error subtype，并停止仍在运行的 background
subagent。两项默认均无限制，但官方说明生产 agent 设置预算是好的默认。
[Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)

Claude Code dynamic workflow 给出的 repair 形式不是固定多跑几遍，而是：运行 checker、
修复、直到通过或连续两轮没有进展。其 runtime 将被取消或遇到不可恢复 API error 的 agent
作为 `null` 结果交给编排脚本决定，不将所有错误自动重跑。[Dynamic workflows](https://code.claude.com/docs/en/workflows)

Anthropic 的生产 Research 将模型自适应与 deterministic retry、regular checkpoints 结合，
失败后从 checkpoint 恢复，而不是从头重来；它没有建议对合同 / 语义错误做无条件 retry。
[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

Amp 的 focused subagent API 示例使用 10 分钟 timeout；agent / tool 结果有明确的
`done | error | cancelled`，plugin 可在生命周期事件中观察或改写结果。Amp 没有公开的
worker token hard cap，产品原则反而允许 unconstrained token usage；但它提供按 thread、
model、request、input/output/cache token 和费用拆解的 usage API。
[Plugin API](https://ampcode.com/docs/plugin-api)
[Amp External API](https://ampcode.com/api/external)

**对清单的裁决：** R3/C6 成立于 Claude SDK 的生产实践，但不能称为 Amp 共识。最小实现是
每 worker 的 turn / token 或 cost 上限、全 Run 上限、typed terminal reason；不要把已有 20 分钟
timeout 删掉。C3 不应做通用 `withRetry`：仅自动重试 provider / transport 瞬态错误，合同失败
留在同一 context 做有限 repair；issue digest 无变化则立即停止，冷重试必须携带诊断。

## 4. 可观测性、校验与证据

Claude Code 的 workflow UI 按 phase 展示 agent 数、token、耗时，可展开看 prompt、近期 tool
calls 和 result，并提供 pause、stop、restart。Agent view 还公开 background session 的 PID、
状态和等待原因。[Dynamic workflows](https://code.claude.com/docs/en/workflows)
[Agent view](https://code.claude.com/docs/en/agent-view)

Claude hooks 在模型 context 之外运行，可记录 tool / lifecycle event，也可在 `Stop`、
`SubagentStop`、`TaskCompleted` 或 `TeammateIdle` 阻止错误完成并把精确原因送回 agent；hook
本身不消耗 context，除非返回内容被注入 conversation。[Hooks](https://code.claude.com/docs/en/hooks)

Amp 的 stream JSON 暴露 session、message、tool call/result 与 usage；Plugin API 暴露
`session.start`、`agent.start/end`、`tool.call/result`，并为 tool call 与 result 提供稳定 ID、
状态和错误。[Streaming JSON](https://ampcode.com/news/streaming-json)
[Plugin API](https://ampcode.com/docs/plugin-api)

两家的验证方向都是把反馈变成可执行接口。Claude Code 要求完成前做端到端验证；Amp
Prompting 要求明确 test、URL 和 logs，Amp 还展示了把仓库唯一正确的 test 命令封装成带 schema
的窄工具，避免 agent 猜命令。[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
[Amp Prompting](https://ampcode.com/docs/prompting)
[More Tools for the Agent](https://ampcode.com/news/more-tools-for-the-agent)

证据层面，Anthropic 的 Research 使用 CitationAgent 将 claim 定位到 source 的具体位置，
并按 factuality、citation accuracy、completeness 与 source quality 评估；Claude Code 的
workflow research 还把因 API / rate limit 无法核验的 claim 标为 `unverified`，而不是误判为
已反驳。[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
[Dynamic workflows](https://code.claude.com/docs/en/workflows)

**对清单的裁决：** C11/C12 强成立；建议记录 `queuedAt/startedAt/completedAt`、status / blocker、
round / issue digest、turn、tool calls、input/output/cache token、费用和最近 heartbeat。B12/R10
应通过可运行 validator + `code/path/message` 修复，而不是增加更多自然语言。D2/D3/R7 的精确
evidence 传递值得做，但“所有 claim 强制 file:line”和“source 少于 3 即暂停”不是官方标准。

## 5. 对原问题清单的优先级校准

在进入优先级前，OpenAI 当前模型指南提供了与 Claude / Amp 一致的交叉验证：

- 长时、工具密集或证据收集任务应定义成功标准与停止规则，并在编排合同里明确并发、
  retry 和 stop limit；独立工作流才适合并行。[Model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- prompt 应 outcome-first，静态内容在前、动态内容在后以利缓存；只保留真正的产品不变量，
  机器消费 schema 尽量交给 Structured Outputs。[GPT-5.5 guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)
- compaction 是显式 context-management 能力，使用量仍会返回 input/output/cache token；它应
  保留已完成动作、假设、ID、tool outcome、blocker 和下一目标，不能替代 durable run state。
  [Compact a response](https://developers.openai.com/api/reference/java/resources/responses/methods/compact)
- 优化必须在代表性任务上同时比较成功率、证据完整性、token、latency、cost、calls、turns
  和 retries；资源下降只有在质量门槛仍通过时才算改进。[Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

因此，本项目不需要迁移到另一套 agent framework 才能采用这些实践：现有 activity stream、
handoff envelope、completion validator 与 session hook 已覆盖所需落点，优先补齐语义即可。

| 建议 | 裁决 | 理由 |
| --- | --- | --- |
| 增加 `queued`，真实执行时才写 `startedAt` | **P0** | Claude / Amp 都区分执行、等待 / 阻塞与终态 |
| 实时落 worker / Lead usage、round、issue、heartbeat | **P0** | 两者均提供过程状态、usage 与 lifecycle 观测 |
| worker turn / token 或 cost 上限 + Run 总预算 | **P0** | Claude 明确支持；当前 59.5M 已构成本项目风险证据 |
| repair 按 issue digest 检测无进展并提前停止 | **P0** | Claude 官方 workflow 明确示范连续两轮无进展即停 |
| 重试时注入前次精确 diagnostic | **P0** | fresh-context worker 不继承历史；handoff 必须显式 |
| 暴露 writer 可主动运行的 scoped validator | **P1** | 可执行反馈优于“host 会检查”的黑箱描述 |
| lifecycle reconcile：超时 / 进程退出写 terminal reason | **P1** | 官方后台 runtime 都有明确终态、cancel / resume 语义 |
| 独立 semantic review 检查跨页一致性和证据质量 | **P1** | 机械 gate 与语义 outcome eval 职责不同 |
| 默认 worker 并发从 2 直接提高到 5–8 | **待测** | 并发收益取决于 ownership、配额、CPU 与协调开销 |
| 所有业务失败自动 retry | **不建议** | 会重复确定性合同错误；只重试瞬态基础设施错误 |
| 向同批 worker 广播失败教训 | **不建议默认做** | subagent 隔离是有意设计；由 orchestrator 定向回灌 |
| Run 中热修模板 fingerprint | **不建议** | 无官方支持，且破坏运行版本可复现性 |
| 将所有 Markdown receipt 改成严格 JSON | **不解决主因** | 只需结构化 host 消费的控制字段；页面路径错误仍存在 |
| 因 source 少于 3 就暂停 writer | **不建议** | 证据充分性取决于 claim 与来源质量，不取决于文件计数 |

## 推荐落地顺序

1. 修正状态语义：`queued -> running -> complete | failed | timed_out | interrupted`，并在真实
   获得执行槽时记录 `startedAt`。
2. 给现有 activity 流增加 usage、round、issue digest、heartbeat 与 terminal reason；status
   直接读这些状态，不通过 `startedAt` 猜进程是否活着。
3. 在现有 20 分钟 timeout 外启用 worker turn / token 或 cost 上限；provider 瞬态错误有限
   retry，validator 错误同 session repair，连续两轮无进展停止。
4. retry assignment 由 host 自动附加上次 `code/path/message`，并把 scoped validator 暴露给
   writer 主动运行。不要先做同批广播、模板热修或全 receipt JSON 化。
5. 上述指标稳定后，用固定 Source eval 比较并发 2、3、5 的完成率、p95、token 和冲突率；
   只有真实吞吐改善再调默认值。
