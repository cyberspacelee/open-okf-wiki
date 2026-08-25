# LLM 校验与 Handoff 约束的效率分析

日期：2026-08-25

## 结论

当前证据不支持把“更严格的 Wiki frontmatter parser”和“让模型生成结构化
`contextRefs`”列为产品优化。两项建议都应撤销，而不是降级后继续排期。

- `frontmatter.ts` 使用的 `yaml@2.9.0` 已默认拒绝重复 key、多文档和过量 alias
  展开；YAML 1.2 下 merge 默认关闭。上游 `pi-llm-wiki` 的额外 parser 规则并不
  对应当前已知故障。
- survey handoff 路径是 host 已掌握的 Run 状态。当前实现由 host 从 completed
  receipts 注入 synthesis prompt 和 compaction checkpoint；没有增加 `contextRefs`
  或要求 LLM 结构化复述。
- survey/synthesize 的完整性主要是语义问题。新增一个模型自报的
  `complete|blocked` 字段不能证明调查完整，反而新增形式失败入口。
- writer 结束前的机械检查仍然有价值，但每条规则必须对应可恢复、影响产品的
  缺陷；相同 session 内的定向修复优于重启，重试次数不能代替规则收益评估。

这里的关键区别是：**本地 parser/validator 本身几乎不消耗 LLM token；只有当它
拒绝原本可接受的产物并触发下一轮生成时，才产生模型成本和失败风险。** 因此不能
从“严格解析一般更安全”直接推导出“当前 Wiki 产品应增加拒绝条件”。

## 一手证据

### 1. Structured output 提高结构可靠性，但不保证内容正确

OpenAI 报告 `gpt-4o-2024-08-06` 在其复杂 JSON Schema following eval 中，严格
Structured Outputs 的结构符合率达到 100%；同时官方明确说明它仍可能在 JSON
字段值里犯错。新 schema 首次需要编译 grammar，典型 schema 低于 10 秒，复杂
schema 可能达到 1 分钟，之后缓存命中时开销很小。适用边界：这是 provider 端的
constrained decoding，不是本项目完成后调用 `YAML.parse()` 的效果。

来源：[OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/)

Anthropic 同样说明 structured output 会注入额外 system prompt、增加 input token，
schema 变化会使 prompt cache 失效；optional、union、嵌套和严格工具数会组合放大
grammar，最终可能触发 180 秒编译超时。其建议也是只对“schema 违反会造成真实问题”
的关键工具使用 strict。适用边界：这些成本只在模型请求实际携带严格 schema 时
发生，不能用来声称普通本地 YAML parser 有同样的直接推理成本。

