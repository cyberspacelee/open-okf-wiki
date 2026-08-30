# Repo Wiki Skill 评测指标与流程

日期：2026-08-29

结论：repo-wiki 的评测应分成结果、轨迹、资源、可靠性、人工质量和评测有效性六层。
现有确定性 validator、CLI e2e 和 `grade_run.py` 适合充当结果硬门槛，但一次真实模型运行
只能用于发现流程问题，不能证明 skill 稳定。最小增量不是新建复杂的 LLM judge，而是为
每次运行保留完整 trace、usage/timing、阶段 Artifact 快照和固定人工 rubric，再对同一
冻结场景重复运行。

## 研究范围

本文研究生成文档类 agent/skill 的以下问题：

- task success 与 functional correctness；
- trajectory/process quality；
- token、cost、latency efficiency；
- tool-use errors 与失败恢复；
- repeatability 与 variance；
- human review 与 rubric；
- eval contamination、grader gaming 与 trace inspection。

建议专门针对 repo-wiki 当前的 `Capture -> Index -> Plan -> Composition -> Write ->
Review -> Publication` Artifact loop，不把通用 agent benchmark 的总分直接移植过来。

## 2026-08-30 官方文档与 Skill Creator 复审

本轮又按 OpenAI 当前官方文档和 `skill-creator` 检查了 skill，而不是只从本仓 trace
归纳规则：

