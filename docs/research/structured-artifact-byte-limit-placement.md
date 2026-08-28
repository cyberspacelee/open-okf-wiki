# 结构化 Artifact 字节上限应放在哪里

日期：2026-08-28
问题：`plan` / `review` worker 生成 JSON Attempt Artifact 时，内核以
`256 * 1024` 字节硬拒绝超限文件。这个精确值是否应写进 agent-facing
`SKILL.md` 或 reference contract？资料仅采用官方文档、规范和开源项目官方文档。

## 结论

**生产者需要知道 Artifact 是有界且可能被 State Gate 拒绝，但通常不需要在
`SKILL.md`、通用 contract 或 Target reference 中看到手写的 `256 KiB`。**

这个值是序列化资源的高位保险丝，不是内容质量目标，也不是 JSON Schema 能表达的
语义约束。推荐分层如下：

| 层 | 应负责什么 | 是否出现精确值 |
|---|---|---|
| `_models.py` | page、scope、tag、issue 和文本的语义基数 | 不出现总字节值 |
| `_validate.py` | 读取前执行 UTF-8 文件字节硬限制 | 是，唯一事实源 |
| gate issue | 报告实际字节数、允许字节数和下一步动作 | 是，从内核常量派生 |
| `plan.md` / `review.md` | 告知产物有界、避免嵌入正文、运行 packet 的完成命令 | 不手写数值 |
| `contract.md` | plan/page/review 共用的不变量 | 不手写数值 |
| `SKILL.md` | 生命周期、调度和 reference 路由 | 不手写数值 |

暂时也不建议为了传一个常量新增 dispatch 字段。当前 Pydantic 已有 64 pages、64
issues、16 tags、字段长度等语义约束，而且 worker 必须运行 `complete_command`。
先让 gate 在异常发生时给出精确且可操作的错误即可。只有 eval 显示 oversized 首次
提交是常见失败、重试成本明显时，再从同一内核常量派生
`max_artifact_bytes: 262144` 或 preflight command 放进 `plan` / `review` packet；不能
在另一处再定义一个常量。

证据与推断边界：下述一手来源分别证明 schema/field constraint、token 计量、prompt
去重、渐进披露和可操作超限反馈的做法；它们没有直接规定 repo-wiki 应把限制放在哪个
文件。本文对 `_validate.py`、reference、packet 和 gate issue 的具体分层，是结合这些
原则与当前 lifecycle 作出的工程推断。也没有来源给出 `256 KiB` 这一推荐阈值。

## 为什么 producer 要知道“有硬限制”

