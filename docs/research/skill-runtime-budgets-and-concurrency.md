# Repo Wiki Skill 的运行预算、并发与版本一致性设计

日期：2026-08-31  
范围：由 `SKILL.md` 编排、确定性 CLI kernel 提供 bounded evidence
navigation、host agent 调度 subagents 的 repo-wiki skill。本文只研究设计，不修改实现。

## 结论

1. Search/read 预算应是 **Workspace policy，在 `run start` 时复制为不可变的
   Run-effective policy，并由 kernel 对最终序列化输出强制执行**。不能只做环境变量或
   每次命令的可选 flag；两者都会让同一 Run 的 evidence 行为不可复现。
2. 并发上限应是 **host run/session 的硬限制**，不是 kernel 内的伪 scheduler。
   repo-wiki 可在 Workspace/Run 中声明期望值并通过 `status` 披露，但 launcher 必须把
   它映射到 host 原生限制。建议默认 `4`，使用 rolling window：有一个 worker 结束就
   补一个，不等待整批完成。
3. 只限制“同时活跃数”不完整。还要禁止 child 继续派生 child，提供总 fan-out
   safety fuse，并在 host trace 中重建成功 spawn、terminal completion 和 peak active；
   当前只搜索 concurrency error 文本不能证明遵守上限。
4. 旧命令污染应按 **单一运行时来源 + 原子版本包 + Run 包摘要 + 文档命令契约测试**
   治理。不要恢复已删除的参数，也不要增加 compatibility alias。

以下把外部来源的事实与对本仓库的推论分开，避免把设计选择写成厂商要求。

## 一手来源事实

### Skill 与上下文

