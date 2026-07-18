# Pydantic AI Harness：大仓库上下文、递归委派与 repo→wiki 架构复审

> 研究日期：2026-07-16
>
> 结论基于当前项目源码、三个本地 refs 的固定快照，以及 Pydantic AI Harness v0.7.0、Pydantic AI v2.10.0 和 OpenWiki 所用 DeepAgents 1.10.8 的一手源码。没有修改运行代码。

## 结论先行

此前“保持单 Agent，只先试 Planning，SubAgents 等出现 specialist 需求后再说”的结论不成立。

当前项目的单个 Agent.run + CodeMode 在小仓库上可以工作，但在大代码库、文档库或多仓库输入上存在结构性上下文瓶颈：

1. CodeMode 减少工具往返和消息数量，却没有增加模型的语义上下文窗口。
2. 当前父 Agent 同时承担全局目标、调查、跨模块综合、页面选择、写作和 review；所有模型可用的语义证据最终仍进入同一条历史。
3. 项目允许最多 500 MB 源数据、50,000 个文件和单文件 25 MB，却没有 context compaction、隔离研究 run、分层 receipts 或持久调查草稿。
4. Planning 只能防止忘记“还要做什么”，不能让一个上下文容纳更多源码；SubAgents 才提供新的、隔离的上下文窗口。

因此，用户提出的形态是合理的，而且是当前项目处理大仓库时最小而完整的方向：

**父 Agent 保持目标与计划 → 动态委派只读研究 Agent → 子 Agent 在有界深度内继续拆分 → 每层只向上一层返回压缩且带证据的 receipt → receipts 落入临时 `/analysis` scratch → 父 Agent 独占最终 Wiki 写入、复核与发布。**

现在应启用 Planning、SubAgents、有界递归、scratch receipts 和 compaction；保留 CodeMode。DynamicWorkflow 允许作为 Domain→Leaf 的单层 fan-out/reduce 协调，但不作为递归骨架，也不嵌套 DynamicWorkflow。

## 1. 当前实现为什么会卡在单一上下文

### 1.1 实际执行流

当前 Wiki Run：