来源：[Claude Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

Gemini 保证 schema 匹配的语法输出，但要求应用继续验证业务语义；官方还建议在
schema 被拒时缩短字段名、减少嵌套或约束。适用边界：schema validation 与 value
correctness 是两个指标。

来源：[Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)

### 2. 格式约束对生成质量的影响依赖任务、模型和 decoder

EMNLP 2024 的研究在推理任务中观察到格式越严格，性能通常下降越大；但分类任务
有时从受限答案空间获益。其一个 Last Letter 实验中 JSON 解析错误仅 0.148%，任务
性能差距却达到 38.15%，说明“可解析”不能作为语义质量的代理。论文也发现第二次
格式化调用能修补 parse error，但这没有证明它能修复推理错误。适用边界：论文测试
的是模型输出 JSON/XML/YAML 的格式限制，不是 Markdown 中一个短 frontmatter 的
post-hoc 解析。

来源：[Let Me Speak Freely?](https://aclanthology.org/2024.emnlp-industry.91/)

RANLP 2025 在 11 个开放模型上的实验发现，instruction-tuned 模型在受约束的生成
任务中经常退化，而分类较稳定；适配 prompt 和更多 few-shot 示例能够改善结果。
适用边界：该结论不等于所有 schema 都有害，更不能从开放模型直接外推到当前使用
的任意 provider/model。

来源：[The Hidden Cost of Structure](https://aclanthology.org/2025.ranlp-1.124/)

反向证据同样存在。JSONSchemaBench 在固定 Llama 3.1/3.2、适配 prompt 和 two-shot
设置下，constrained decoding 的下游任务质量提升最高约 4%；高效实现还可通过
fast-forward 将生成提速约 50%。但不同 engine 的 TTFT、每 token 时间和 schema
覆盖差异很大，复杂 schema 可能超时或根本不支持。适用边界：结果说明必须按实际
model/schema/decoder 评测，不能得出“结构化一定降质”或“一定提质”。

来源：[JSONSchemaBench](https://arxiv.org/html/2501.10868)

CRANE 从理论和实验上进一步指出，只允许最终答案语法的过窄 grammar 可能压缩推理
空间；让模型先自由推理、最后约束输出可以兼顾正确性。适用边界：这支持把丰富调查
保留为 Markdown、仅让 host 管理小型控制数据，而不是把整个 survey/synthesis
证据体塞进严格 schema。

来源：[CRANE](https://arxiv.org/html/2502.09061)

### 3. Agent handoff 应区分语义委派与 host 已知状态

Anthropic 的生产多 agent 研究系统要求 subagent assignment 包含目标、输出格式、
工具/来源指导和明确边界；它同时推荐让 subagent 把完整结果写入文件，只向 coordinator
返回轻量引用，以减少复制 token 和“传话”损失。适用边界：这支持当前“自然语言任务
+ 持久化 Markdown handoff + 路径”的组合，但没有要求路径必须由 LLM 生成结构字段。

来源：[Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

OpenAI Agents SDK 对边界说得更直接：handoff `inputType` 用于模型在交接时决定的少量
metadata（如 reason、priority、summary）；应用已经掌握的 state/dependency 应放在
本地 `RunContext`，不应让模型重复生成。适用边界：survey handoff path 已存在于
`RunExecutionReceipt`，属于 host state，不是模型判断。

来源：[OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/)

## 与当前实现的真实关系

### Frontmatter

[`frontmatter.ts`](../../extensions/wiki/lib/frontmatter.ts) 只在模型写完文件后调用
`YAML.parse()`，随后 [`wiki-okf.ts`](../../extensions/wiki/lib/wiki-okf.ts) 再校验
template、type、title、description、sources、Markdown 结构和链接。当前锁定版本是
`yaml@2.9.0`；官方默认值和本地运行核对结果如下：

| 风险 | 当前行为 | 是否需要再实现 |
|---|---|---|
| duplicate key | `uniqueKeys: true`，直接报 `DUPLICATE_KEY` | 否 |
| multiple documents | `YAML.parse()` 直接报 `MULTIPLE_DOCS` | 否 |
| alias expansion | `maxAliasCount: 100`，过量展开报错 | 否 |
| merge key | YAML 1.2 默认 `merge: false`，`<<` 只是普通 key | 否 |
| 非 mapping 根节点 | `parsePage()` 已拒绝 | 否 |
| 超大文件/极深输入 | 没有 Wiki page byte/depth 上限 | 无故障数据，暂不加 |

`yaml` 官方也说明 v2.9.0 修复了大数组和递归导致的调用栈问题，但恶意输入仍可能
触发普通 bug；这说明资源边界并非不存在，只是当前 Candidate 由受限 writer 工具生成，
且没有相关事故或压测数据，不能把它包装为 P0 产品收益。

来源：[yaml options](https://github.com/eemeli/yaml/blob/main/docs/03_options.md)、
[yaml v2.9.0 release](https://github.com/eemeli/yaml/releases/tag/v2.9.0)

决定：**撤销 strict frontmatter parser 建议。** 不禁止所有 alias/custom tag，不新增
深度遍历，不因此扩充 repair loop。只有观察到内存/栈问题，或 Published Wiki 允许
不可信外部文件直接进入时，再在读文件入口加一个简单 byte limit；那是资源保护，
不是 LLM 质量校验。

### Handoff 与 fan-in

当前 [`handoff.ts`](../../extensions/wiki/lib/handoff.ts) 已由 host 写入 JSON envelope，
包含 execution、board task、partition、agent、task digest 和 Candidate revision，并对
整个文件做 digest attestation。丰富证据仍是 Markdown body。这已经是“控制面结构化、
知识面自然语言”。

原实现的脆弱点在 [`producer.ts`](../../extensions/wiki/lib/producer.ts)：multi-source
synthesis dispatch 要求 Lead 的自然语言 `task` 用 `includes()` 命中每个 survey
handoff path。路径明明已在 durable execution receipts 中，却要求模型精确回显。

决定：

1. **不增加 model-facing `contextRefs`。** 它把一个现有精确回显要求换成另一个更长的
   schema 字段，没有创造信息。
2. **已把已知状态移回 host 控制面。** host 从最新 completed survey receipts 自动把
   引用注入 synthesis prompt，并删除 `task.includes(path)`；Lead 的 `task` 只表达语义
   目标。compaction checkpoint 同样保留这些引用，避免压缩后丢失依赖。

survey/synthesize 已使用固定 Markdown 章节，并要求所有 gap 被记录。新增自报
`status: complete|blocked` 只能验证字符串是否存在，不能验证“每个 cluster 都调查过”
或“关系两侧都重新打开”。因此也撤销该建议。需要更强语义保障时，应该基于真实漏项
设计 reviewer/eval，而不是增加一个可轻易自报的字段。

### Writer completion loop

[`completion.ts`](../../extensions/wiki/lib/completion.ts) 的 writer gate 在同一 session
结束前一次性返回全部问题，默认最多 6 个 repair rounds；检查包括 Todo coverage、
target validation，以及对“writer 实际写出的 citation”是否在本 session 读过。它没有
使用 provider 的严格 output schema，repair prompt 才是主要 token/延迟成本。

这类 loop 适合以下问题：诊断确定、模型可在当前工具权限内修复、修复结果可机械复验，
例如缺页、坏链接、frontmatter 语法错误、Todo 未完成。它不适合把风格偏好、每个 H2
必须有 citation、必须查 Catalog 等非必要规则反复送回模型。

决定：保留“writer 结束前、同 session、全量一批”的机制，但不以 6 次上限作为质量
保证。当前实现会在连续两轮 issue 集合不变时停止，同时保留总轮次硬上限；问题集合
发生变化则继续同 session 修复。后续仍应记录每个 issue code 的出现次数、首轮通过率、
各轮修复率、无进展率、token 和耗时，用数据判断是否还需调整默认上限。

## 建议的决策门槛

在更改 validator 或 handoff contract 前，用一组固定的真实 Workspace 比较基线和候选：

| 指标 | 判断用途 |
|---|---|
| 最终发布成功率 | 是否真的提升产品完成率 |
| 首轮 completion pass rate | 新规则是否制造形式失败 |
| 每个 issue code 的 repair success | 哪些规则值得自动修 |
| 同一 issue digest 连续出现次数 | 识别无进展 loop |
| 每个 Run 的 model calls / input / output tokens | 真实成本 |
| p50/p95 wall time | 首 schema 编译、repair 和重启延迟 |
| review factuality / coverage / citation accuracy | 防止“格式更正确、内容更差” |
| fan-in dispatch rejection 与 handoff 漏读次数 | 决定是否需要 host 自动注入 refs |

在这些指标为空时，默认选择不增加约束。handoff 已把已知引用移回 host 控制面；这次
改动删除了模型回显要求，没有扩展 LLM 输出契约。
