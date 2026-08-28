# Agent 仓库浏览：有界工具输出与渐进披露

日期：2026-08-28
范围：评估 Triage / Survey 是否应读取完整 Index、递归枚举目录，或改用
task-scoped CLI 按需浏览。资料只采用官方文档、规范和一手工程材料。

## 结论

提供一个有界的 `okf task ls` 是合理的，而且比让模型读取完整 manifest、重复
读取 Source Index，或执行 `Get-ChildItem -Recurse` 更符合当前 agent 工具设计
经验。但应把它做成一个窄接口，而不是仓库查询平台：

- Triage 保留一次读取 compact Source Index；仅在 Index 被截断或某个分支不明确
  时调用 `task ls` 下钻。
- Survey 不再读取 Source Index；从 dispatch 中已有的 scope、orientation、themes
  开始，用同一个 `task ls` 浏览该 scope，再用宿主已有的内容搜索和文件读取工具
  检查源码。
- `task ls` 每次只返回一个路径的直属子项，稳定排序、固定输出上限，并明确返回
  是否还有下一页。它从 run 的 Pin 读取，并复用 kernel 已有的 source、scope 和
  exclude 规则。
- Java package 长单链应在 Index 和目录浏览结果的展示层做通用单链压缩；不要解析
  Java package，也不要新增语言插件。

这解决的是上下文预算、revision 一致性和跨平台可重复性。worker 若仍拥有通用
shell，它不是安全沙箱，task scope 只是防误用和保持 contract 一致的边界。

## 一手资料显示的共同经验

### 1. 工具输出会直接消耗后续上下文

OpenAI 对 Codex agent loop 的说明明确指出：工具输出会被追加到 prompt，随后再次
送给模型；对话和工具调用持续增长可能耗尽 context window。因此，无界递归目录
输出不是单纯的终端显示问题，而是模型输入问题。
[OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)