- 配置了累计 request、tool、input/output/total token 和 wall-clock 上限，其中累计 input token 默认为 250,000，累计 total token 为 350,000（[host/models.py](../../src/okf_wiki/host/models.py)）。
- 构造一个 Agent，唯一 capability 是 CodeMode；父 Agent 同时拥有只读 source、只读 skill 和读写 wiki mounts（[host/lifecycle.py](../../src/okf_wiki/host/lifecycle.py#L395-L520)）。
- 只调用一次 Agent.run，所有探索、规划、写作、review 和结束判断都发生在这一次 run 中（[host/lifecycle.py](../../src/okf_wiki/host/lifecycle.py#L536-L560)）。
- 明确关闭 instrumentation，因此当前没有可用于还原长 run 内部上下文增长和未来 child runs 的 trace（[host/lifecycle.py](../../src/okf_wiki/host/lifecycle.py)）。

Producer Skill 也把所有语义职责放在同一 run：调查并决定页面、写整站、再读 review 指南修复（[SKILL.md](../../src/okf_wiki/producer_skill/SKILL.md#L8-L41)）。Refresh 更要求重新检查完整 Repository Snapshot Set（[refresh.md](../../src/okf_wiki/producer_skill/references/refresh.md#L1-L8)）。

项目没有：

- Planning capability；
- SubAgents 或 child Agent；
- DynamicWorkflow；
- compaction；
- `/analysis` scratch research/receipt mount；
- durable plan 或 run resume；
- 全树 usage、depth、fan-out 和 child concurrency 观测。

这正是 [ADR 0003](../adr/0003-let-one-pydanticai-agent-own-the-semantic-loop.md#L1-L3) 的设计，但该 ADR 的“等评估证明 repeatable specialist need”前提忽略了输入规模与有限上下文之间的结构性差距。

### 1.2 输入规模已经超过单 run 的合理语义容量

按固定快照执行 git ls-tree -r -l，并只统计常见源码、配置和文档扩展名；token 估算采用 Harness 自己使用的约 4 chars/token 启发式：

| 快照 | text-like 文件 | text-like 字节 | 约合 token |
|---|---:|---:|---:|
| openwiki ddd1f60 | 88 | 879,470 | 219,867 |
| open-knowledge 96563d1 | 3,458 | 42,869,552 | 10,717,388 |
| knowledge-catalog d44368c | 256 | 1,384,053 | 346,013 |

项目自己的 live-eval manifest 已把 openwiki、iwe 和 open-knowledge 分为 small、medium、large 三档，并把 open-knowledge 作为 large case（[wiki_evaluation_repositories.json](../../src/okf_wiki/evaluation/wiki_evaluation_repositories.json#L1-L27)）。

这不意味着 Wiki 必须逐字读取整个仓库；选择性调查仍然正确。但它说明：

- 即使 openwiki 的全部 text-like 内容只读一次，也已经接近当前 250k 的累计 input-token 上限；
- knowledge-catalog 已超过该上限；
- open-knowledge 高出两个数量级；
- Pydantic AI 的 input_tokens_limit 是整个 run 所有请求的累计输入量，同一历史在后续请求中重放也继续计数，而不是“单次上下文最大值”（[Pydantic AI usage.py v2.10.0](https://github.com/pydantic/pydantic-ai/blob/v2.10.0/pydantic_ai_slim/pydantic_ai/usage.py#L182-L225)、[limits](https://github.com/pydantic/pydantic-ai/blob/v2.10.0/pydantic_ai_slim/pydantic_ai/usage.py#L258-L337)）。

单 Agent 可以做文件树、正则和批量读取，却无法让未进入模型上下文的代码获得语义分析。CodeMode 能在 sandbox 中机械过滤和聚合；跨模块意图、边界、因果关系和页面叙事仍由同一个模型上下文承担。

### 1.3 CodeMode 是必要能力，但不是 context solution

CodeMode 的官方目标是把多次工具调用合并到一个 run_code 中，支持循环、条件、并行和本地聚合，从而减少模型 round trips 与消息量（[CodeMode README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/README.md#L7-L20)）。其 REPL state 也只在同一个 agent run 内保留（[CodeMode README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/README.md#L145-L168)）。

它不能：

- 给模型新增第二个语义上下文；
- 自动把仓库分区交给独立模型 run；
- 保证旧证据在历史变长后仍被记住；
- 在父上下文之外完成跨文件语义调查；
- 替代 Planning 或 compaction。

所以正确关系不是 CodeMode 或 SubAgents 二选一，而是：

**CodeMode 负责一个 Agent 内的机械批处理；SubAgents 负责多个隔离语义上下文；Planning 负责目标连续性；compaction 负责每个上下文自身的寿命。**

## 2. 三个 refs 的真实做法

### 2.1 openwiki：已经把 plan、subagent 和自动 summarization 一起使用

真实入口是 CLI 调用 runOpenWikiAgent；运行时创建 DeepAgents backend、checkpointer 和 createDeepAgent，再流式执行（固定快照 `refs/openwiki/src/agent/index.ts:149-209`）。

OpenWiki 的 prompt 明确要求：

- 大型或陌生仓库默认调用 1–2 个 subagents，必要时 3–4 个；
- subagents 只做只读调查；
- 每个 child 接收窄 scope；
- child 返回带 source paths 和 open questions 的简洁 findings；
- 主 Agent 负责综合和全部最终写入（`refs/openwiki/src/agent/prompt.ts:78-84`）。

它同时要求调查后创建临时 _plan.md，记录页面、每页证据和剩余问题，完成前删除（`refs/openwiki/src/agent/prompt.ts:86-90`）；更新模式还先做 source change → affected docs → edit → reason 的 impact plan（`refs/openwiki/src/agent/prompt.ts:202-220`）。

虽然 OpenWiki 没有在 createDeepAgent 参数中手写 subagents，但 DeepAgents 1.10.8 默认：

- 为主 Agent 加 todo、filesystem、subagent 和 summarization middleware；
- 自动加入 general-purpose subagent；
- 为每个 child 加自己的 todo、filesystem 和 summarization middleware（[DeepAgents agent.ts 1.10.8](https://github.com/langchain-ai/deepagentsjs/blob/deepagents%401.10.8/libs/deepagents/src/agent.ts#L253-L355)）。

其 task tool 给 child 一条新的 task message，不传 parent messages；child 完成后只把最终 structured response 或最后一条消息带回父线程（[DeepAgents subagents.ts 1.10.8](https://github.com/langchain-ai/deepagentsjs/blob/deepagents%401.10.8/libs/deepagents/src/middleware/subagents.ts#L680-L745)）。官方工具说明也把 isolated context、parallel calls 和 single final report 作为目的（[DeepAgents subagents.ts](https://github.com/langchain-ai/deepagentsjs/blob/deepagents%401.10.8/libs/deepagents/src/middleware/subagents.ts#L70-L115)）。

DeepAgents 还会根据模型 profile 在约 85% context 时触发 summary，缺少 profile 时回退到 170k token；默认保留约 10% 或最近 6 条消息（[summarization.ts](https://github.com/langchain-ai/deepagentsjs/blob/deepagents%401.10.8/libs/deepagents/src/middleware/summarization.ts#L174-L227)）。

但 OpenWiki 仍有三个缺口：

- 默认 child 没有自己的 SubAgentMiddleware，因此只是一层 main → child，不是真正递归树；
- child 与 main 使用同一个 backend，read-only 主要靠 prompt，而不是独立 mount 权限；
- init/update 使用内存 checkpointer，不能作为可靠跨进程恢复。

可复用结论：**主 Agent 保持页面计划和唯一写作权，subagents 做隔离调查并返回 concise receipts，自动 summary 只是兜底。**

### 2.2 open-knowledge：plan 跨 compaction，成果分段落盘

OpenKnowledge 本身不是 LLM runtime。它通过 MCP workflow 返回一份计划文本，由 Claude、Codex 等宿主 Agent 执行（`refs/open-knowledge/packages/server/src/mcp/tools/workflow.ts:1-18,53-138`）。

它的 research workflow 把“上下文过长后忘记任务”当作已观察到的故障：

- 第一动作必须建立八个有依赖关系的 host tasks；
- tasks 明确用于跨 context compaction 保持步骤和进度；
- 所有步骤有硬 gate 和状态迁移（`refs/open-knowledge/packages/server/src/mcp/tools/research-body.ts:38-52,76-99`）。

它也明确禁止把昂贵研究只留在上下文：

- source 获取后立即 ingest；
- article skeleton 提前创建；
- 每读完一个 source 就把该部分 findings 写入文章；
- compaction 或 crash 后重新读取部分成果继续（`refs/open-knowledge/packages/server/src/mcp/tools/research-body.ts:65-72`）。

codebase wiki workflow 本身仍是单宿主 Agent，只有 scope 和 page-list STOP gates，没有内部 subagent runtime（`refs/open-knowledge/packages/server/src/mcp/tools/wiki-body.ts:67-88`）。它要求源码由 native tools 读取、Wiki 只能由受控 MCP write/edit 写入（`refs/open-knowledge/packages/server/src/mcp/tools/wiki-body.ts:23-31`），并用 source_commit 与 append-only log 作为跨 run receipt（`refs/open-knowledge/packages/server/src/mcp/tools/wiki-body.ts:133-157`）。

可复用结论：**plan 必须独立于长消息历史，重要中间成果必须持久化；“summary 之后还能继续”依赖可重读 receipts，不应只相信 summary 不丢细节。**

### 2.3 knowledge-catalog/okf：独立 sessions + 有界 web crawl + bottom-up reduce

ReferenceRunner 为每个概念创建新的 UUID session，逐概念运行 BQ Agent；web pass 再使用另一个独立 session（`refs/knowledge-catalog/okf/src/reference_agent/runner.py:188-257`）。

每个概念的 prompt 只负责一个概念和一次最终写入（`refs/knowledge-catalog/okf/src/reference_agent/prompts/reference_instruction.md:1-16`）。因此概念之间不会共享不断膨胀的 conversation；共享状态通过 bundle 文件完成。

web crawl 虽写着 recursively，但它是 URL 图递归，不是 subagent：

- host state 持有 visited、fetched_count、url_depth 和 max_depth（`refs/knowledge-catalog/okf/src/reference_agent/tools/context.py:15-24`）；
- fetch_url 在工具边界强制 allowed hosts、max pages、reachable-from-seed 和 max depth（`refs/knowledge-catalog/okf/src/reference_agent/tools/web_tools.py:29-100`）。

最终索引按目录深度从叶到根生成，父目录只消费 child title/description；需要时用一次短模型调用把目录压成一句话（`refs/knowledge-catalog/okf/src/reference_agent/bundle/index.py:49-103`、`refs/knowledge-catalog/okf/src/reference_agent/bundle/synthesizer.py:7-50`）。

它没有 subagent、parallelism、planning 或自动 compaction，但展示了另一条关键原则：

**大输入不应汇入一个全局上下文；先隔离 leaf work，再逐层 reduce 为父级可消费的短摘要。**

### 2.4 refs 的共同结论

| 项目 | Planning | 隔离上下文 | 并行/委派 | 压缩/恢复 | 最终综合 |
|---|---|---|---|---|---|
| openwiki | todo + 临时 plan 文件 | child task run | 一层动态 subagent | 自动 summary + checkpointer | main 唯一写作者 |
| open-knowledge | 跨 compaction tasks | 由宿主提供 | 项目不提供 runtime | 分段落盘，可重读 | 宿主 Agent |
| knowledge-catalog/okf | 固定 per-concept workflow | 每概念新 session | 顺序，无 subagent | 文件 receipts + bottom-up index | 分层 reduce |

没有一个 ref 已经实现真正的递归 subagent 树；这是当前建议新增的能力。但三个 refs 一起已经否定“Planning 足够、SubAgents 后置”的判断。

## 3. Harness v0.7.0 的准确能力边界

### 3.1 Planning：目标连续性，不是执行器

Planning 的官方问题定义就是“long agentic runs drift”；它通过 write_plan 维护整份 plan，并在每次模型请求尾部注入不进入 durable history 的 ephemeral reminder（[Planning README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/planning/README.md#L16-L27)）。

源码行为：

- for_run 为每次 Agent.run 建立独立 PlanState；
- reminder 放在 request 尾部，位于 cache breakpoint 之后；
- reminder 不写回 message_history，因此不会累积旧计划（[Planning capability](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/planning/_capability.py#L56-L96)）。

限制：

- 只跟踪 content + pending/in_progress/completed/cancelled；
- 不调度 worker；
- 不强制依赖关系；
- 不跨 run durable；
- “一个 in_progress”只是提示，不是硬验证（[Planning toolset](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/planning/_toolset.py#L30-L76)）。

因此 Planning 现在必须启用，但它只解决“父 Agent 在 compaction 后仍记得目标、阶段和剩余工作”。它不能解决 source evidence 容量。

### 3.2 SubAgents：真正提供隔离 context，也支持树

SubAgents 暴露 delegate_task(agent_name, task)。每次调用是新的 Agent.run，child 有独立 message history，看不到 parent conversation，所以 task 必须自包含（[SubAgents README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md#L16-L23)、[tool contract](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md#L42-L58)）。

递归语义要准确区分：

- inherit_tools=True 会过滤父级 delegate_task，避免“自动继承同一个委派工具”；
- 但 child Agent 可以自己配置 SubAgents；
- 官方明确写明 sub-agents can themselves have SubAgents, forming a tree（[SubAgents README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md#L180-L216)）。

因此可实现：

parent producer → area researcher → leaf researcher

每层是否继续拆分由该层模型动态决定；可用 roster 和权限仍由 host 静态定义。这不是运行时任意生成未知 Agent。

关键边界：

- delegate_task 最终向 parent 返回 str(result.output)，不是 typed object（[SubAgents source](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/_toolset.py#L205-L293)）；
- max_calls 是“每个 delegate、每个 parent run”的计数；嵌套树每层独立重置，不是全树上限；
- per-delegate usage_limits 会切换为 child 独立 accounting，child token 不再聚合进 parent usage；
- 不设置 per-delegate limit 时，usage counter 默认共享，但 parent 的 UsageLimits 值并没有传入 child run，因此不能把它当作 child 内部每一步的硬 stop；
- timeout 和 max_calls 达到后返回 soft steering result；共享 usage 耗尽和 control-flow errors 仍可传播（[SubAgents controls](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md#L60-L101)、[dispatch source](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/_toolset.py#L195-L293)）。

这意味着：**Harness 支持递归树，但没有内置全树 max_depth 或 exact global call budget。安全递归必须由 host topology 和预算共同限制。**

### 3.3 CodeMode + Planning + SubAgents

CodeMode 默认会把普通 capability tools 折叠进 run_code。nested calls 仍走标准 ToolManager 和 capability hooks，因此 write_plan 和 delegate_task 都能在 sandbox 中调用（[CodeMode dispatch](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/_toolset.py#L336-L452)）。

组合后父模型可以在一次 run_code 中：

- 用 asyncio.gather 并行调用多个 delegate_task；
- 在脚本内筛选、排序或压缩 child receipts；
- 只把脚本最后的聚合值送回 parent context；
- 从 run_code metadata 观察 nested calls/returns（[CodeMode observability](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/README.md#L159-L169)）。

这已经覆盖递归委派的第一版动态 fan-out；DynamicWorkflow 只在 Domain→Leaf 需要 typed 同构 fan-out/reduce 时提供更清晰的协调边界。

实践约束：

- run_code 最后必须只返回 bounded receipts，不能把完整 child traces 或源码重新拼回 parent；
- trace/eval 需要读取 nested metadata，否则 child work 会变成不可见黑箱；
- compaction 看到的顶层工具是 run_code，因此 receipt 应先写入 scratch，再允许清理旧 run_code result。

### 3.4 DynamicWorkflow：leaf coordination，不是递归主干

DynamicWorkflow 让模型在一个 run_workflow 中写 Monty Python，把 named subagents 当 async functions，表达 fan-out、chain、vote 和 loop；intermediate results 不进入 parent context（[DynamicWorkflow README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L18-L35)、[comparison](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L52-L66)）。

它的优势：

- max_agent_calls 是同一 parent run 内所有 run_workflow 共享的 exact direct-child call cap；
- child typed output 在脚本中保留为 dict；
- 中间 candidate/review 结果不污染父上下文（[budgets](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L309-L349)）。

但它不适合作为本次递归骨架：

- nested run_workflow 会被 ContextVar 拒绝；并行 child 也继承该标志（[source](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/_toolset.py#L41-L44)、[no nesting](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L381-L389)）；
- child technically仍可拥有 SubAgents，但这些 grandchildren 不计入 DynamicWorkflow 的 max_agent_calls，破坏简单的全局预算模型；
- parent run 的 usage_limits 不自动转成 child hard limits，必须设置 sub_agent_usage_limits；
- concurrent token budget 仍可能 best-effort overshoot；
- child input 目前只有 task: str；durable snapshots、structured child inputs 和 progress streaming 尚未发布（[planned](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L486-L494)）。

结论：SubAgents 负责有界递归；当 Domain→Leaf 是固定同构 fan-out/compare/reduce 且该层不再继续递归时，可使用 DynamicWorkflow。不能用它替代递归骨架。

### 3.5 Compaction、oversized output 与 RepoContext

Harness compaction 会在每次请求前修改并持久化 message history。TieredCompaction 先执行零 LLM 的清理，再在仍超限时总结（[Compaction README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/compaction/README.md#L12-L39)）。

推荐给 root 和每个非叶 child：

1. ClampOversizedMessages，防止单个模型 response/tool-call args 破坏下一请求；
2. ClearToolResults，先清理已持久化到 scratch 的旧工具结果，并清理旧输入 args；
3. SummarizingCompaction，仅在 cheap tiers 后仍超 target 时生成 summary；
4. Planning reminder 保留当前目标和步骤。

注意：

- SummarizingCompaction 是真实模型请求，usage 计入当前 run，且 summary call 没有自己的 token cap（[Compaction usage](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/compaction/README.md#L158-L174)）。
- DeduplicateFileReads 需要识别独立 file-read tool call；当前项目通过 mounted pathlib 在 run_code 内读取，通常无法按文件去重，因此不是首选。
- Oversized tool return 在进入历史时就可能造成问题；OverflowingToolOutput 可在产生时 truncate、spill 或 summarize，和事后 compaction 是不同层次（[Overflowing Tool Output](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/README.md#L12-L38)）。第一版至少应对 run_code 设置 bounded truncate/spill 策略。

RepoContext 不是压缩器。它会把仓库 CLAUDE.md/AGENTS.md 自动加载为 instructions（[RepoContext README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/context/README.md#L16-L49)）。当前产品明确把目标仓库里的 agent/Skill 文件视作不可信 source evidence（[run instructions](../../src/okf_wiki/host/lifecycle.py#L88-L99)），因此不能对 /source 启用 RepoContext autoload。

## 4. 最小但完整的建议架构

### 4.1 分层角色

| 层 | 职责 | 能力 | 写权限 |
|---|---|---|---|
| Root Wiki Producer | 保持全局目标/plan、分区、合并 receipts、选页面、写作、修复、完成 | Planning + CodeMode + SubAgents + TieredCompaction + overflowing-output guard | `/wiki` RW；`/analysis` 通过 Host receipt API；`/source`、`/skill` RO |
| Area/Domain Researcher | 调查一个 repo/package/domain/reader question；必要时继续拆分 | Planning + CodeMode + SubAgents + TieredCompaction + overflowing-output guard | `/analysis` 仅提交 Host 分配的 receipt/artifact；`/source`、`/skill` RO；无 `/wiki` RW |
| Leaf Researcher | 跟踪一个具体 entrypoint/call path/concept，返回证据 receipt | CodeMode + light compaction + overflowing-output guard | `/analysis` 仅提交自身 receipt/artifact 或只返回 ACK；`/source`、`/skill` RO；无 `/wiki` |
| Wiki Reviewer | 对已写页面做独立 source/citation/navigation review | Planning + CodeMode | /wiki、/source RO；无写权限 |

只有 Root 写 Wiki。Researcher 返回发现，不返回最终页面，也不修改 staging。Reviewer 只返回 defects receipt；Root 决定如何修。

### 4.2 一次 run 的完整流

1. Root 读取 Producer Skill，调用 write_plan，计划至少包含最终目标、完成门槛、inventory、research coverage、各 branch 状态、receipt 指针、page plan、write、independent review、repair、manifest。完整 evidence 不放进 plan。
2. Root 用 CodeMode 做低成本 inventory：repositories、top-level domains、entrypoints、manifests、existing docs、tests、diff。
3. Root 按“读者问题/模块边界/call path”创建 1–4 个自包含 research tasks，并行 delegate。
4. Area Researcher 为自己的 scope 建计划；若仍有两个以上独立子域且 depth 尚未用尽，再委派 0–2 个 Leaf Researchers。
5. 每个 leaf 只返回压缩 receipt；直接 parent 立即把 receipt 写入 /analysis/receipts，并在自己的 plan/summary 中引用 receipt id。
6. Area Researcher 合并 children，只向 Root 返回一个 area receipt。Root 不接收 grandchildren 的完整轨迹。
7. Root 从 receipts 形成 page plan；对最终页面中的 load-bearing、高风险或相互矛盾引用抽查并重新打开精确 source spans，避免把 child report 当权威，也不把完整 child trace 重新装回 root context。
8. Root 写 /wiki。
9. Reviewer 读取 /wiki 和对应 source，返回 defects receipt；Root 修复。
10. 现有 output validator 和 atomic publisher 保持不变。

这是一棵有界的语义 MapReduce 树：

source slices → leaf receipts → area receipts → page plan → final Wiki

### 4.3 Scratch receipts

增加一个每次 Wiki Run 独立、run 结束即删除的 `/analysis` read-write scratch mount；它不进入 manifest，也不发布。

每个 receipt 至少包含：

- task_id、parent_id、depth；
- scope 和 reader question；
- concise findings；
- evidence：repository id、path、one-based line range、该 span 支持的 claim；
- inspected coverage：实际看过的 directories/files/entrypoints；
- unresolved questions、contradictions 和 confidence；
- child receipt ids；
- suggested page/section relevance；
- status：complete、partial、budget_exhausted、failed。

初始上限：

- 每个 receipt 不超过 8,000 chars 或约 2,000 tokens；
- 最多 12 个 evidence items；
- 不复制长源码，只保留 path/line/claim；
- parent 收到后立即持久化，再把旧 tool result 交给 compaction；
- final writer 必须重读 load-bearing spans。

Scratch 解决的是“summary 丢细节后仍可按需恢复”；Planning 解决“还要做什么”；SubAgents 解决“在哪里做语义阅读”。三者不能互相替代。

### 4.4 保持现有 application seam

这次演进不需要扩大公共 API。`WikiRunApplication.run(request) -> WikiRunResult` 继续作为一次 Wiki Run 的唯一 application seam，保留现有 snapshot materialization、staging、output validation、atomic publication 和错误映射职责（[host/lifecycle.py](../../src/okf_wiki/host/lifecycle.py#L395-L560)）。

固定的 Root → Area/Domain → Leaf 无环拓扑、角色权限、capability 组合和 scratch 生命周期都应在 `run` 内部或私有构造函数中完成；模型只动态决定：

- 当前是否值得委派；
- 把哪些自包含 scope 交给已注册的 Area/Leaf/Reviewer；
- 是否在 host 允许的剩余深度和预算内继续拆分；
- 何时从调查切换到综合、写作和 review。

不要为此新增浅的 `Planner`、`Worker`、`Scheduler` 公共对象。Planning 是 capability state，SubAgents 是隔离执行机制，host topology 才是安全边界；把三者再包装成公共角色层只会扩大接口而没有隐藏新的复杂性。

## 5. 有界递归、安全和预算

### 5.1 深度与 fan-out

Harness SubAgents 没有 max_depth。第一版用静态 topology 强制：

- max_depth = 2：Root → Area → Leaf；
- Root 最多 B0 = 4 个 Area calls；
- 每个 Area 最多 B1 = 2 个 Leaf calls；
- 最多 child runs = B0 + B0 × B1 = 12。

这里的 12 只计算 research children；若独立 Wiki Reviewer 也通过 SubAgents 运行，整棵树最多 13 个 child runs。

正常默认只启动 1–2 个 Area；只有 inventory 证明存在 3–4 个真正独立的 repository/domain scope 时才扩到 3–4 个。上限不是默认 fan-out。

max_calls 在每层调用前同步递增，因此同一 parent 并行 fan-out 仍能精确限制该 delegate；但 12 这个全树上限来自 host topology，不是 Harness 自动提供。

如果 50,000 文件/500 MB 级输入仍超过这个 envelope，优先让 host 做确定性 repository/domain 分区并创建 fresh sessions，再让各 session 产生可归约 receipts；不要靠同一个通用 researcher 无限自引用或继续加深树。

### 5.2 Token、request、time 与 concurrency

Harness 0.7.0 的 usage 有两种不能同时获得的模式：

1. **共享聚合模式**：保持 `forward_usage=True` 且不设置 `SubAgent.usage_limits`。child 会写入 root 的 `ctx.usage`，最终结果能聚合全树 usage；但 Harness 调用 child 时传的是 `usage_limits=None`，并没有把 root 自定义的 token/tool limits 原样传给 child。root 通常要等 child 返回、恢复到自己的下一次边界才发现累计超限，因此这只是聚合 accounting 和父边界软上限，可能被一个长 child 或并发 children 明显超调。
2. **局部硬预算模式**：给每个 `SubAgent` 设置自己的 `usage_limits`。child 获得独立 request/token/tool budget，耗尽后返回 soft outcome；代价是该 child 使用 `usage=None`，token 不再聚合进 root result，必须由 instrumentation/event collection 另行汇总全树成本。

Harness 0.7.0 没有同时提供“严格 per-child budget”和“精确 root 聚合”的 SubAgents 配置。第一版更安全的选择是局部硬预算模式，并按固定 topology 的最坏调用数预先计算全树 envelope；若选择共享聚合模式，则必须明确接受 child overshoot，并靠限深、fan-out、timeout 和 concurrency 限制爆炸半径。

无论选择哪种 usage 模式，递归树都必须同时配置：

- per-delegation timeout_seconds；
- per-delegate max_calls；
- Root 现有全 run wall-clock timeout；
- child Agent 的 max_concurrency/backpressure；
- scratch bytes/file quota；
- bounded receipt output。

`max_calls` 只按“delegate name + 当前 parent run”计数，各递归层独立重置；它不能单独阻止无限递归。真正的全树节点上限来自无环固定 topology、最大深度和每层 fan-out 的乘积。

第一版采用以下有界 profile；它不是永久常量，live eval 只允许在不突破全树 envelope 的前提下调整：

- 现有 350k total-token limit 应继续视为整个 Wiki Run 的产品 envelope，而不是仍全部留给 Root 后再额外叠加 child 预算；request/tool limits 也应采用同样的全树口径；
- 按正常默认 `B0 = 2`、`B1 = 2` 分配：Root 18 requests / 150k total tokens；两个 Area 各 6 requests / 25k / 120s；四个 Leaf 各 3 requests / 18k / 90s；Reviewer 5 requests / 30k；
- 该示例合计 47 requests / 302k tokens，保留 3 requests / 48k tokens 给额外 summary calls、失败恢复和 response overshoot；
- 若 inventory 需要把 B0 提高到 3–4，host 必须重新压缩每个节点的预算或显式提高全树产品 envelope，不能沿用上述每节点额度；
- global child concurrency 先限制在 4。

这是 envelope 分配示例，不表示这些额度已经经过质量验证；最终值应由 live eval 调整。局部独立 accounting 时，host 必须把各 run 的实际 usage 聚合并在 dispatch 前拒绝会突破剩余全局 envelope 的新 child。Exact guarantee 只有 request count、per-parent max_calls、host depth/topology 和 wall-clock；token limits 因响应后检查而可能超过一个 response。

### 5.3 权限与不可信输入

必须：

- SubAgents(agent_folders=None)，禁止默认扫描 cwd 下的 .agents/agents 或 .claude/agents；
- 显式构造 trusted child roster；
- inherit_tools=False；
- 为每个 role 构造自己的 CodeMode mounts，不能把 Root 的 /wiki RW capability 共享给 researchers；
- /source 和 /skill 始终 RO；
- researcher 只写 /analysis；
- reviewer 对 /wiki 只读；
- target repo 的 AGENTS.md、CLAUDE.md、Skills 只作为 source evidence，不转成 child instructions；
- `/analysis` receipt 也始终是不可信 evidence/data，不是新的 instructions 层；schema 限制允许字段、自由文本长度和 evidence 数量，parent 不得执行 receipt 中转述的 target-repo 指令；
- `/analysis` receipt name 使用 host-issued task id，防止并行覆盖；
- child failure、timeout 和 budget exhaustion 进入 receipt/status，不能被当成 coverage complete。

## 6. 何时委派、何时递归、何时压缩

以下是第一版可执行触发阈值，之后由 eval 校准：

下文的 C 指单次模型请求可安全使用的 context target，必须来自受支持的 model profile，或新增显式 `context_target_tokens` 配置。它不能用当前累计 `input_tokens_limit` 代替；若没有可信的 C，就只使用 repository/domain 数量、文件规模和已发生 compaction 等确定性信号，不猜模型窗口。

### Root 启动 SubAgents

满足任一条件：

- Repository Snapshot Set 有两个以上 repositories；
- inventory 发现三个以上 substantial top-level domains/packages；
- text-like estimate 超过模型 context C 的 25%；
- 有三个以上可独立回答的 reader questions/call paths；
- refresh diff 同时触及两个以上独立 packages/boundaries；
- Root 已经进行一次 compaction，但仍有两个以上未完成调查 scope。

小型、单域、预计不超过 0.25C 的仓库可继续直接由 Root 处理，避免不必要延迟。

### Area 继续递归

同时满足：

- depth < 2；
- scope 内仍有至少两个相互独立的子域；
- scope text-like estimate > 0.15C，或预计需要超过约 10 个 substantive file reads；
- 剩余 max_calls、token 和 wall-clock budget 足够。

否则 Area 自己完成并返回 receipt。

### Compaction

- history estimate 到 0.60C：运行 cheap tiers，目标压回约 0.50C；
- 到 0.70C：LimitWarner 提醒收束当前 scope；
- cheap tiers 后仍超过 target：SummarizingCompaction；
- 每次 compaction 前，所有 load-bearing child results 必须已经写入 /analysis；
- compaction 后先读 Planning reminder，再按需读 scratch receipt，不重新遍历整个 source。

### 停止调查

当且仅当：

- 每个 planned page 都有至少一个 area receipt；
- 每个 load-bearing claim 都有可重开的 source span；
- unresolved/partial receipts 已进入 backlog、页面 caveat 或补充 task；
- 新一轮 delegation 不再改变 page set、architecture boundary 或关键 flow；
- budgets 尚未被误报为 complete。

## 7. 现在启用与后置

| 能力 | 决策 | 原因 |
|---|---|---|
| CodeMode | 保留 | 单 Agent 内批量 filesystem 调查、并行 delegation 和聚合仍有价值 |
| Planning | 现在启用，Root + Area | 计划 reminder 在 compaction 后继续存在，直接解决 long-run drift |
| SubAgents | 现在启用 | 大仓库需要新的隔离 context，不是可选 specialist 装饰 |
| 两层递归树 | 现在启用 | Area scope 也可能超上下文；host topology 可安全限制 |
| Scratch receipts | 现在启用 | compaction 后可恢复证据，避免完成研究只存在消息历史 |
| TieredCompaction | 现在启用 | Root 和 child 都可能长 run；summary 应是 cheap cleanup 后的兜底 |
| Oversized run_code guard | 现在启用 | 单个巨大 tool return 可在 compaction 前先击穿上下文 |
| Child usage/trace collection | 现在启用 | 否则成本、失败、depth 和 coverage 不可评估 |
| DynamicWorkflow | 允许单层启用 | 仅用于 Domain→Leaf 的同构 fan-out/reduce；不能作为可预算的递归主干，也不能嵌套 DynamicWorkflow |
| StepPersistence / durable execution | 后置 | 只有需要 crash/redeploy resume 时；临时 scratch 不提供 durability |
| RepoContext autoload | 不启用 /source | 会把不可信目标仓库 instructions 升格为控制指令 |
| RuntimeAuthoring | 不启用 | 不应允许生产 model import 自己写的宿主 Python |

## 8. 评估与上线门槛

当前 live-eval 只有 repository manifest，没有提交到仓库的、可复核的真实 large-run report 足以证明单 Agent 已覆盖 open-knowledge。实施前后应使用同一 model、snapshot、skill digest 和输出 validator，跑三臂对照：

1. A：当前 CodeMode only；
2. B：CodeMode + Planning + compaction；
3. C：CodeMode + Planning + bounded SubAgents tree + scratch + compaction。

至少覆盖 openwiki、iwe、open-knowledge 和一次多仓库组合，并重复运行。

### 质量指标

- human semantic grounding：引用是否真的支持 claim；
- expected-topic coverage 与重要 boundary/flow coverage；
- unsupported claim rate；
- missing-domain/backlog quality；
- page purpose、navigation、duplication 和 cross-domain synthesis；
- reviewer defects / page；
- page-plan 与最终 manifest 的一致性。

### Context 与 orchestration 指标

- Root peak input tokens/request；
- Root total input tokens；
- child total tokens、requests 和 cost，必须全树聚合；
- compaction 次数、前后 tokens、summary 后重新读取 receipt 次数；
- delegation count、实际 max depth、fan-out、parallelism；
- receipt chars/tokens、child raw usage → receipt compression ratio；
- duplicate scopes、contradictory receipts、re-delegation count；
- timeout、budget_exhausted、contained failure 比例；
- Root 为最终 claim 重读 source span 的比例。

### 运行指标

- total wall time 与 critical-path child time；
- provider concurrency peak；
- cache read/write tokens；
- scratch bytes 和 cleanup 成功率；
- child 对 /wiki 或 /source 的违规写尝试必须为 0；
- repeated-run material stability 和 page-set Jaccard。

### 初始成功门槛

C 相对 A 在 large/multi-repo cases 上应同时满足：

- semantic coverage 和 reader usefulness 有明确人工提升；
- unsupported claims 不上升；
- Root peak context 显著下降；
- 全树成本和延迟在配置预算内；
- 无越权写入、无无界递归、无未计量 child usage；
- small case 不因默认 fan-out 明显变慢，因此 scale trigger 生效。

Planning 的价值由 B 对 A 识别；SubAgents 的增量价值由 C 对 B 识别。不要再次把两者混成一个“是否需要 specialist”的问题。

## 9. 最终判断

用户的修正是对的：

- Planning 是父 Agent 的控制平面，使目标、阶段和剩余任务在长 run 与 compaction 后仍可见；
- SubAgents 是语义数据平面，用独立上下文承载大规模阅读；
- recursive SubAgents 让过大的 child scope 继续分层，但必须静态限深；
- receipts + scratch 是跨 compaction 的证据记忆；
- compaction 是每个上下文的兜底，不是替代 delegation；
- Root 唯一写作保证内容一致性和安全边界；
- DynamicWorkflow 可作为单层 leaf coordination，但不是当前递归答案。

因此当前架构不应继续把“单 Agent 足够”作为默认假设。最小演进不是只加 Planning，而是：

**CodeMode + Planning + bounded recursive SubAgents + scratch receipts + TieredCompaction + single writer + full-tree budgets/observability；Domain→Leaf 的同构协调可再使用单层 DynamicWorkflow。**