- [Build skills](https://learn.chatgpt.com/docs/build-skills) 明确采用渐进披露：先以
  name/description 选择 skill，再读取完整 `SKILL.md`，最后按需读取 references。当前
  `Plan -> Composition -> Page -> Review` 分阶段加载 reference 的结构符合该原则；不把
  全部写作合同合回入口文件。
- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  建议删除重复指令、只暴露相关工具，并一次移除一组提示后在代表性任务上复跑。因而
  每轮只收敛已在 trace 复现的根因，不为单次路径抄写错误增加新机制。
- [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
  要求 task-specific、真实分布、完整日志、自动评分与人工校准，并分别评估 agent 的
  输出、tool selection/arguments 和 handoff。当前 Kill Bill 固定多仓场景、结果 grader、
  trace grader 和人工领域 rubric 分层保留，不压成单一总分。
- 同一指南要求 multi-agent 复杂度由 eval 驱动。repo-wiki 只在证据问题或页面真正独立
  时 fan-out，并在 trace 中检查并发上限、重复 worker、reviewer 复用和 handoff；不再
  采用“每个 Source 一个 worker”的固定拓扑。

`skill-creator` 的结构复审结果：description 边界明确，references 均从入口按阶段可发现，
确定性行为留在 scripts，模板留在 assets，`quick_validate.py` 通过。当前不新增 README、
额外路由层或通用 LLM judge；这些都会增加上下文或评测器自身的校准负担，尚无实跑证据
证明必要。

## 一手来源给出的共同原则

### 1. 结果和过程要分开评

Anthropic 将 outcome 定义为 trial 结束时环境的真实状态，将 transcript/trace 定义为
包含输出、工具调用、推理和中间结果的完整记录；一个 agent 说“完成”不等于环境中
真的完成。其 coding-agent 示例也优先用可执行检查验证结果。OpenAI 的 trace grading
则把端到端 decisions、tool calls 和 reasoning 结构化评分，用于定位工作流为何成功或
失败。两者都说明 final outcome 是主判据，trace 是诊断和防作弊证据，不能互相替代。

来源：

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenAI: Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)
- [AgentBoard paper](https://proceedings.neurips.cc/paper_files/paper/2024/hash/877b40688e330a0e2a3fc24084208dfa-Abstract-Datasets_and_Benchmarks_Track.html)

### 2. 不应强制一条唯一 gold trajectory

Agent 可以通过不同但都有效的路径完成开放任务。ToolSandbox 使用有顺序约束的动态
milestone，而不是要求逐工具调用匹配一条参考轨迹；AgentBoard 也在最终成功之外报告
progress、grounding 和 trajectory 信息。repo-wiki 因而只应约束关键 gate、禁止行为
和可观测浪费，不应惩罚等价的搜索顺序或合理的额外验证。

来源：

- [Apple ToolSandbox repository](https://github.com/apple/ToolSandbox)
- [AgentBoard paper](https://proceedings.neurips.cc/paper_files/paper/2024/hash/877b40688e330a0e2a3fc24084208dfa-Abstract-Datasets_and_Benchmarks_Track.html)

### 3. 随机系统必须重复运行

Anthropic 把每次 attempt 称为 trial，并明确因模型输出会变化而运行多个 trials。
τ-bench 除单次成功率外引入 `pass^k`，衡量连续多次都成功的可靠性。Inspect 的
`epochs` 和 reducers 也把重复 sample 与聚合作为一等能力。因此一次 live QA 只能
称为 case study；模型、prompt、revision 和 harness 相同也不能从一次通过推出可靠。

来源：

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [τ-bench paper](https://arxiv.org/abs/2406.12045)
- [Inspect eval API](https://inspect.aisi.org.uk/reference/inspect_ai.html)

### 4. 自动 grader 也必须被评测

PaperBench 用作者共同编写的层级 rubric 分解长任务，并另建 JudgeEval 检验自动 judge
对人工金标的符合度。OpenAI 的 eval 指南要求有代表性的测试数据和人工 ground truth；
其对 SWE-bench Pro 的审计又表明，过严测试、欠规格 prompt、低覆盖测试和误导 prompt
都能扭曲结果。repo-wiki 不应把 `grade_run.py` 的绿灯当成 Wiki 语义质量的完整证明。

来源：

- [OpenAI PaperBench](https://openai.com/index/paperbench/)
- [OpenAI Evals guide](https://developers.openai.com/api/docs/guides/evals)
- [OpenAI: Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

### 5. 必须检查泄漏与 grader gaming

NIST CAISI 在 agent transcripts 中观察到两类问题：读取未来代码、网上答案或环境遗留
Artifact 的 solution contamination，以及绕过测试或针对 grader 的 grader gaming。
NIST 强调最终由人工复核命中，且自动 trace 检查仍可能漏报。repo-wiki 的旧 QA 记录、
已发布 Wiki、review rubric、grader 和 source 的未来 Git 历史都属于潜在泄漏面。

来源：

- [NIST CAISI: Examples of cheating in agent evaluations](https://www.nist.gov/caisi/cheating-ai-agent-evaluations/2-examples-cheating-caisis-agent-evaluations)
- [OpenAI: Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

## Repo Wiki 的六层指标

### A. Outcome：任务成功和功能正确性

`task_success` 是硬门槛，必须同时满足：

1. Run 到达 `published`，不是仅写出 Candidate 或在消息中宣称完成；
2. `plan.md`、`composition.md`、全部 drafts、`review.json` 和 publication bundle 存在，
   且与当前 contract 一致；
3. `okf validate --published` 为零错误，deterministic CLI e2e 通过；
4. Composition 中每个 knowledge unit 恰好绑定一次，draft、page ID、path 和 manifest
   集合一致；
5. 最终 review digest 精确绑定被发布 bundle；
6. 抽样 locator 能在冻结 revision 解析，行范围存在且实际支撑相邻 claim；
7. 场景 rubric 中的必需领域被覆盖，或在 `gaps` 中给出有证据的明确排除理由。

同时报告 `assertion_pass_rate = passed_assertions / all_assertions` 用于定位，但任何关键
断言失败都不能被平均分掩盖。文本相似度不适合作为主指标，因为不同页面组织和措辞可
同样正确。

对当前 Java 企业财经 fixture 的建议：

| 场景 | 确定性硬门槛 | 语义门槛 |
|---|---|---|
| Kill Bill 四 Source | published、零 validation error、引用可解析、Artifact/manifest 一致 | catalog、subscription、usage、invoice/payment/overdue、public/internal API、queue、lifecycle、plugins 被覆盖或说明 gap |

### B. Trajectory：过程质量

只检查关键 milestone 和禁止行为：

| 指标 | 定义 |
|---|---|
| `milestone_adherence` | 必需 gate 按 contract 顺序完成的比例 |
| `premature_completion` | 未 published 就宣布完成的次数，目标为 0 |
| `forbidden_state_access` | 直接检查 run internals、grader、hidden rubric 或非 packet 输入，目标为 0 |
| `repair_recovery_rate` | validation/review 报错后最终修复成功的错误数 / 可修复错误数 |
| `no_progress_loops` | 状态与输入未变化时重复同一 status/read/search/review 的循环数 |
| `artifact_churn` | 无语义收益却重复整文件改写的次数和 bytes |
| `phase_reentry` | 每阶段重新进入次数，区分正常 review repair 与无效循环 |

不要求精确匹配一个参考命令序列；否则会把模型找到的更短有效路径误判为失败。

### C. Resource：token、成本和延迟

每次 run 至少记录：

- model 的精确标识、推理配置、CLI 和 skill/harness commit；
- input、cached input、output、reasoning tokens（host 能提供时）；
- API 或 host 报告的实际 USD cost；无法可靠换算时保留原始 usage，不猜价格；
- wall time、model wait、tool execution time、人工等待时间；
- turns、tool calls、subagent 数、失败调用、retries；
- 每个阶段的 token、tool-output bytes、调用数和耗时。

派生指标只在 outcome 同等时比较：

```text
tokens_per_success = total_tokens / successful_runs
cost_per_success = total_cost / successful_runs
wall_time_per_success = total_wall_time / successful_runs
phase_share = phase_tokens / total_tokens
tool_error_rate = agent_caused_tool_errors / tool_calls
```

失败得早的 run 消耗更少，不代表更高效。比较两个配置时先看 task success 和语义
rubric，再在 Pareto 意义下比较成本与延迟，不把质量和成本揉成一个不透明总分。

Inspect 的 eval log 原生保存 samples、messages、scores、model usage 和 timing；OpenAI
Evals 的 run 结果也明确包含 invocation count、prompt/completion/cached tokens，说明
这些字段应是评测记录而不是人工估算。

来源：

- [Inspect eval logs](https://inspect.aisi.org.uk/eval-logs.html)
- [Inspect model API](https://inspect.aisi.org.uk/reference/inspect_ai.model.html)
- [OpenAI Evals guide](https://developers.openai.com/api/docs/guides/evals)

#### 可操作的 token 浪费分类

总 token 多不自动等于浪费。只有 trace 能归因的部分才标为 waste：

| 类别 | 判定方法 |
|---|---|
| unchanged reread | 同一路径同一区间、文件 digest 未变，却重复读取 |
| unchanged status poll | Run state 和 artifact digest 均未变时重复 status |
| broad output | 可用 `--path` 或更小范围完成，却反复返回大段无关结果 |
| identical retry | 输入、环境和错误条件未变而原样重试失败命令 |
| discarded exploration | 大量读取未进入 Plan、page、gap 或 review evidence |
| duplicate worker work | 多 worker 对同一问题和 locator 做重复探索且没有独立验证目的 |
| leakage read | 读取旧 QA、参考答案、grader 或未来 revision；同时属于有效性失败 |

报告 waste event 数、相关 tool-output bytes，并在 host 可建立事件到 usage 的关联时报告
估算 token 占比。不要把 cached token 直接算成“浪费”，缓存只改变价格，不改变上下文
长度和延迟风险。

### D. Tool use：错误、冗余和恢复

先分责任，避免把基础设施故障错误归因给 skill：

- agent-caused：不存在的命令、schema/argument/path/locator/phase 错误、误把 literal 当
  regex、读取禁止路径、无关工具、同错原样 retry；
- infrastructure-caused：rate limit、host dispatch failure、网络或 registry 中断、
  sandbox cache 不可写、工具内部 crash；
- expected negative check：为了验证错误路径而有意触发的失败，不计 agent error。

每类报告 `count`、`count/tool_calls`、恢复成功率和额外耗时。BFCL 对 tool selection、
参数、relevance detection、multi-turn 和 latency 分开评测；ToolSandbox 对多调用、
状态依赖和 ordered milestones 分开验证，支持上述拆分而不是只统计非零 exit code。

来源：

- [Berkeley Function Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard)
- [BFCL V3 multi-turn evaluation](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)
- [Apple ToolSandbox repository](https://github.com/apple/ToolSandbox)

### E. Reliability：重复性和方差

固定以下条件后重复：Source URL 与 revision、初始 workspace、task prompt、skill commit、
CLI/harness version、准确 model/config、预算、网络策略和并行度。每个 run 使用全新隔离
workspace，不从上次 Artifact 恢复。

首轮诊断可运行一次；用于回归判断至少 3 次，正式模型或流程比较建议 5 次以上。报告：

- `pass@1 = successful_trials / trials`；
- `pass^k`：同一 task 连续 k 次均成功的概率或直接观测比例，衡量可靠交付；
- `pass@k`：k 次中至少一次成功，仅适用于产品确实允许重跑的情形；
- tokens、cost、wall time、tool errors、rubric score 的 median、range、mean 和标准差；
- task success 的置信区间；样本很小时明确显示原始 `x/n`，不伪装成精确结论；
- 页面集合、领域覆盖、引用支持率和 gap 集合的 run-to-run 差异。

单次运行发现的问题可以确定地证明“这个失败模式存在”，但不能估计其发生频率。

### F. Human quality 与 grader validity

对发布 Wiki 做盲审，reviewer 不看模型名、token、旧 QA 结论或运行身份。与 baseline
成对比较时随机左右顺序。建议使用 0/1/2 的小 rubric，而不是模糊的 1--10 总体印象：

| 维度 | 0 | 1 | 2 |
|---|---|---|---|
| evidence correctness | 关键 claim 错误或引用不支持 | 大体正确但有局部越界/证据弱 | 关键 claim 准确且被 locator 直接支撑 |
| domain coverage | 漏关键领域且无 gap | 主路径覆盖，边缘缺口已说明 | 高价值边界、失败路径和跨 Source 关系均覆盖 |
| navigability | 页面边界混乱，无法路由工作 | 能找到主题但有重复/跳转摩擦 | overview、architecture、概念页能快速路由任务 |
| onboarding usefulness | 复述目录或 README | 有部分不变量和入口 | 解释责任、状态变化、边界、失败语义和修改入口 |
| concision | 重复、低信号、页面过载 | 少量可删内容 | 薄而完整，无明显重复 |
| conventions/language | 违反 repo contract 或语言要求 | 少量不一致 | contract、术语、链接和语言一致 |

任一 load-bearing claim 明显错误时，即使其他维度较好，也不应批准。至少两位领域 reviewer
独立评一批校准样本，记录逐项 agreement、disagreement 和 adjudication；不要只报最终
一致结论。LLM judge 若用于扩量，必须先在这批人工金标上测 precision/recall 或 agreement，
并保留人工周期复核。PaperBench 的 JudgeEval 正是这种“先评 grader”的做法。

失败 run 的 outcome 和 trace 全审；成功 run 随机抽样 trace，并对所有异常 waste、
forbidden access 和 grader-gaming 命中人工复核。根因标签固定为 agent、task/spec、
grader、environment 或 harness，避免所有失败都算到模型。

来源：

- [OpenAI PaperBench](https://openai.com/index/paperbench/)
- [PaperBench source repository](https://github.com/openai/frontier-evals/tree/main/project/paperbench)
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

## 防污染与 trace 审计

### 当前仓库的直接风险

`docs/research/` 已包含 Kill Bill 的实际 QA 记录，其中列出固定 revision、关键领域、
已知故障、命令行为、理想整改和部分输出。若被测 agent 能读取这些文件，领域
recall、故障发现和路径选择都会被提示，运行不再是干净 eval。

干净运行应满足：

1. 在只含被测 Source、repo-wiki runtime 必需文件和 task prompt 的隔离 workspace
   中执行；不挂载开发仓库的 `docs/research/`；
2. 隐藏旧 Wiki、旧 Run、QA 报告、人工 rubric、grader、hidden assertions 和参考输出；
3. Git Source 固定到目标 revision，并阻止读取未来 commit、原 PR/issue 的标准答案；
4. 网络默认关闭；必须联网安装依赖时使用 allowlist/cache，把安装通道和一般搜索分开；
5. grader 在 agent 退出后从只读基准副本执行，agent 不得修改 validator、测试或 grader；
6. 运行后扫描完整 trace：旧 QA 文件名、grader 路径、future commit、网络答案、跳过
   validation、修改测试、伪造 Artifact 或 digest 都是命中项；
7. 旧 QA 只在完成后用于 paired comparison，不进入被测上下文。

公开固定场景适合回归，但模型训练污染无法仅靠 trace 排除。若要声称泛化能力，应加入
时间较新的 held-out/private repos，并保留未公开的语义 rubric；公开场景与 held-out
场景分开报告。

## 可落地的评测流程

### Tier 0：每次提交的 deterministic contract

继续运行现有 tests、`run_cli_e2e.py` 和 published validator。它们负责 schema、状态机、
binding、publication、locator 解析等确定性保证，不调用模型。

### Tier 1：受控 live diagnostic

对 Kill Bill 四 Source 固定 revision：

1. 创建干净隔离 workspace，记录所有版本、配置和初始 digests；
2. 用固定 prompt 和指定模型运行到 `published`、`blocked` 或总预算耗尽；
3. 保存 JSONL trace、stdout/stderr、usage/timing 和每次阶段变更后的 Artifact snapshot；
4. 运行现有 `grade_run.py`，另输出一张本文六层 metrics 表；
5. 人工审全部失败、全部 contamination 命中和随机成功样本；
6. 同配置至少重复 3 次后，才用于回归 gate。

### Tier 2：夜间/发布前重复 domain recall

运行 Kill Bill 四 Source 和至少一个 held-out repo。至少 5 trials，使用同一 rubric，报告
领域覆盖、引用支持、task success、`pass^k`、成本和方差。Kill Bill 是高成本压力场景，
Tier 1 单次诊断不进入每次提交的默认 gate。

### Tier 3：A/B 流程调整

一次只比较一个变化，例如 search output budget、Plan prompt 或 reviewer scope。A/B 使用
相同 Source revisions、trial 数、模型配置、预算和 grader；先比较 outcome/rubric，再看
tokens、cost、latency。页面更少、token 更低或执行更快都不是独立成功条件。

## 每次运行的最小记录

无需先引入新数据库；在 run 旁保存一份结构化 JSON 和一份 Markdown 摘要即可：

```text
identity: timestamp, scenario, source revisions, skill/harness/CLI commits, model/config
outcome: terminal phase, task_success, assertion results, validation errors
quality: rubric scores, reviewer ids/blinding, disagreements, citation sample
trajectory: milestones, forbidden access, repair loops, premature completion
tools: calls, agent/infra errors, retries, duplicate/unchanged calls, output bytes
resources: input/cached/output/reasoning tokens, cost, wall/model/tool time by phase
reliability: trial index, aggregate pass@1/pass^k/pass@k, dispersion
validity: isolation/network policy, contamination hits, grader changes, trace review status
artifacts: paths and content digests for Plan, Composition, drafts, review and publication
```

`grade_run.py` 目前已覆盖部分 outcome、locator 抽样和少量禁止命令；缺口主要是阶段级
usage/timing、工具错误责任分类、无进展/重复读取、污染扫描、重复试验聚合和人工 rubric。
第一步只补采集与报告，不把这些诊断指标全部变成 kernel gate。

## 建议的采用顺序

1. 先让 live driver 固定记录 model/config、完整 JSONL、usage/timing、exit status 和 Artifact
   digests，并确保失败日志不被吞掉。
2. 给现有 grader 增加独立的 metrics 输出：agent/infra tool errors、重复/无进展调用、
   phase tool-output bytes、forbidden/leakage reads；不改变 deterministic contract。
3. 为 Kill Bill 建一张 0/1/2 人工 rubric，先盲审已有和新 run，校准 grader。
4. 同配置运行 3 次；若要做版本或模型结论，再扩到 5 次和 held-out repo。
5. 根据 trace 中占比最高且反复出现的浪费点做单变量 A/B，避免凭一次总 token 猜优化点。

这套方案刻意不先增加新的 orchestration 层、综合总分或 LLM judge 服务。现有 validator、
一份结构化 metrics、一个小型人工 rubric 和重复运行，已经足以回答当前最重要的问题：
skill 是否真的完成、产物是否可信、失败发生在哪里、同样条件下是否稳定，以及改善是否
用更少资源得到同等或更好质量。
