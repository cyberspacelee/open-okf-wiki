# Agent 控制面、Prompt、Tool 与 Citation 校验

日期：2026-08-20

## 范围与证据边界

本文只使用 Anthropic、Amp 与 OpenAI 的官方工程文章、产品手册和 API 文档，回答四个问题：

1. 状态与流程控制应该放在 TypeScript 等宿主代码，还是 prompt？
2. 是否适合由宿主提供基础能力，再让 agent 调用脚本 / tool？
3. Citation 能否做静态检查，静态检查能证明到什么程度？
4. 如何把这些机制变成可回归的 agent eval？

本文不审计本仓库的当前实现；“建议”是根据一手资料对本仓库场景作出的工程推论。Amp 手册描述的是产品能力，不等同于一篇受控实验报告；本文只用它证明 Amp 实际暴露了哪些控制面。

一手来源：

- Anthropic：[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)、[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)、[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)、[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)、[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)、[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[Citations API](https://platform.claude.com/docs/en/build-with-claude/citations)
- Amp：[Owner's Manual](https://ampcode.com/manual)、[Plugin API](https://ampcode.com/manual/plugin-api)、[Bring Your Own Tools](https://ampcode.com/news/toolboxes)、[How We Think About Permissions](https://ampcode.com/notes/permissions)
- OpenAI Docs：[Model guidance](https://developers.openai.com/api/docs/guides/latest-model)、[Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals)、[Graders](https://developers.openai.com/api/docs/guides/graders)

## 结论

1. **不是“TS 或 prompt”二选一，而是硬约束与判断力分层。** 不可违背的状态转换、持久化、权限、预算、终止、重试、并发、幂等、发布门和机器可判定校验，应由宿主代码掌握；计划、搜索策略、任务分解、工具选择、内容综合和异常恢复策略可以交给 prompt。Anthropic 把沿预定义代码路径运行的系统称为 workflow，把模型动态决定过程和工具使用的系统称为 agent，并建议固定任务优先可预测 workflow，开放任务才扩大模型自主权。[来源](https://www.anthropic.com/engineering/building-effective-agents)
2. **“TS 提供基础能力 + prompt + script/tool”是主流且合理的组合。** Anthropic 把 tool 定义为确定性系统与非确定性 agent 之间的契约；Amp 则把 prompt/`AGENTS.md`、skills、注册 tool、事件 hook、权限 policy 做成不同层。[Anthropic 来源](https://www.anthropic.com/engineering/writing-tools-for-agents)；[Amp 来源](https://ampcode.com/manual)
3. **Citation 静态检查值得做，但不能把“链接有效”误称为“引用准确”。** 静态程序可以完整判定格式、引用目标、范围、固定版本、摘录一致性和覆盖规则；“这段来源是否真的支持该 claim”仍是语义判断，应交给独立 citation reviewer / LLM grader，并用人工抽样校准。[Anthropic eval 来源](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
4. **生成流程与质量评估应分开。** 运行时 validation gate 防止明显坏产物进入下一阶段；离线 eval 用固定任务集、多次 trial、完整 transcript 和 outcome graders 比较 prompt、tool、模型与 harness 版本。不要只根据最终自然语言自报的“完成”判断成功。[来源](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
5. **OpenAI 的当前建议也支持“有界程序化处理 + 明确交接 + 独立最终验证”。** Programmatic Tool Calling 适合过滤、连接、排序、去重、聚合和 validation 等可预测处理；route 应明确允许的 tools、输出 schema、证据、重试和停止条件，而最终输出若必须保留 citation，则应留给直接调用和最终验证。[来源](https://developers.openai.com/api/docs/guides/latest-model)

## 1. Prompt 与宿主代码的边界

### 1.1 一手资料给出的共同方向

Anthropic 的基本区分很清楚：workflow 的路径由代码预先编排，agent 的路径由模型动态决定。Prompt chaining 可以在中间插入 programmatic gate；agent loop 则应从工具或代码执行获取环境 ground truth，并配置停止条件、沙箱与 guardrails。它的最终建议是先用简单 prompt，只有在 eval 证明收益后才增加多步复杂度。[来源](https://www.anthropic.com/engineering/building-effective-agents)

长任务进一步说明，单靠上下文和 prompt 不能承担 durable state。Anthropic 的 long-running harness 让首个 session 创建结构化 feature list、progress file 和 git baseline，后续 session 一次推进一个 feature，并留下可恢复的环境状态。其 feature 状态最终选择 JSON，且限制 agent 只改 `passes` 字段；这是“prompt 规定行为 + 文件承载状态 + harness 保持会话”的组合，而不是把真实状态藏在模型记忆中。[来源](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

Anthropic 的多 agent research 系统同样把搜索启发式、effort scaling 和工具选择写进 prompt，但把持久执行、从失败点恢复、错误传播、状态一致性、guardrails 与 observability 视为工程系统问题。[来源](https://www.anthropic.com/engineering/multi-agent-research-system)

Amp 的当前手册呈现了相同分层：

- Prompt 和 `AGENTS.md` 提供任务意图、代码库约定、测试命令和常见错误提示；官方建议明确说出目标、已知文件/命令及如何复核结果。[来源](https://ampcode.com/manual)
- Plugin 是 TS/JS 宿主程序，可监听 `session.start → agent.start → tool.call → tool.result → agent.end` 生命周期，可在 tool call 前允许、拒绝、修改或直接合成结果。[来源](https://ampcode.com/manual)
- Amp thread 对外暴露 `idle`、`running`、`awaiting-approval`、`error` 状态；`agent.end` hook 可以自动续一轮，并特别要求使用 marker/guard 防止无限循环。[来源](https://ampcode.com/manual/plugin-api)
- 权限策略由程序读取 tool 参数并用退出码决定 allow / ask / reject，而不是只提示模型“不要执行”。[来源](https://ampcode.com/notes/permissions)

因此，“流程步骤写在 prompt 中”本身没有问题；问题在于是否把必须可靠执行的协议也只写在 prompt 中。例如“先研究、再写作、最后 review”可以是 agent 策略；但“review 未通过不得 publish”应是 host gate。

OpenAI Docs 进一步建议保持 prompt 与 tool surface 精简，只暴露任务相关工具；对程序化工具调用明确 bounded stage、output schema、required evidence、retry 和 stopping limits，并把需要语义判断、审批或 citation 保真的步骤留在直接调用路径。这与“host 定义能力和边界，prompt 在边界内动态决策”一致。[来源](https://developers.openai.com/api/docs/guides/latest-model)

### 1.2 推荐职责表

| 层 | 应负责 | 不应独自负责 |
|---|---|---|
| TS / host harness | 权威状态、状态转移、run/session 身份、持久化、幂等键、并发与锁、超时/重试/取消、权限、预算、最大轮数、schema/path 校验、发布门、审计日志 | 开放问题的完整搜索路径、所有内容判断 |
| Prompt / `AGENTS.md` / skill | 角色、目标、完成定义、领域启发式、计划与分解、工具选择准则、失败后如何调整、输出语义要求 | 权威状态、不可绕过权限、唯一性/事务性、强制发布条件 |
| Tool / script | 检索、解析、规范化、读写受控资源、hash、lint、测试、构建、索引、结构化结果、可复现验证 | 决定整个开放任务的下一步策略 |
| Model reviewer | 语义支持度、遗漏、矛盾、来源质量、内容组织等开放判断 | URL/路径是否存在、span 是否越界等可确定判定 |
| Eval harness | 固定任务、环境、trace、outcome、grader、重复 trial、指标与回归比较 | 直接成为生产时的权威状态机 |

这是本文根据上述资料作出的设计归纳，不是任何一家厂商给出的固定框架。

### 1.3 状态至少分三类

建议不要把所有“状态”混成一个对象：

| 状态 | 例子 | 所有者 |
|---|---|---|
| 权威业务状态 | run phase、source pin、candidate revision、review verdict、publish revision | 持久化 store + host API |
| 执行瞬时状态 | active tool call、in-flight worker、retry count、deadline、cancel signal | harness runtime；必要部分 checkpoint |
| 推理工作记忆 | 当前计划、待查问题、线索、临时摘要 | prompt/context、progress artifact 或 memory |

Anthropic 的 context engineering 把 context 描述为 system instructions、tools、MCP、外部数据、message history 等共同组成，并推荐 compaction 与结构化 note-taking / external memory；这支持把推理记忆外置，但不表示这些 notes 自动成为业务真相。[来源](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

## 2. Tool 与脚本如何设计

### 2.1 Tool 是能力边界，不只是 shell 的别名

Anthropic 建议先做小原型，再用真实任务 eval tool；tool 应围绕高价值 workflow 划分清晰 namespace，返回高信号且 token-efficient 的上下文，并通过过滤、分页、截断避免把大量无关数据塞进模型 context。更多 tool 不一定更好，机械包装每一个底层 API 往往降低可用性。[来源](https://www.anthropic.com/engineering/writing-tools-for-agents)

这意味着本项目的 tool 最好表达领域动作，例如 `validate_candidate`、`resolve_citation_target`、`publish_if_valid`，而不是向模型暴露大量要求其自行拼装、保持事务顺序的低层文件操作。Tool 内部可以调用现有 TS domain functions 或脚本；模型看到的是小而稳定的 schema、明确副作用与紧凑结果。

Amp 的官方 toolbox 方案展示了最低成本形态：可执行文件在 `describe` 时输出 tool 名、说明和参数，在 `execute` 时从 stdin 接收 JSON 并运行确定性逻辑。[来源](https://ampcode.com/news/toolboxes) 当前 Amp plugin API 则可用 `amp.registerTool(...)` 注册带 JSON schema 的 TS/JS tool，并通过 lifecycle hook 观察或修改调用与结果。[来源](https://ampcode.com/manual/plugin-api)

### 2.2 推荐 tool contract

一个 production tool 至少应明确：

- 输入 schema、默认值、允许路径和最大规模；
- 是否只读、会写哪些资源、是否可重试；
- 稳定的成功/失败 code，而不只是一段自然语言；
- `changed`、`warnings`、`errors`、`artifacts`、`next_allowed_actions` 等结构化结果；
- 幂等键或版本前置条件，避免 retry 重复发布；
- 输出上限与详细日志 artifact，避免完整日志污染 context；
- AbortSignal / deadline，以及 host 记录的 trace metadata。

这里是工程建议。其依据是 Anthropic 要求 tool 提供清晰契约、高信号响应并接受程序化 eval，以及 Amp 用 typed schema、事件和权限层包围 tool execution。[Anthropic 来源](https://www.anthropic.com/engineering/writing-tools-for-agents)；[Amp 来源](https://ampcode.com/manual/plugin-api)

### 2.3 Prompt、skill 和 tool 可以组合

Amp skill 由 `SKILL.md` 加可选 scripts、templates、references 组成；name/description 常驻可见，正文只在触发 skill 时加载，skill 专属 MCP tool 也可保持隐藏直到 skill 被加载。[来源](https://ampcode.com/manual) 这给出一个实用组织方式：

1. Skill prompt 描述“何时做 citation review、如何解释结果”。
2. Script 静态解析文档和 source manifest，输出 JSON diagnostics。
3. 注册 tool 为模型提供受控入口。
4. Host validation/publish path 再直接调用同一 domain function，保证发布门不依赖模型是否自觉调用 tool。

最后一点很重要：把 validator 暴露成 tool 有助于 agent 自修复；但真正的 gate 仍应由 host 强制执行。否则 agent 忘记调用 tool 时，校验等于不存在。

## 3. Citation 校验应该拆成三层

### 3.1 第一层：确定性 citation lint

静态 checker 可以可靠检查：

- citation 语法和必填字段；
- source ID 是否在本 run 的 pinned source set；
- repo/revision/path 是否存在，是否逃逸允许目录；
- line/block/char span 是否为合法范围；
- `cited_text` 是否与固定 revision 的原文完全一致，或其 hash 是否匹配；
- 同一 citation ID 是否冲突，是否存在孤儿 citation；
- 要求引用的 claim 是否缺 citation；
- source 类型、域名或 freshness 是否违反显式 policy；
- 网络 URL 当下是否可访问。

最后一项只证明“现在能访问”，不能证明内容正确、稳定或支持 claim。对于 Git source，优先保存不可变 revision + path + span/hash；对于 web source，最好在 run 中捕获不可变 snapshot，再对 snapshot 校验。这是本文基于 durable state 与精确 pointer 机制的推论。

Anthropic Citations API 的结构化 citation 会直接指向输入 document 的 page、character 或 content-block 范围；官方明确说这种机制保证 pointer 指向提供的文档，并且比纯 prompt citation 更可能选到相关段落。[来源](https://platform.claude.com/docs/en/build-with-claude/citations) 这个保证仍不等于任意复杂 claim 已被该段文字充分蕴含，因此不应跳过下一层。

### 3.2 第二层：语义 citation reviewer

Anthropic 的 research 系统把主研究完成后的 citation 定位交给独立 CitationAgent；其 eval rubric 分开评价 factual accuracy、citation accuracy、citation completeness、source quality 与 tool efficiency。[来源](https://www.anthropic.com/engineering/multi-agent-research-system) 推荐对每个原子 claim 和 cited excerpt 输出：

```json
{
  "claim_id": "C-017",
  "verdict": "supported | partially_supported | contradicted | not_found",
  "supporting_spans": ["..."],
  "missing_qualifiers": [],
  "reason": "...",
  "confidence": 0.0
}
```

语义 reviewer 最好看固定 source excerpt，而不是只看标题和 URL；reviewer 与 writer 分离，避免同一个模型重复确认自己的判断。可以把低置信度、partial/contradicted、二手源替代一手源等情况送回 writer 修订。

### 3.3 第三层：人工校准与抽样

Anthropic 的 agent eval 指南建议组合 code-based、model-based 和 human graders。Code-based grader 快、便宜、客观、可复现，但对开放语义缺少 nuance；model grader 更灵活但非确定、成本更高，且需要用 human grader 校准。[来源](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

因此 production 可以采用风险分层：

- 静态 critical error：直接阻断 publish；
- 语义 `contradicted` / `not_found`：阻断或退回修订；
- `partially_supported` / 低置信度：进入人工队列；
- 已通过样本：仍周期性人工抽样，用于估计 reviewer 的 false positive / false negative。

### 3.4 不要用“自检 prompt”替代独立校验

让 writer prompt 加一句“确保 citation 准确”有帮助，但它既不能强制 tool 被调用，也不产生独立证据。Amp 的 checks 是 Markdown 定义的团队 review criteria，并为每个 check 启动独立 subagent；它适合表达 linters 难覆盖的约定，但本质仍是 model review，不是确定性 lint。[来源](https://ampcode.com/manual)

更稳妥的流水线是：

```text
writer
  -> deterministic citation lint
  -> semantic citation reviewer
  -> host aggregates verdicts
  -> repair loop (bounded)
  -> publish gate
```

Repair loop 必须有最大轮数、相同错误检测和人工升级路径；Anthropic 建议 agent 包含 stopping conditions，Amp 的 `agent.end` 自动续轮示例也明确要求 marker/guard 防无限循环。[Anthropic 来源](https://www.anthropic.com/engineering/building-effective-agents)；[Amp 来源](https://ampcode.com/manual/plugin-api)

## 4. Eval：验证的是 model + prompt + tools + harness

Anthropic 将 agent harness 定义为处理输入、编排 tool calls 并返回结果的系统；评估“agent”时，实际评估的是 harness 与 model 的组合。每个 trial 应保存完整 transcript/trajectory，并区分模型最后声称的结果与环境真实 outcome。[来源](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

对 citation agent，建议最小 eval 集包含：

| 任务类型 | 确定性 grader | 模型 / 人工 grader |
|---|---|---|
| 正确引用 | pointer/span/hash、格式、source pin | claim 是否被完整支持 |
| 错误引用 | checker 必须检出越界、错 source、篡改 excerpt | 必须识别不蕴含或矛盾 |
| 无需引用 | 不应制造 citation | 是否正确区分事实与观点 |
| 多来源综合 | 每个 citation 均合法、无孤儿 | 来源覆盖是否完整、是否遗漏限定条件 |
| 来源质量 | allow/deny policy、版本/freshness | 是否优先一手权威来源 |
| 修复流程 | 状态转移、最大轮数、无重复 publish | 修改是否解决原问题且未引入新误述 |

Anthropic 建议优先使用 deterministic grader，开放质量再用 LLM grader；不要过度规定唯一 tool-call 路径，因为 agent 可能找到其他有效路径。它还建议从 20–50 个真实失败任务开始，多次 trial，读 transcript，区分 capability suite 与接近 100% 通过率的 regression suite。[来源](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

OpenAI Docs 给出了相同的运行级观察面：trace 应覆盖 model calls、tool calls、guardrails 和 handoffs，trace grader 用于定位工作流问题；一旦“好”的标准稳定下来，再把案例固化为 dataset 和可重复 eval run。Grader 可以组合 string check、text similarity、model grader 与 Python code grader，因此 citation 的结构检查和语义支持度不必挤进同一种 evaluator。[Agent eval 来源](https://developers.openai.com/api/docs/guides/agent-evals)；[Grader 来源](https://developers.openai.com/api/docs/guides/graders)

Tool 本身也要 eval。Anthropic 建议用简单 agent loop 为每个任务运行一次，记录准确率、耗时、tool call 数、token 和 tool errors，并保留 held-out set 防止 tool description / prompt 对开发集过拟合。[来源](https://www.anthropic.com/engineering/writing-tools-for-agents)

## 5. 对本仓库的建议落点

下面是基于资料的目标架构，不是对当前代码已经如此的事实判断：

1. 保留 TS 作为唯一权威 control plane：`RunState`、允许的 transition、source pin、artifact revision、review verdict、publish gate 都只能通过 domain API 改。
2. 把 research/write/review 的步骤说明与领域 heuristic 放进版本化 prompt/skill；prompt 可以建议 next action，但不能直接宣布权威 phase 已完成。
3. 提供一组少而深的 tools：`read_source_at_revision`、`write_candidate_page`、`lint_candidate`、`verify_citations`、`submit_review`。Tool 复用 host domain functions，不复制规则。
4. `verify_citations` 分成确定性 `citation-lint` 脚本和独立语义 reviewer；输出统一 diagnostics schema，便于 UI、agent repair 和 CI 共用。
5. 每个不可逆或高风险 transition 都采用 compare-and-set / expected revision；retry 必须幂等，发布必须由 host 重新运行 validation，而不是信任 agent 上一次 tool output。
6. 保存完整 trajectory 和 outcome，但把稳定业务状态单独持久化；不要靠 chat history 反推当前 phase。
7. 建立小型 regression suite：从真实 citation 错误、状态越权、重复发布、修复死循环和 source revision 漂移开始，并对 model/prompt/tool/harness 任一改动运行。

一句话归纳：**让 prompt 决定“怎么想、下一步想做什么”，让 TS 决定“现在到底是什么状态、什么动作被允许、结果是否足以进入下一阶段”，让脚本证明可机械证明的事实，让独立 reviewer 评价语义。**