Anthropic 也把 context 视为有限且边际收益递减的资源，目标是选择能够完成任务的
最小高信号 token 集。其建议不是等待更大的 context window，而是控制哪些内容在
何时进入上下文。
[Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

这直接否定了“JSON/目录列表最终都能放进上下文，所以一次读完更简单”的假设。
JSON 格式本身不是问题；无界、重复、与当前 task 无关才是问题。

### 2. coding agent 采用地图加按需检索，而不是预载全部结构

Anthropic 描述的 just-in-time 模式保留轻量标识符，例如文件路径和已存查询，随后
通过工具按需加载；Claude Code 使用 `glob` / `grep` 渐进探索，而不是预先装入
完整数据或复杂语法树。官方同时建议采用少量预载信息加自主探索的混合策略，并
强调“do the simplest thing that works”。
[Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

OpenAI 的 agent-first 仓库经验同样把短入口文件作为地图，让 agent 再访问结构化
资料；官方称其为 progressive disclosure，原因是巨型入口会挤占任务、代码和真正
相关的文档。
[OpenAI: Harness engineering](https://openai.com/index/harness-engineering/)

对应到本项目，Source Index 适合作为 Triage 地图，不适合作为每个 Survey worker
重复读取的全源前缀。Survey 已有精确 Target 与 triage 提供的语义方向，应直接从
该范围渐进探索。

### 3. 大结果应过滤、限量或分页，默认值必须有界

Anthropic 的工具设计经验明确建议：任何可能产生大量上下文的响应，都应组合使用
分页、范围选择、过滤或截断，并设置合理默认值；它还以“返回全部联系人让模型逐项
阅读”作为低效反例。官方建议先做少数几个面向高价值 workflow 的工具，再由 eval
决定是否扩展。
[Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)

OpenAI 的 File Search 也使用过滤和结果上限；当前 API 的 `max_num_results` 限制为
1--50，而不是把全部匹配内容交给模型。
[OpenAI: Search vector store](https://developers.openai.com/api/reference/python/resources/vector_stores/methods/search)

MCP 2025-11-25 规范对可能很大的 list 操作采用 cursor pagination，让 server 决定
page size，并通过 `nextCursor` 表示后续结果。这是 list metadata 的规范，不是对
任意 tool result 的强制要求，但它确认了“大型本地列表也不应一次返回”的接口
惯例。
[MCP: Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)

GitHub 的 Git Trees API 提供了更接近仓库结构的案例：递归 tree 结果被截断时，
官方要求改用非递归请求并逐个读取 subtree。
[GitHub: REST API endpoints for Git trees](https://docs.github.com/en/rest/git/trees)

这些资料支持固定上限和显式 continuation，但不要求 v1 引入完整的 opaque cursor
框架。当前 Pin 在 run 内不可变且结果按路径稳定排序，简单的 `next_after` 足够；
将来若接口跨进程、跨 revision 持久化，再升级 opaque cursor。

### 4. 原生命令可作为实现基础，但不应成为 worker contract

Git 原生支持在指定 tree-ish 上列 tree，也支持用 pathspec 限定 `git grep` 到子树；
因此 Git Source 可以在 frozen revision 上进行局部、非递归浏览与定向内容搜索，
无需读取 live worktree。
[Git: git-ls-tree](https://git-scm.com/docs/git-ls-tree),
[Git: git-grep](https://git-scm.com/docs/git-grep)

PowerShell 官方文档说明 `Get-ChildItem -Recurse` 会遍历所有子容器；虽然 `-Depth`
可以限制层级，但默认展示还带 Attributes、LastWriteTime、Length 等字段，并且命令
作用于当前 provider 的 live 内容。这些字段和 provider 语义不是本项目 Triage /
Survey 所需 contract。
[Microsoft: Get-ChildItem](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-childitem?view=powershell-7.6)

因此 CLI 应在内部复用 Git 或 pinned files 的现有读取能力，向 worker 统一返回
POSIX 相对路径 JSON。不要把 Bash、PowerShell、Git Source、files Source 的不同
枚举规则写进 phase reference。当前 dispatch 已优先暴露 Pin 目录，所以
`Get-ChildItem` 不必然读到 live Source；剩余问题是输出形状和 scope/exclude 语义
仍由宿主 shell 决定。

## 当前实现的问题边界

### Triage

Triage 每 Source 只读一次 Index，且要据此形成 scopes，所以读取 Index 本身合理。
问题是 Index 有 64 KiB 上限：`truncated: true` 后，未保留的分支不可见，worker
只能猜测或自行递归枚举。gate 能发现覆盖错误，却不能帮助 worker 低成本发现遗漏
结构。

合理边界是：保留 compact Index；只有截断或局部不确定时，才用 `task ls` 从 `.`
或相关分支逐层补充结构。Index 中 Java 的 `src/main/java/com/...` 单子目录链应被
压缩成完整末端路径；有直属文件、发生分叉、为 leaf 或被 `survey.split` 指定的
节点继续保留。

### Survey

Survey dispatch 已含精确 source、scope、tier、orientation 和 themes。再次读取完整
Source Index 不会改变 Target 边界，却会让同一 Index 随 Survey Target 数量重复进入
上下文。之后再运行递归目录命令又重复获取结构，并让过滤和输出形状依赖宿主 shell。

因此 Survey packet 应移除 `index`。Survey 通过 `task ls` 发现 scope 内候选文件，
再用现有 `rg` / `git grep` / 宿主 search 和局部文件读取完成语义调查。CLI 负责
文件发现边界，不负责判断“重要文件”或生成源码摘要。

## 最小 CLI contract

建议只加一个 action：

```text
okf task ls <task-id> <path> --json [--after <last-path>]
```

最小响应：

```json
{
  "source": "api",
  "path": "src/main/java/com/example/orders",
  "items": [
    {"path": "src/main/java/com/example/orders/api", "kind": "directory"},
    {"path": "src/main/java/com/example/orders/OrderService.java", "kind": "file"}
  ],
  "truncated": false,
  "next_after": null
}
```

必须保证：

- task 存在且属于当前 run；Triage 可浏览该 Source，Survey 只能浏览 Target scope。
- 拒绝绝对路径、`..` 和 scope 外路径；复用 run Pin 与 workspace exclude。
- 每次只返回直属子项；无文件、无分叉的单目录链可折叠为完整相对路径。
- 路径稳定排序；server 使用一个固定 byte/item 上限，调用方不能请求“无限”。
- 超限明确返回 `truncated: true` 与 `next_after`，不能静默丢失。

暂时不返回递归统计、line count、test/generated/protected flags。Triage 已从 Index
获得这些主要信号；只有 eval 证明缺少某一个字段导致错误下钻时，才把那个字段加到
目录响应。

## 明确不做

- 不生成 per-Target file manifest：它仍可被模型整份读取，还增加生成、清理、刷新
  和 packet 字段；CLI 已覆盖相同发现需求。
- 不加 `task grep`、`task cat` 或查询 DSL：现有宿主搜索/读取工具足以完成内容检查。
- 不解析 Java package、Maven、Gradle 或语言 AST：单链冗余是通用目录树问题。
- 不新增 nested Index schema、persistent browsing cache 或兼容分支。
- 不把 task scope 宣称为安全隔离：有通用 shell 时，它只能提供确定性和正确默认值。

## 验证建议

实现前后用现有生命周期 eval 加三个小场景即可：

1. Java 长 package 单链加一个分叉，Index 和 `task ls` 不输出重复祖先层。
2. 超过一页的目录可无遗漏、无重复地继续读取，并且单次 JSON 始终低于固定预算。
3. Survey task 不能通过 CLI 浏览 scope 外文件；files Source 在 live 目录变化后仍返回
   captured Pin 的结果。

不要先增加 token 计量框架。先比较同一 fixture 下 Survey packet 字节数、目录发现
调用次数和最终 gate/e2e 是否通过；只有质量或成本仍有问题时，再扩充 eval。
