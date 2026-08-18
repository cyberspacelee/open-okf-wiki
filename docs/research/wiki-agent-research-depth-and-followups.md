# Wiki agent：research 要不要抠细节，以及 follow-up 何时开新 batch

日期：2026-08-18

## 范围与证据边界

回答两个问题：

1. 本仓库的 research 阶段要不要追实现细节。
2. 为什么当前 Run 会不断因为 question 再开 research batch，prompt 该怎么收。

一手来源：

- Anthropic [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（2025 工程文）
- Shao et al. [Assisting in Writing Wikipedia-like Articles From Scratch with Large Language Models](https://arxiv.org/abs/2402.14207)（STORM，arXiv:2402.14207）
- 本仓库 `refs/openwiki` 的 init 工作流与 local-brain open-questions 规则
- 本仓库当前 production skill 与 host 对 `followups` 的处理

仓库外检索没有找到与本项目同构的「repository Source → domain wiki」现成规范；可比的是百科生成管线（STORM）和通用多代理研究系统（Anthropic）。下文把事实与对本仓库的推论分开。

## 结论

1. **Research 要的是地图，不是页面正文。** 交付物是 domain/concept inventory、入口、公共面、主流程、跨 Source 边界，以及可复查的 locator。实现细节、调用链、状态机逐步展开属于 writer 的 JIT 核证。
2. **Question asking 是研究策略，不是控制面 blocker。** STORM 用多视角问题去检索，然后 outline、再写；问题本身不会在「已经有地图」之后再开一轮研究流水线。Anthropic Research 的第二轮只由明确缺口触发。
3. **当前多 batch 的直接原因是 YAML `followups` 被 host 当成 blocker。** `handoff.md` 里任何 follow-up（即使 `status: complete`）都会让 board `nextAction` 变成 `supplement`，Lead 再 `wiki_delegate_start`。旧 research 示例把「Which fallback handles an unavailable primary store?」这种细节问题写成 follow-up，等于教模型把 curiosities 升级成新 batch。
4. **Writer-facing 问题应留在 `## Gaps and failed reads`，并用 `followups: []` + `complete` 结束。** 只有 unread required scope、无法命名 taxonomy、会拆开 domain 身份的冲突、或 tool failure 才进 YAML followups。

## 1. 外部系统怎么切 research / write

### 1.1 Anthropic：subagent 压缩，Lead 综合，引用后置

Anthropic 的 orchestrator-worker 把职责拆开：Lead 分解与覆盖判断；subagent 在独立 context 里搜索并**压缩**发现；研究充分后再把 findings 交给 CitationAgent 做 claim-to-source。[架构概览](https://www.anthropic.com/engineering/multi-agent-research-system)

同一文明确：研究是路径依赖的，线性 one-shot 不够；但并行首轮之后，是否继续创建 subagent 由缺口决定，而不是固定多轮。delegation 必须带目标、输出格式、来源指导和停止边界；含糊指令会造成重复搜索和对子任务的不同理解。

对本仓库的推论：researcher 应返回可比较的 coverage + locator，而不是把每个未读文件变成新任务。Writer 已经要求 reopen load-bearing ranges；那是细节阶段。

### 1.2 STORM：先问问题去检索，再 outline，再写

STORM 的顺序是 perspective-guided question asking → retrieval → outline synthesis → section writing with citations。[论文](https://arxiv.org/abs/2402.14207)

关键点：

- 问题用来**扩大检索面**，发生在 outline 之前。
- 有了 grounded outline 之后进入写作，而不是「还有问题 → 再开一轮 research agent」。
- 写作阶段才把 retrieved passages 变成带引用的段落。

这对应本仓库的 `inventory → taxonomy/plan → write`。Discovery researcher 内部可以用问题驱动 grep/read；那些问题不应泄漏为 host followups。

### 1.3 OpenWiki：先 skeleton，critic 有限次，open questions 很贵

OpenWiki repository init 先写 `_skeleton.md` inventory，再 `skeleton_critic`，critic 最多两轮，然后才填页面正文。QA 问题发生在**写完之后**，用来验 wiki，不是用来推迟 skeleton。[OpenWiki agent workflow](../../refs/openwiki/openwiki/agent/workflow.md)

其 personal-brain 规则更直接：`open-questions.md` 只收会妨碍后续协助的不确定性，不把源文档里每一个未决产品问题抄进去。

这与 host 语义一致：YAML followup 很贵（新 session、新 batch、Lead 再综合），Gaps 散文很便宜（writer 读 locator）。

## 2. 本仓库的机制

Host 把 research handoff 的 YAML `followups` 投影成 board blockers。`wikiNextAction` 在仍有 blocker 时返回 `supplement`，不会进入 taxonomy。[board nextAction](../../packages/wiki-workflows/src/lead/board.ts)

`complete` 仍可携带 followups；`needsFollowup` 只看数组是否非空。因此「写完了但还想问几个问题」也会开新 batch。

旧 prompt 的三处推力叠在一起：

- 「deepen only where it affects the reader's question」鼓励追细节。
- 「State every unresolved question」把 curiosities 写进 handoff。
- 示例 YAML 本身就是一个细节 `evidence_gap`。

Discovery 默认方向「Survey this pinned Source completely」和 supplement 指令「Resolve these open research questions… Produce a complete evidence handoff」会把同一循环再放大一轮。

## 3. 已做的 prompt 收口

- Researcher：inventory + locator；默认 `followups: []` + `complete`；Gaps 收 writer locators。
- Lead：discovery 槽保持 Source inventory；`nextAction: taxonomy` 时进入 taxonomy，不把 Gaps 散文当成 supplement。
- Host 默认 discovery / supplement 方向与上述契约对齐。

未改 host 的 followup → supplement 机械映射。那条路径仍应留给真 blocker。
