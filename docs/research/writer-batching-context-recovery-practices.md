# Writer 分批、上下文压缩与恢复：Anthropic 与 OpenAI 官方实践分析

日期：2026-08-24

## 范围与证据边界

本文只使用 Anthropic、OpenAI 官方工程文章与平台文档，分析这个具体问题：一个 writer 负责整个大 Source，运行到约 80% 上下文后质量下降并遗漏 Wiki 章节，是否应先 plan、维护 Todo、按 Domain 分批写并更新状态，以及 compaction 后如何继续。

两家的直接案例主要来自长时间编码和复杂研究，不是 repository-to-wiki 写作实验。因此下文严格区分：

- **官方事实**：Anthropic 明确描述的机制、实验或生产经验；
- **本项目推论**：把这些经验映射到 Source / Domain / Wiki 页面；
- **未被证明**：官方资料没有给出、必须由本项目 eval 决定的阈值或收益。

截至本文日期核对的主要一手资料：

- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)（2025-11-26）
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（2025-09-29）
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（2025-06-13）
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)（2026-03-24）
- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)（2026-04-08）
- [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) 与 [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)（当前 Claude Platform 文档）
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（2024-12-19）
- [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)（2026-02-05）
- [Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent) 与 [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)（当前 OpenAI API 文档）
- [Model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5) 与 [Compaction](https://developers.openai.com/api/docs/guides/compaction)（当前 OpenAI API 文档）

## 结论

1. **应该先有完整 plan，再增量写。** Anthropic 的长任务 harness 先建立完整 feature list，后续 session 一次完成一个 feature；Research Lead 也先把计划写入外部 Memory。对本项目的最小映射是：survey handoff 给出完整 Domain / Concept inventory 与 contract hints，页面契约给出必须覆盖的章节，Board 排定全部剩余批次；不必新增 planner agent 或第二份 WritePlan。
2. **完成状态必须在模型上下文之外。** writer 上下文里的 Todo 只帮助当前执行，不能独自承担进程恢复。复用现有 Board 记录批次、execution receipt 记录已完成 Domain；handoff、页面契约、Candidate 与校验结果足以让重试 Writer 重建页级 Todo，无需再做页级调度数据库。
3. **按 Domain 形成有界 writer 任务是合理方案，但这是项目推论，不是 Anthropic 对 Wiki 的规定。** 官方明确支持“可处理的小块 + 结构化 handoff + clean context”，也说明独立方向适合并行、依赖密集任务不适合。Domain 是当前最自然的独立 ownership 边界。
4. **每完成并验证一个 Domain 就更新 durable 状态。** “写完”不能只依据 writer 自报；Anthropic 要求 feature 经端到端验证后才标记完成，并建议复杂流程使用离散 checkpoint。Wiki 对应的是计划页面存在、章节和引用等 scoped validation 通过后，才写入 Domain 的 `complete` receipt。
5. **compaction 能让会话继续，但不能当作完整恢复协议。** 官方 compaction 会用摘要替换旧历史；Anthropic 同时明确观察到摘要可能遗漏微妙但关键的信息，而且早期长任务中 compaction 单独使用并不充分。恢复必须重新读取外部 plan、状态和 Candidate，而不是只信任摘要。
6. **不要直接增加固定 65%、70% 或 80% 阈值。** Anthropic 证明了长上下文存在渐进式精度下降，也提供可配置 compaction trigger，但没有发布“占用到 X% 必然降质”的通用阈值。80% 是本项目观测，应通过固定 Source eval 校准。
7. **不要一开始引入完整多代理流水线。** Anthropic 最新 harness 经验显示，随着模型变化，context reset、sprint 和 evaluator 可能从必要机制变成额外负担。当前只需缩小 writer assignment、持久化进度并验证结果；更细的 Concept writer、独立 planner 或复杂异步协调只在 eval 证明 Domain 仍过大时再加。
8. **OpenAI 的当前实践给出相同边界。** 独立工作流才适合获得各自的受限上下文；manager 应保留最终综合责任；只有职责、工具或策略契约确实改变时才增加 specialist。对本项目而言，Lead 继续负责编排，Domain writer 只承担有界写作，不需要新增 Leader/Planner 层。

## 1. 为什么单个大 Source writer 会漏章节

### 1.1 官方明确支持的原因

Anthropic 把 context 视为有限的 attention budget，并指出 token 增加时，信息检索与长距离推理精度会形成渐进式下降，而不是直到窗口耗尽才突然失败。官方建议始终争取“最小且高信号的 token 集合”。这与“上下文仍未满，但 writer 已经开始遗漏”方向一致。[官方来源](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

长任务 harness 还观察到两个与当前症状相近的失败模式：agent 试图一次做太多，导致中途留下半成品；项目已有部分成果后，后续 agent 又可能过早宣布整体完成。其结论是先建立完整 feature list，再要求每个 session 增量推进并留下结构化进度。[官方来源](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### 1.2 官方没有证明的部分

Anthropic 没有研究“Wiki writer 在 80% context 时的章节遗漏率”，也没有证明遗漏只由 token 占用造成。还可能包括：

- Source 本身的结构难度和跨 Domain 依赖；
- plan 没有把所有页面 / 必需章节显式化；
- writer 的完成判断没有被 validator 校验；
- tool 输出或重复源码占据了大量低信号 context；
- 模型版本与具体 compaction prompt 的差异。

因此，“80% 后下降”应当视为本项目已经测到的 failure boundary，不应包装成通用模型规律。

## 2. Plan 与 Todo 应放在哪里

### 2.1 官方事实

Anthropic 的长任务 harness 使用了三种外部 artifact：完整 feature list、进度文件和 git 历史。Feature 初始全部为未通过；后续 agent 一次选择一个 feature，只允许在验证后修改完成状态，并在 session 结束时更新进度。[官方来源](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

当前 Memory tool 文档把它进一步总结成 multi-session recovery pattern：

1. initializer session 先建立 progress log 和 feature checklist；
2. 新 session 开始时先读这些文件；
3. session 结束前更新已完成和剩余工作；
4. 一次只做一个 feature，端到端验证后才标完成。

[官方来源](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

Anthropic Research 的 Lead 也先将计划保存到 Memory，理由是超出 context 后可能被截断；subagent 返回后由 Lead 综合并决定是否还需研究。[官方来源](https://www.anthropic.com/engineering/multi-agent-research-system)

### 2.2 对当前项目的最小推论

当前 survey handoff 已列出 Domain、Concept 和 evidence-selected contract hints，模板包定义 required contract 与章节，两者共同构成内容 coverage plan；不要复制出另一份 WritePlan。Board 记录可执行批次，Domain assignment 的 durable 状态由已有 execution receipt 保存：

```text
running -> complete
        \-> failed / interrupted
```

页级状态不必进入全局调度器或 receipt：

- 当前 writer 可用 local Todo 保持注意力；
- Candidate 文件是实际产物；
- handoff、页面契约、Candidate 与 scoped validator 诊断可以重建未完成页面；
- 只有 validator 通过后，才写入 Domain 的终态 receipt；Board 随该批次全部 assignment 结束而完成。

这样只有一份计划、一份粗粒度执行状态和一份产物真相，避免 Plan、Todo、receipt 三套状态互相漂移。

## 3. Writer 应如何分批

### 3.1 官方支持什么

Anthropic 2025 长任务实验认为“一次只完成一个 feature”对抑制 agent 一次做太多是关键，并用 progress artifact 在 fresh context 之间交接。[官方来源](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

Context engineering 文章给出三种不同手段：compaction 适合保持长对话连续性，structured note-taking 适合里程碑清楚的迭代开发，subagent 适合能并行探索的复杂研究。Subagent 使用独立 clean context，只向主 agent 返回压缩后的高信号结果。[官方来源](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

Anthropic Research 使用 orchestrator-worker：Lead 制定策略，给 subagent 清楚的目标、输出格式、来源 / 工具指导和任务边界；边界含糊会带来重复工作和覆盖缺口。官方同时警告，需要所有 agent 共享相同 context 或存在大量相互依赖的任务，并不适合当前多代理方式。[官方来源](https://www.anthropic.com/engineering/multi-agent-research-system)

官方 C compiler 实验提供了一个更直观但应谨慎外推的例子：不同 failing test 可被多个 agent 并行处理；当所有 agent 都卡在同一个不可拆“大任务”时，增加到 16 个 agent 也没有帮助，反而互相覆盖修改。该文明确称自己的实现是早期 research prototype，不是通用生产架构。[官方来源](https://www.anthropic.com/engineering/building-c-compiler)

### 3.2 对当前项目的最小推论

建议执行顺序：

```text
survey handoffs + page contracts / Board batch plan
  -> 独立 Domain writers（可受控并行）
  -> Repository 直属聚合页
  -> Wiki 根聚合页
  -> 全量 validation / review
```

理由：Domain 页面只依赖自身证据时可拥有独立写入边界；Repository / Wiki 根页面依赖下层内容，应该最后综合。每个 Domain 使用一个 fresh writer context，通常能在触及本项目已观察到的质量下降区之前结束。

这并不意味着永久规定“一 Domain 必须一 agent”：

- 小 Source 可由一个 writer 完成，只要 eval 没有遗漏；
- 单个 Domain 仍过大时，才继续按 Concept 拆；
- 跨 Domain 依赖密集时，减少并行或由后置聚合 writer 处理；
- 多 writer 不应共同编辑同一页面。

## 4. Compaction 后能否继续

### 4.1 官方机制

当前 Claude Platform 的 server-side compaction 会在达到配置的 input-token trigger 后生成 summary，创建 `compaction` block，并在后续请求中忽略该 block 之前的历史，从摘要继续。官方当前默认 trigger 示例 / 参数值为 150,000 input tokens，最低允许 50,000；这些是 Claude API 的绝对 token 配置，不是通用百分比，也不能直接套到其他 agent runtime。[官方来源](https://platform.claude.com/docs/en/build-with-claude/compaction)

官方 context engineering 文章称 compaction 是长任务的首个常用 lever，但明确警告：过度压缩可能丢失当时看似细微、后来才显得关键的上下文；应先调高 recall，再逐步去除冗余。Structured notes / memory 则专门保存必须跨摘要、跨 reset 存活的信息。[官方来源](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

长任务 harness 的结论更直接：compaction 本身不充分，摘要不总能向下一 context 传递完全清晰的指令。[官方来源](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### 4.2 对当前项目的恢复流程

Compaction 后可以继续，但要区分两种恢复：

- 同一 Writer session 压缩后，host 立即注入当前 assignment、write target、base Candidate revision、已触碰路径和完整 Writer Todo；Writer 重新读取 handoff、Candidate 页面与必要 Source evidence，只继续 Todo 中未完成的页面。
- 进程重启后，Lead 从 durable checkpoint 中读取 Board 与 execution receipts，只重派 failed / interrupted Domain；fresh Writer 读取原 handoff、当前 Candidate 和页面契约，重新建立完整 Todo。Writer 不直接读取运行时 Board 或 receipts。

目标内页面全部完成且 scoped validation 通过后，host 才生成 handoff 并写入终态 receipt；一批 assignment 全部结束后再更新 Board。已完成页面正文、长 tool 输出和完整源码不进入 checkpoint，因为它们可从 Candidate / Source 按需读取。

如果已经实测同一 writer 在 compaction 前就开始降质，则更稳妥的是在 Domain 边界主动结束，并让下一个 Domain 用 fresh session；compaction 只作为“单个 Domain 仍然过大”的兜底。这里的选择是基于本项目观测的推论。

## 5. Reset、连续会话与模型差异

Anthropic 2026 harness 文章给出了重要反例：Sonnet 4.5 实验中存在接近 context limit 时过早收尾的“context anxiety”，compaction 单独使用不够，clean reset + structured handoff 是关键；换到 Opus 4.5 后该行为大幅消失，团队取消 reset，改用连续 session + 自动 compaction。[官方来源](https://www.anthropic.com/engineering/harness-design-long-running-apps)

同一研究在 Opus 4.5 上使用 planner、按 feature 的 sprint 和 evaluator；换到 Opus 4.6 后，又能删除 sprint 分解而保持长时间连续构建。Anthropic 的结论不是“永远拆 sprint”，而是 harness 的每个组件都代表对模型能力的假设，模型进步后应重新检验并删除不再必要的机制。[官方来源](https://www.anthropic.com/engineering/harness-design-long-running-apps)

Managed Agents 文章再次强调这个例子：reset 在一个模型上解决问题，在另一个模型上已成为 dead weight；稳定的应该是 session、harness、sandbox 与 durable event log 等接口，而不是某个固定恢复技巧。它还描述了 harness 崩溃后通过外部 session log 从最后事件恢复。[官方来源](https://www.anthropic.com/engineering/managed-agents)

对本项目的含义是：

- 当前已有“80% 后遗漏”的生产证据，先使用 Domain 边界缩短 session 是合理的；
- 不要把 reset 或某个百分比写成永久协议；
- 升级模型、prompt 或 compaction 后，用相同大 Source eval 重新判断是否仍需拆分；
- durable plan / status / Candidate 应保留，因为它们同时服务 compaction、进程崩溃和审计，不依赖某个模型行为。

## 6. 并行批次与恢复边界

### 并行

只并行满足以下条件的 Domain：读取范围清楚、页面 ownership 不重叠、输出不依赖另一个尚未完成的 Domain。Anthropic 的并行收益来自真正独立的方向；同步等待一组 subagent 虽然协调简单，却会被最慢任务阻塞，而异步执行又增加结果协调、状态一致性和错误传播复杂度。[官方来源](https://www.anthropic.com/engineering/multi-agent-research-system)

因此，当前无需为了吞吐先做复杂异步 DAG。沿用现有受控并发，等一批 Domain 全部产生 `complete` receipt 后再写聚合页即可。

### 恢复

Anthropic 的生产 Research 系统把 agent 视为长时间、可积累错误的 stateful process；它结合模型适应性、确定性 retry 和 regular checkpoints，并从失败点恢复，而不是昂贵地从头重跑。[官方来源](https://www.anthropic.com/engineering/multi-agent-research-system)

当前项目最小 durable checkpoint 是“一个已验证 Domain”的 execution receipt。如果进程在 Domain 中途失败，Lead 从 Board 与 receipts 判断重派，fresh Writer 从 handoff、页面契约和 Candidate 重建完整 Todo，不需要恢复旧对话。只有这些 artifact 不能可靠表达部分进度时，才需要增加更细的持久状态。

## 7. OpenAI 官方实践的交叉验证

### 7.1 独立上下文应对应独立责任

OpenAI 的 Multi-agent 文档把 focused context 列为多代理的直接收益：独立工作被分给有界 subagent 后，各自维护自己的 context，可减少无关工作流之间的干扰。它同时限定适用条件是任务能拆成 independent sections，并非只要任务长就应增加 agent。[官方来源](https://developers.openai.com/api/docs/guides/responses-multi-agent)

Orchestration 文档进一步区分了 handoff 与 manager-style workflow：需要中心代理综合最终结果时，manager 应保持控制，把 specialist 当作有界能力；并且只有 capability isolation、policy isolation、prompt clarity 或 trace legibility 有实质改善时才增加 specialist。[官方来源](https://developers.openai.com/api/docs/guides/agents/orchestration)

对当前项目的映射是：保留 Lead 作为 manager，把写入 ownership 不重叠的 Domain 作为独立 writer assignment；Repository / Wiki 根页面仍由后置聚合任务负责。这里不需要再增加 Leader 或 Planner agent，因为 orchestration ownership 没有改变。

### 7.2 Compaction checkpoint 必须保存执行状态

OpenAI 的当前 Model guidance 要求长任务有意使用 compaction，并明确保存 completed actions、active assumptions、IDs、tool outcomes、unresolved blockers 和 next concrete goal。[官方来源](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)

OpenAI 的 compaction 文档允许按 token threshold 自动触发，并说明 compacted item 会携带下一窗口需要的 prior state，但该内容是 opaque，不应由应用解析或作为业务状态接口。[官方来源](https://developers.openai.com/api/docs/guides/compaction) 其较早模型指导还建议在主要 milestone 后压缩而非每轮压缩，并在恢复时保持 prompt 功能一致。[官方来源](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)

这支持把当前 writer checkpoint 补全为：当前 assignment / write target、base Candidate revision、已触碰路径和完整页面 Todo。必要 contract 仍由 session prompt 注入，页面正文仍从 Candidate 读取。它不支持把 compaction summary 当作 Board，也不支持仅靠提前触发阈值解决章节遗漏。

### 7.3 Prompt 应保持精简但契约完整

OpenAI 建议长任务明确 outcome、success criteria、evidence rules、stopping conditions，并减少重复的过程指导；同一条指令只陈述一次。[官方来源](https://developers.openai.com/api/docs/guides/latest-model)

因此语言、目录组织、页面模板和 citation 属于 Writer 必须收到的产品契约，但不应在 Lead、Board、Todo 与 compaction checkpoint 中各复制一份。稳定规则由 Writer prompt / reference 注入一次；checkpoint 只保存规则引用和当前批次中不可重建的决策。

## 8. 最小落地方案

不考虑历史兼容时，建议只做以下四件事：

1. Lead 在写作前从 survey handoffs 建立完整 Domain 批次顺序；页面 coverage 复用 handoff hints 与模板契约，不新增 planner agent。
2. 一个 writer assignment 默认只覆盖一个 Domain；独立 Domain 可按现有并发能力并行。
3. Board 持久化批次，已有 execution receipt 持久化已完成 Domain；writer-local Todo 不作为跨进程权威状态。
4. Domain scoped validation 通过后才写终态 receipt；compaction 从 checkpoint + handoff + Candidate 继续，进程重启由 Lead 从 Board + receipts 重派，Writer 从 handoff + contracts + Candidate 重建 Todo。

暂不增加：独立 WritePlan 文件、页级调度数据库、固定上下文百分比、Concept writer、复杂异步 DAG、专门 recovery agent。只有大 Domain eval 仍出现遗漏，或 Candidate 无法可靠重建中途进度时，再增加下一层机制。

## 9. 建议如何验证方案

Anthropic 建议从小样本真实任务立即开始 eval，并对会修改状态的长任务看 end state；复杂流程可以设离散 checkpoint，不必规定唯一执行轨迹。[官方来源](https://www.anthropic.com/engineering/multi-agent-research-system)

用同一组大 Source 比较当前方案与 Domain batching，至少记录：

- 计划页面 / 必需章节覆盖率；
- invalid 或 missing page 数；
- writer 达到的最高 context 占用与 compaction 次数；
- 重启后重复写、覆盖已完成页面和无法恢复的次数；
- token、wall time 与 review 返工量。

成功标准应是覆盖率和最终质量改善，而不是“必须恰好一个 writer / 一个 batch / 一次 compaction”。