- OpenAI 说明 skill 是 instructions、resources 和 optional scripts 的组合；Codex
  先加载 name/description，激活后再读完整 `SKILL.md`，references 按需使用。这是
  progressive disclosure，而不是把所有运行材料预载入上下文。OpenAI 同时建议：每个
  skill 聚焦一个工作、需要 deterministic behavior 时使用脚本、步骤写清输入输出。
  来源：[OpenAI Build skills](https://learn.chatgpt.com/docs/build-skills)。
- Agent Skills 规范同样定义三阶段加载：metadata、完整 instructions、按需 resources；
  建议 `SKILL.md` 少于 500 行、长材料拆到 focused references，脚本应处理边界并给出
  有帮助的错误。来源：[Agent Skills overview](https://agentskills.io/home)、
  [Agent Skills specification](https://agentskills.io/specification)。
- OpenAI 的 Codex 文档说明本地 skill 可来自 repository、user、admin 和 system 多个
  scope；同名 skill **不会合并**，可能同时出现在 selector 中。Codex 支持 symlinked
  skill folders；skill 变更未出现时应重启 Codex。来源：
  [OpenAI Build skills](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。
- OpenAI hosted Skills 是 versioned bundle；可引用具体 version，未指定时使用
  `default_version`，并有 `latest_version`。API 还把新 skill version 定义为 immutable。
  来源：[OpenAI Skills guide](https://developers.openai.com/api/docs/guides/tools-skills#versioning-and-management)、
  [OpenAI Skills API reference](https://developers.openai.com/api/reference/go/resources/skills#skills-versions)。

### Bounded tool output

- OpenAI Vector Store search 把 `max_num_results` 作为请求参数，范围为 1..50；结果结构
  带 `has_more` 和 `next_page`。这证明“调用者可选结果上限 + 明确 continuation”是官方
  API 已采用的检索形态，但 50 不是 repo-wiki literal search 的推荐值。
  来源：[OpenAI Vector Store search API](https://developers.openai.com/api/reference/python/resources/vector_stores/methods/search)。
- OpenAI 的 model guidance 建议 bounded、tool-heavy workflow 用代码过滤、排序、去重、
  聚合和校验大中间结果，再返回更小的 structured result；并要求明确 exact output
  schema、concurrency、retry 和 stopping limits，最后比较 total tokens、latency、cost、
  calls、turns 和 retries。来源：
  [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model#programmatic-tool-calling)。
- Responses API 的默认 truncation 是 disabled；输入超过 context window 会失败，而
  `auto` 会从 conversation 开头丢项目。因此不能把模型/API 自动截断当作 evidence
  navigation 的可靠预算机制。来源：
  [OpenAI Responses API reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/retrieve)。

### Subagent orchestration

- OpenAI Multi-agent API 的 `max_concurrent_subagents` 统计整棵 agent tree 中同时活跃的
  descendants，不含 root；默认值和多数 workload 的推荐值都是 `3`。API 不设固定的
  tree depth 或总 subagent 数上限。来源：
  [OpenAI Multi-agent guide](https://developers.openai.com/api/docs/guides/responses-multi-agent#quickstart)。
- 同一指南指出 subagents 会增加 token usage，适合 concrete、independent、bounded
  workstreams；固定 deterministic execution graph、共享可变资源竞争或顺序依赖工作更
  适合单 agent。来源：
  [OpenAI Multi-agent guide](https://developers.openai.com/api/docs/guides/responses-multi-agent#when-to-use-multi-agent)。
- Codex 提供 project/session 级
  `agents.max_concurrent_threads_per_session`，用于限制同时打开的 spawned-agent threads；
  未设置时由 Codex 选择默认值。每个 subagent 自己做 model/tool work，因此比单 agent
  消耗更多 tokens。来源：
  [OpenAI Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents#global-settings)。
- OpenAI Agents SDK 把 manager-owned “agents as tools”用于 bounded specialist task；文档
  建议只有 capability、policy、prompt clarity 或 trace legibility 真正改善时才增加
  specialist，过早拆分会增加 prompts、traces 和 approval surfaces。来源：
  [OpenAI Agents orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)。

### 可验证性

- OpenAI agent eval 指南说明 trace 记录一个 Run 的 model calls、tool calls、guardrails
  和 handoffs，可用 structured criteria 检查 workflow 是否违反 instruction；确定“good”
  后应转成 repeatable datasets/eval runs。来源：
  [OpenAI Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals)。
- Multi-agent 输出包含 `multi_agent_call`、对应的 `multi_agent_call_output` 和
  `agent_message`，并用 `call_id` 关联；agent 名称可追踪消息方向。这些事件足以作为
  重建 spawn graph 和 active high-water mark 的一手事件模型。来源：
  [OpenAI Multi-agent output items](https://developers.openai.com/api/docs/guides/responses-multi-agent#new-multi-agent-output-items)。

## 本仓库现状与根因推论

### 1. Search/read 的限制是实现常量，不是运行契约

仓库事实：`_state.py` 目前用 `MAX_SEARCH_RESULTS=20`、
`MAX_SEARCH_BYTES=8 KiB`、`MAX_READ_LINES=200`、`MAX_READ_BYTES=64 KiB`；
`Workspace` 只保存 language、freshness 和 sources。Search 的 byte 计数只累计
`path + snippet`，不含 JSON envelope；read 的 byte 截断只针对 `text`，两者都不等于
“CLI stdout 不超过配置值”。Search 只有 `truncated`，没有 continuation cursor。

推论：当前限制能防止单次调用无限增长，但不能回答以下 contract 问题：

- 该 Run 的 effective limits 是什么；
- Workspace 配置变化是否影响已启动 Run；
- byte budget 是 snippet bytes、text bytes 还是完整 JSON bytes；
- truncated 后怎样不重扫地继续；
- eval 如何断言配置值确实生效。

### 2. 并发当前是 prompt policy，没有 hard cap 证据

仓库事实：`SKILL.md` 要求最多三个 child active，并描述 rolling window；ADR 0019 明确
由 host 选择并发，kernel 不调度 agent。`grade_run.py` 当前只统计日志中的
`Concurrency limit exceeded` / `agent thread limit reached` 文本，没有从成功 spawn 和
completion 重建 active 数。

推论：没有 error 只能证明 host 没报告超限，不能证明峰值小于等于 3 或 4。若 26 个
spawn 都成功，现有这一项反而可能通过。根因不是 rolling-window 文案不够长，而是
hard enforcement 和 trace assertion 均位于错误层或缺失。

### 3. 旧命令有三个可能来源

仓库事实：当前 parser 的 `run start` 不接受 producer/session identity；ADR 0019 明确
删除这些 scheduler IDs。仓库历史研究文档仍曾包含旧调用；README 的安装示例使用
`--copy`，复制后的目标 skill 不会自动随本仓库更新。

结合 OpenAI 的多 scope 加载规则，旧命令可能来自：

1. 当前 conversation/history 或普通研究文档中的可执行样例；
2. 目标仓库的 stale copied skill；
3. 不同 scope 下同时存在的两个同名 skill。

重新接受旧 flags 只会掩盖版本错配，并重新把 scheduler identity 带回 kernel。

## 建议的完整契约

### A. Workspace policy 与 Run snapshot

采用一个完整、严格的配置对象，而不是四个散落 flag：

```json
{
  "version": 2,
  "language": "zh",
  "freshness_days": 90,
  "execution": {
    "evidence": {
      "search": {
        "max_results": 20,
        "max_output_bytes": 8192
      },
      "read": {
        "default_lines": 40,
        "max_lines": 200,
        "max_output_bytes": 65536
      }
    },
    "agents": {
      "max_active_children": 4,
      "max_spawn_depth": 1,
      "max_children_per_run": 128
    }
  },
  "sources": []
}
```

这是对本仓库的建议，不是外部规范规定的字段或数值。`20/8 KiB/40/200/64 KiB`
保留当前行为作为新 schema 的显式默认；`4` 是本次目标 rolling window。`128` 是防止
无限 fan-out 的初始 safety fuse，应由 live eval 校准，而不是宣称为通用最佳值。

配置规则：

- `workspace init` 必须写出完整对象；load 时使用 strict integer 校验，拒绝 bool、0、
  负数、未知字段和不合理组合，例如 `default_lines > max_lines`。
- 每个值还应有 kernel-owned absolute safety ceiling；具体 ceiling 要由大仓库 live eval
  决定，外部资料不能推出 repo-wiki 的正确数字。
- `run start` 把 `execution` 深复制到 Run state；所有 evidence 命令和 status 只读取 Run
  snapshot。Active Run 期间禁止修改 execution policy；要改变预算就开始新 Run。
- 这是正式 contract change。按仓库规则同时更新 Workspace/Run schema、validation、
  Artifact reference、unit tests、CLI e2e、live-eval setup 和 grader。既然本项目明确无
  migration layer，直接提升 Workspace/Run schema version，并拒绝旧 state/config。
- 不使用环境变量作为主配置，也不允许 worker 用 per-call flags 放大上限。环境变量无法
  被 state digest 固化；per-call override 会让不同 worker 获得不同的 evidence surface。

### B. Search/read 输出语义

预算必须约束 **UTF-8 canonical compact JSON stdout 的完整 byte 数**，而不是近似的
snippet 累计值。这样命令名里的 `max_output_bytes` 才有可测试的单一含义。实现时先保留
固定 envelope，再按稳定顺序装入完整 item；绝不切断 UTF-8 code point 或生成半个 JSON
item。

建议统一返回这些字段：

```json
{
  "items": [],
  "returned": 0,
  "limit": {"max_items": 20, "max_output_bytes": 8192},
  "limit_reached": false,
  "next_after": null
}
```

Read 可把 `items` 换成 `text`，同时返回 `requested_locator`、`returned_locator`、
`next_locator`。应区分：

- `limit_reached`：请求因 lines/bytes budget 被裁剪；
- `has_more`：文件或搜索空间在本次返回后仍有内容；
- caller 明确请求 `#L20-L80` 且完整返回时，不能仅因文件还有 L81 就称请求被截断。

Search 增加 `--after <locator>` 并返回 `next_after`；cursor 绑定 frozen Pin 的稳定文件顺序
和行号。Read 在触发限制时返回下一段 canonical locator。预算越小越需要 continuation，
否则“可配置”只会把重扫和漏证据风险转移给 LLM。

最小 deterministic 测试矩阵应覆盖：ASCII、多字节 UTF-8、JSON escaping、单条超长行、
恰好等于 byte limit、result limit 先触发、byte limit 先触发、cursor 无重叠/无遗漏、
Run start 后修改 Workspace 不改变 effective limits。

### C. Host-enforced rolling window

`execution.agents` 是 portable skill policy，但 **不是 kernel enforcement**。启动 host 的
adapter 必须把 `max_active_children=4` 映射到原生限制：

- Responses Multi-agent：`multi_agent.max_concurrent_subagents=4`；
- Codex：`agents.max_concurrent_threads_per_session=4`；
- Pi：官方示例 subagent extension 自身使用 `MAX_CONCURRENCY=4`，但这是 extension
  实现上限，不是 repo-wiki 可写入的通用 host 配置；
- Grok Build：原生 `spawn_subagent` 默认启用，但当前公开配置没有数值并发上限；
- 其他 host：有等价 session/run cap 时映射；没有时由 coordinator 强制 portable
  rolling window，并在 eval metadata 中标记 `enforcement=coordinator`，不能宣称是
  host-native hard cap。

来源：[Pi reference subagent extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts)、
[Grok Build subagents](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md)。

`SKILL.md` 保留一个短、明确的调度规则：维护 pending queue 与 active handles；先填满
4 个 slot；任一 handle terminal 后立即 dispatch 下一个；phase 切换前关闭不会复用的
handles。不要使用“每批 4 个全部完成后再开下一批”的 barrier。

`max_spawn_depth=1` 表示只有 coordinator 可以 spawn。证据、page 和 review worker 都不
再派生 child，使 active accounting 和 artifact ownership 可审计。若 host 原生 cap 像
OpenAI Responses 一样统计整棵树，它仍作为第二层防线。

`max_children_per_run` 是总 unique child safety fuse，不把 follow-up/reactivation 计为新
child。它防止 OpenAI 文档明确指出的“无固定 total/depth limit”变成无限 fan-out；达到
上限时 coordinator 应合并剩余问题或给出明确 blocked reason，而不是静默串行执行。

同一全局窗口适用于所有并行阶段：

| 阶段 | fan-out 形态 | 建议 |
|---|---|---|
| Evidence research | 问题数开放，最易失控 | 4-slot rolling；不能按 Source 数机械一对一派发 |
| Plan review | 单 reviewer，后续复用 | 1 active |
| Composition review | 复用 Plan reviewer | 1 active |
| Page writing | 最多可接近 64 pages | 全部进同一 4-slot rolling queue |
| Page repair | 原 writer follow-up | 与新工作共享同一 4-slot cap |
| Bundle review | 单 fresh reviewer | 1 active |

### D. Trace-based verification

`grade_run.py` 应从 structured host events 计算，而不是从错误字符串猜：

1. 成功 `spawn_agent`/`multi_agent_call_output` 后把 worker ID 加入 active set；失败 spawn
   不计入 active，但单独计错。
2. terminal completion、cancel 或 close 后移出 active set；wait/poll 不是 completion。
3. 每个事件后记录 `peak_active`，统计 max depth、unique children、orphans 和每阶段数量。
4. 断言 `peak_active <= effective max_active_children`、`max_depth <= 1`、
   `unique_children <= max_children_per_run`、无 orphan、无 concurrency errors。
5. 当 pending 数大于 4 时，断言第 5 个成功 spawn 出现在第 1 个 terminal 之后；并用
   trace 时间确认它不必等到前 4 个全部 terminal，证明是 rolling 而非 barrier。

`run_live_eval.py` 应把 requested policy、映射后的 host-effective cap、host/version、skill
bundle digest 写入 `live-eval.json`。如果 adapter 无法设置或确认 hard cap，eval 必须失败
或明确降级，不能只依赖 `SKILL.md` 文案。

### E. 清除并阻止旧命令污染

1. **清库存**：删除普通文档、research note、fixture 和 prompt 中可复制执行的旧
   producer/session 调用。需要记录历史决策时只写“scheduler identity 参数已删除”，不
   保留完整旧 shell 命令。保留 grader 对旧 flag 的 negative check。
2. **单一运行时来源**：运行命令只在 `skills/repo-wiki/SKILL.md` 和由 parser contract
   生成/验证的 reference 中出现；README 链接到当前 SOP，避免复制长期运行流程。
3. **命令契约测试**：从 SKILL/README/runtime references 抽取 `okf` snippets，用 argparse
   parser 做无副作用语法验证；同时 deny 已删除的 flag 和旧 subcommands。CLI 改动若未
   同步 docs，CI 直接失败。
4. **包原子性**：SKILL、references、scripts、assets 作为一个 bundle 安装；Run start
   记录 bundle digest 和 kernel contract，后续命令检测 active Run 的 bundle digest 未变。
   这防止同一 Run 中 `SKILL.md` 与脚本来自不同 revision。
5. **分发版本化**：本地开发优先使用 host 支持的 symlink，避免 `--copy` 静默陈旧；
   必须 copy 时提交并检查 installer lock/digest。正式分发使用明确的 plugin/skill version，
   不依赖无版本 copied directory。
6. **消除多 scope 歧义**：preflight 确认 host 实际解析的 `repo-wiki` 绝对路径。各 host
   的同名规则不同：有的保留多个定义，有的按 scope 优先级覆盖，不能假设较新的 copy
   自动胜出。
7. **保持拒绝**：parser 继续对旧 flags 退出非零，不添加 hidden aliases、deprecated
   warnings 或 dual schema。遇到该错误时 host 应重新读取当前 `SKILL.md`/status，而不是
   猜测参数。

## 实施顺序

1. 先清理旧命令并加入 command-contract/static deny tests，消除继续污染新 eval 的来源。
2. 引入严格 Workspace execution schema、Run snapshot、status disclosure 和完整
   search/read continuation contract；完成 deterministic tests 与 CLI e2e。
3. 在支持数值 hard cap 的 live adapter 中映射 cap=4；其他 adapter 明确记录 coordinator
   enforcement。改 `SKILL.md` 为配置驱动 rolling window，并让所有阶段复用同一窗口。
4. 扩展 structured trace grader 计算 high-water/depth/total/rolling，再跑代表性大仓库
   live eval；用 evidence recall、total output bytes、tokens、latency、spawn count 和
   retry count 共同校准 safety ceilings。

## 不应采用的方案

- 为兼容旧 prompt 把 producer/session flags 加回 `run start`。
- 只把四个常量改成环境变量。
- 允许每个 worker 通过 CLI flag 自行扩大 evidence limit。
- 在 kernel 中引入 worker lease、session ID 或 task scheduler，重新违反 ADR 0019。
- 只在 `SKILL.md` 写“最多 4 个”而不设置 host-native cap。
- 用“日志里没出现 concurrency error”代替 active peak 验证。
- 固定批次 barrier；它会浪费先完成 worker 释放的容量。