OpenAI 的模型指导建议继续提供真正的 hard constraints 和 success criteria，同时
要求每条规则只陈述一次、把 policy 放在一个位置。Structured Outputs 则把格式和
字段约束交给提供给模型的 JSON Schema，减少靠强提示维持格式和反复重试。
[OpenAI: Model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[OpenAI: Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

这支持两个不同结论：

1. worker 不应在完全不知道会被拒绝的情况下生产无界 Artifact；reference 至少应说
   “bounded，提交由 State Gate 校验”，并给出完成命令。
2. hard constraint 不等于要把同一个字面量复制到所有 prompt。对只生产 page Markdown
   的 worker，这个限制完全无关；对 coordinator，它也不是调度决策。

SWE-agent 的官方模板提供了一个更直接的失败反馈案例：观察结果超限后，下一轮消息
动态说明 `max_observation_length`、被省略的字符数，并要求改用更小输出或
`head` / `tail` / `grep` / 文件重定向。精确值出现在发生问题的 action-observation
边界，而不是被重复写进所有常驻提示。
[SWE-agent: Template configuration](https://swe-agent.com/latest/reference/template_config/)

对应到本项目，`task complete` 就是这个边界。它应返回类似：

```json
{
  "severity": "error",
  "code": "artifact-too-large",
  "locator": "path/to/attempt.json",
  "message": "301244 bytes exceeds 262144; remove embedded source text or repeated plan/review items."
}
```

这比只说 `exceeds 262144 bytes` 更容易修复，也比让模型事前估算 JSON 字节数可靠。

## 精确 byte limit 不是 schema 约束

JSON Schema 2020-12 的 `maxLength` 约束字符串长度，`maxItems` 约束数组元素数，
`maxProperties` 约束对象属性数。Core 规范还明确把空白和数值的不同词法表示排除在
JSON Schema 数据模型之外。规范没有“整个序列化 JSON 的 UTF-8 字节数”关键字。
[JSON Schema 2020-12: Validation](https://json-schema.org/draft/2020-12/json-schema-validation),
[JSON Schema 2020-12: Core](https://json-schema.org/draft/2020-12/json-schema-core)

同一个 JSON value 可因缩进、转义和 Unicode 编码方式产生不同的文件字节数。例如
`ensure_ascii`、紧凑 separators 和格式化缩进都改变磁盘大小，却不改变 schema
validation 的对象值。因此：

- 总字节限制必须留在读取/解析前的 deterministic kernel guard；
- agent-facing schema 应表达对任务真正有意义的 `maxItems`、`maxLength`、required、
  enum 和 graph invariants；
- 不应为总字节限制发明自定义 JSON Schema keyword，除非所有 producer 与 validator
  都共享同一个实现；本项目没有这个需要。

Pydantic 官方文档也把 `Field(max_length=...)` 等 constraint 附着到字段，并让这些
constraint 影响生成的 JSON Schema。这与当前 `_models.py` 的方向一致：让 planner
知道最多多少 pages/scopes/tags、每个字符串允许多长，比告诉它一个总文件字节 ceiling
更能改变生成行为。
[Pydantic: Field constraints](https://pydantic.dev/docs/validation/latest/concepts/fields/#field-constraints)

## byte、character 和 token 不能混用

`256 KiB` 精确表示 262,144 个文件字节；它不表示 262,144 characters，更不表示固定
token 数。OpenAI 官方说明 token 可以是字符、词的一部分、完整词或标点，同一文本的
token 数会随模型 encoding 和语言变化。Anthropic 也要求按目标模型重新计数，并指出
token count 本身可能是估计值。
[OpenAI: Understanding and counting tokens](https://help.openai.com/en/articles/4936856),
[Anthropic: Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)

这意味着 `256 KiB` 不能作为“保持 coordinator context 小”的直接代理：

- JSON Artifact 留在磁盘时，byte cap 主要保护状态、解析成本和异常输出；
- Artifact 进入模型上下文时，应单独使用 token 预算、字段投影或按需读取；
- 对中文、转义内容、长路径和不同 tokenizer，byte/token 比例并不稳定；
- LLM 无法靠提示可靠计算最终 UTF-8 文件字节数，确定性命令必须做最后检查。

Aider 的 repo map 采用相关性选择和动态 token budget，默认目标约 1k tokens；它不会
用一个总文件 byte ceiling 代替上下文预算。这个案例支持把内容预算定义成 agent
实际能遵守的语义/上下文目标，把 byte cap 保留为实现兜底。
[Aider: Repository map](https://aider.chat/docs/repomap.html)

## 渐进披露决定放置位置

Anthropic 的 Agent Skills 文档把内容分为三层：常驻 metadata、触发后读取的
`SKILL.md`、按需读取的 resources。其 authoring best practices 把 `SKILL.md` 定位为
指向详细资料的 overview，并建议接近 500 行时拆分。这样做是为了只让当前任务相关的
信息占用 context。
[Anthropic: Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
[Anthropic: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

本项目已经按这种结构工作：`SKILL.md` 路由到 `plan.md`、`page.md`、`review.md`。
所以即使未来 eval 证明 producer 必须在提交前看到精确限制，它也只应出现在
`plan` / `review` 的 task packet 或该 Target 的 reference，不应上浮到顶层
`SKILL.md`，更不应进入 `page.md`。

但 progressive disclosure 只解决“何时加载”，不解决 single source of truth。把
`256 KiB` 同时写在 `plan.md`、`review.md`、`contract.md` 和 grader 中，仍会在阈值
调整后产生漂移。OpenAI 当前模型指导明确建议保持 lean prompt、每条规则只写一次；
这正是应该避免文档字面量复制的理由。
[OpenAI: Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

## 当前实现评估

当前放置情况是：

- `_validate.py` 定义 `MAX_STRUCTURED_ARTIFACT_BYTES = 256 * 1024`，并在解析前检查
  `path.stat().st_size`：职责正确。
- `_models.py` 对 pages、gaps、scopes、paths、tags、issues 和主要字符串做语义约束：
  职责正确，而且比总字节值更适合 producer。
- `SKILL.md` 只说 structured decisions are bounded，没有精确值：合适。
- `plan.md` 和 `contract.md` 不再手写 `256 KiB`：精确值没有扩散到提示词。
- `review.md` 同样不写精确值；plan/review 都由同一个 kernel guard 检查。
- `grade_run.py` 不再复制总字节阈值；发布 State Gate 是该保险丝的唯一执行者。
- `artifact-too-large` issue 返回实际大小、允许值和整改动作。

## 已采用的放置方式

按最小改动顺序：

1. 保留 `_validate.py` 的单一总字节常量与 parse-before-size-check。
2. `SKILL.md` 保持现状，不增加 `256 KiB`。
3. 从 `contract.md` 和 `plan.md` 删除精确值；plan 保留可执行的 page 数语义边界，
   各 Target 提交前运行 packet 的 `complete_command`。
4. 超限 issue 的现有 `message` 包含 actual bytes、max bytes 和短整改建议；限制值
   从内核常量生成，没有新增 issue 字段。
5. grader 不再定义第二个 `256 * 1024`；该资源保险丝由发布前 State Gate 保证。
6. 保留并优先调整 Pydantic 的语义 cardinality。实际 plan/review 大小分布、gate retry
   率和下游读取成本才是判断 page/issue/text 上限是否合理的依据。
7. 不新增 packet 字段。只有 eval 证明 agent 经常第一次写出超限 Artifact 时，才把
   `max_artifact_bytes` 或 `check_command` 从内核动态放进 `plan` / `review` dispatch。

## `256 KiB` 本身是否合理

检索到的一手来源支持“输出必须有界、schema 应表达语义边界、失败反馈必须可操作”，
但没有来源证明 256 KiB 是 agent structured artifact 的通行最佳值。Aider 用 token
budget，SWE-agent 的 observation limit 以 characters 计量，JSON Schema 以 value
cardinality 计量；它们解决的是不同资源。

因此 256 KiB 可以暂时保留为防异常文件、状态膨胀和解析成本的高位保险丝，但不应被
解释为目标大小或 coordinator context budget。是否改成更小的值，应从真实 run 收集
以下数据后决定：

- plan/review Artifact 的 p50、p95、max bytes；
- `artifact-too-large` 的首次提交率和成功重试率；
- plan page count、review issue count 与 Artifact bytes 的关系；
- grader/下游实际读取的是整个 Artifact，还是只读取投影字段；
- 不同输出语言的 token 与 byte 分布。

没有这些数据时调整精确阈值，或把精确值扩散进更多 agent 文档，都只是猜测。
