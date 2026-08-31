# 企业级 Java 仓库的 Source Index 体积实测

日期：2026-08-28  
样本：Keycloak `96fef56e18cabf1b3e89812315a97dbf20243d51`  
范围：只执行 workspace 初始化、Git clone 和 `run start`；未启动或执行 Triage / Survey。

## 结论

当前 Index 的**内容结构和 64 KiB 信息预算基本合适，但 pretty JSON 不适合作为
Triage 每次整份读取的传输格式**。实现现已切换为保留当前 100 条聚合记录和全部
语义字段的 **bounded Markdown outline**，而不是展开完整目录树/文件树；切换后仍需
Triage live eval 监测语义质量，不能只凭 token 数判断长期效果。

- Keycloak 的完整未限额 Index 是 1,543,866 bytes、2,469 条目录记录、约
  418,487 o200k tokens。当前上限把它压到 65,186 bytes、100 条记录和 18,909
  tokens，同时仍让根 POM 的 26 个主要模块全部在某个路径字段中可见，其中 25 个
  直接出现在目录记录路径中。因此 64 KiB 确实阻止了失控输入，也保住了主要结构。
- 同一份 100 条记录改成 compact JSON 后是 43,556 bytes、12,607 tokens；当前
  Markdown renderer 是 25,800 bytes、9,266 tokens。相对 pretty JSON，二者分别少
  33.3% 和 51.0% tokens；Markdown 相对 compact JSON 再少 26.5%。这证明该具体
  编码更紧凑，不证明 Markdown 天然比 JSON 更适合模型。
- 不应生成完整文件树。Keycloak 的 13,234 条完整文件路径树是 1,146,370 bytes、
  259,554 tokens，全部物理目录路径本身也有 131,148 bytes、30,418 tokens，均明显
  大于当前有界聚合 Index。完整树只是把“JSON 太大”换成更大的 Markdown。
- 不建议未经 eval 直接把信息预算降到 32 KiB：实测虽降到 9,356 tokens，却会把
  可见 `pom.xml` 从 166 降到 151，目录路径可见的主要模块从 25 降到 23。最小调整
  应是**保持当前 64 KiB 选出的 100 条记录，在 compact JSON 与 bounded Markdown
  outline 之间做质量 A/B，且不要用省下的字节继续填充更多记录**。
- 当前并不是 Survey 全量读取 Index。`triage:<source>` 的 dispatch `inputs` 含该
  Source 的完整 Index；Survey dispatch 不含 Index，并被要求从自身 scope 用有界
  `task ls` 浏览。
- 外部一手资料一致支持“小而高信号的地图 + 路径/层级线索 + 按需检索”，但没有找到
  Anthropic、Amp 或 OpenAI 对同一 repo index 做 Markdown tree 与 JSON 的直接 A/B。
  当前实现因此只替换模型可见 renderer；内部 dict、守恒断言和 gate 继续结构化，
  不增加 JSON sidecar，也不引入语义索引。
- 同类产品的共同模式不是“把完整索引交给模型”，而是**机器侧保留结构化索引，模型侧
  只看有预算的文本地图或检索片段，再按需取详情**。Aider 最接近本项目的 Source Index，
  但其 Tree-sitter/PageRank 方案与 ADR 0013 明确拒绝的 parser/ranking 基础设施冲突；
  当前只能借鉴“内部结构与模型视图分离”，不能直接照搬算法。

## 为什么选择 Keycloak

[Keycloak 官方仓库](https://github.com/keycloak/keycloak)自述为面向现代应用与服务的
开源身份与访问管理系统；固定 revision 的
[README](https://github.com/keycloak/keycloak/blob/96fef56e18cabf1b3e89812315a97dbf20243d51/README.md#L12-L16)
列出用户联邦、强认证、用户管理和细粒度授权等企业身份能力。GitHub 官方
[repository API](https://api.github.com/repos/keycloak/keycloak)标记其主语言为 Java、
默认分支为 `main`，`size` 字段为 609,230；官方
[languages API](https://api.github.com/repos/keycloak/keycloak/languages)在本次访问时返回
Java 49,530,281 / 总计 53,811,083 bytes，即 92.04%。根
[pom.xml](https://github.com/keycloak/keycloak/blob/96fef56e18cabf1b3e89812315a97dbf20243d51/pom.xml#L302-L328)
直接聚合 26 个主要 Maven 模块。因此它是足够大、Java 主导、多模块且符合企业应用
特征的实测样本。GitHub 的 `size` 是仓库元数据，本文不把它当作源码工作树体积。

本地 clone 是 771 MiB（其中 `.git` 628 MiB），包含 13,234 个 Git 跟踪文件和
8,392 个 `.java` 文件。实际执行 `source add clone --ref main` 后，`run start` 将
HEAD 固定为
[`96fef56e18cabf1b3e89812315a97dbf20243d51`](https://github.com/keycloak/keycloak/commit/96fef56e18cabf1b3e89812315a97dbf20243d51)。

## 实测结果

保留的样本 workspace：`/tmp/okf-keycloak-index-9TWmOO`  
run：`r-20260828-3f9616`  
Index：`/tmp/okf-keycloak-index-9TWmOO/.okf-wiki/runs/r-20260828-3f9616/drafts/index/keycloak.json`

| 指标 | 结果 |
|---|---:|
| Index 落盘大小 | 65,186 bytes（64 KiB 上限的 99.47%） |
| token 数 | 18,909（`tiktoken` `o200k_base`；`cl100k_base` 为 18,851） |
| compact JSON | 43,556 bytes / 12,607 o200k tokens |
| gzip -9 | 7,079 bytes |
| 顶层 `file_count` / 各记录 `files` 之和 | 13,234 / 13,234 |
| 各记录源码字节 / 行数之和 | 119,140,673 / 1,767,869 |
| 保留目录记录 | 100 |
| `collapsed_dirs` 总和 | 2,369（79 条记录非零，单条最大 315） |
| `entry_points` | 展示 217，另有 `entry_points_omitted=37` |
| `pom.xml` | 展示 166 / 仓库实际 189 |
| `truncated` | `true` |

token 数是对实际 UTF-8 文件直接编码的结果，不是按字符数猜测；它只表示 Index 本身，
尚未包括 phase reference、dispatch packet、Triage 输出和源码抽样。

### `collapsed_dirs` 和 `truncated` 的实际含义

Keycloak 跟踪文件形成 3,573 个物理目录节点（含根）。Index 先按通用规则消除 1,104
个没有直属文件且只有单子目录的中间节点，得到 2,469 个预算前候选记录；64 KiB
预算再把其中 2,369 个记录合并到最近的保留祖先，最终留下 100 条。这个差值恰好
等于所有记录的 `collapsed_dirs` 之和。

因此：

- `truncated=true` 表示预算未保留全部候选目录记录，不表示文件被丢弃；文件计数仍
  精确守恒。实现的二分选择和向最近祖先合并见
  [`_index.py` L125-L158](../../skills/repo-wiki/scripts/_index.py#L125) 与
  [`_index.py` L161-L198](../../skills/repo-wiki/scripts/_index.py#L161)。
- `collapsed_dirs` 只统计**预算阶段被合并的候选记录**，不包含之前因单子目录链规则
  而不曾成为候选记录的 1,104 个物理节点；合并累加逻辑见
  [`_index.py` L332-L337](../../skills/repo-wiki/scripts/_index.py#L332)。
- 34 个实际顶层目录中，31 个出现在目录 `path`，32 个出现在任一路径字段；未显示的
  `.idea`、`.mvn` 并非主要业务模块，`tests` 虽未成为目录记录，仍通过入口/代表路径
  可见。根 POM 的 26 个直接模块则是目录路径可见 25 个、任一路径字段可见 26 个。

### 预算敏感性

以下均用相同 commit、相同算法，只临时改变 `MAX_INDEX_BYTES` 后重新构建；没有写回
仓库或样本 run。

| pretty JSON 预算 | 记录 | o200k tokens | 主模块目录路径可见 | 主模块任一路径可见 | 可见 `pom.xml` |
|---:|---:|---:|---:|---:|---:|
| 16 KiB | 15 | 4,667 | 8 / 26 | 11 / 26 | 87 / 189 |
| 24 KiB | 25 | 6,854 | 18 / 26 | 22 / 26 | 124 / 189 |
| 32 KiB | 37 | 9,356 | 23 / 26 | 26 / 26 | 151 / 189 |
| 48 KiB | 67 | 14,090 | 24 / 26 | 26 / 26 | 158 / 189 |
| 64 KiB | 100 | 18,909 | 25 / 26 | 26 / 26 | 166 / 189 |

这说明 64 KiB 不是纯粹浪费：保留预算仍持续增加模块入口和局部结构。是否进一步降
预算应以 Triage scope 质量、`task ls` 调用量和总 tokens 的 eval 为准，不能只看文件
大小。

## JSON 字节贡献

下表对实际 65,186-byte JSON 逐项删除所有目录记录中的同名字段，再用当前
`ensure_ascii=False, indent=2` 方式重序列化。每行是独立 ablation，不能相加；它衡量
字段名、值、逗号和缩进的共同成本，不代表字段没有 Triage 价值。

| 删除字段 | 节省 bytes | 占原文件 |
|---|---:|---:|
| `extensions` | 15,321 | 23.5% |
| `entry_points` | 12,654 | 19.4% |
| `representative_files` | 9,571 | 14.7% |
| `path` | 3,335 | 5.1% |
| `entry_points_omitted` | 3,302 | 5.1% |
| `extensions_other` | 2,904 | 4.5% |
| `generated_files` | 2,803 | 4.3% |
| `collapsed_dirs` | 2,739 | 4.2% |
| `subtree_files` | 2,713 | 4.2% |
| `test_files` | 2,335 | 3.6% |
| `bytes` | 2,234 | 3.4% |
| `lines` | 2,074 | 3.2% |
| `files` | 1,891 | 2.9% |

单纯去掉缩进和换行就节省 21,630 bytes、6,302 o200k tokens，比先删除任一语义字段
收益更大。若只省略值为 `0`、`[]` 或 `{}` 的字段，pretty JSON 是 54,874 bytes / 
15,754 tokens；compact 后是 36,108 bytes / 10,526 tokens，但这会把稳定的全字段
schema 变成稀疏 schema。优先 compact、暂不稀疏化更简单，也不增加 worker 判断。

字段定义在 [`_index.py` L409-L425](../../skills/repo-wiki/scripts/_index.py#L409)；当前
预算估算和落盘都明确使用两空格 pretty JSON，分别见
[`_index.py` L233-L234](../../skills/repo-wiki/scripts/_index.py#L233) 和
[`_files.py` L10-L16](../../skills/repo-wiki/scripts/_files.py#L10)。`extensions`、入口和
代表文件正是 Triage 路由的重要信号，所以体积 ablation 不能单独证明应删除它们。

## Markdown 候选实测

对同一个已截断为 100 条记录的 Keycloak Index 做纯序列化对照；bounded Markdown
outline 保留顶层元数据以及每条记录的全部统计、扩展名、入口、代表文件和省略计数，
只把重复 JSON key 改成一次说明后的紧凑行和子项。完整目录/文件树则直接从同一 Pin
的跟踪路径生成，不经过 100 条记录的聚合。

| 模型可见表示 | bytes | o200k tokens | 相对 pretty JSON |
|---|---:|---:|---:|
| 当前 pretty JSON，100 条聚合记录 | 65,186 | 18,909 | 基线 |
| compact JSON，同 100 条记录/字段 | 43,556 | 12,607 | -33.3% |
| bounded Markdown outline，同 100 条记录/字段 | 23,144 | 8,801 | -53.5% |
| 当前 Markdown renderer，同 100 条记录/字段 | 25,800 | 9,266 | -51.0% |
| 全部 3,573 个物理目录路径 | 131,148 | 30,418 | +60.9% |
| 全部 13,234 个文件路径树 | 1,146,370 | 259,554 | +1,272.7% |

这里真正有效的是**有界聚合和去除重复语法**，不是 `.md` 后缀本身。完整文件树比当前
Index 多约 13.7 倍 tokens；即使只列物理目录，也多约 61%。因此“目录树 + 文件树”若
指完整展开，应直接排除；可进入 eval 的候选只是带层级线索的 bounded outline。

## 外部一手资料

### 产品事实与公开建议

- Anthropic 的
  [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  把目标定义为最小的高信号 token 集，并建议用轻量标识（文件路径、查询、链接）配合
  工具按需加载。它还明确把目录层级和命名视为导航信号，并说明 Claude Code 采用
  `CLAUDE.md` 预载、`glob`/`grep` 按需检索的混合模式。这支持“小地图 + `task ls`”，
  不支持预载完整文件树。
- Anthropic 的
  [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
  明确说 XML、JSON、Markdown 等响应结构会影响 eval，但不存在一种通用最优格式，
  应按具体 task 和 agent 评测；对大输出应使用分页、范围、过滤或截断。它直接否定了
  “Markdown 天然优于 JSON”的推论。
- Amp 当前
  [AGENTS.md 文档](https://ampcode.com/docs/customize/agents-md)
  建议大型仓库保持顶层说明通用，把细节放进各子项目；子树说明在 agent 读取该子树文件
  后才进入上下文。这也是渐进披露，而非一次塞入全仓明细。Amp 的
  [context management guide](https://ampcode.com/guides/context-management)也描述了文件
  截断和需要时继续读取，但页面已标为 2025 年旧模型时代的 archived guide，本文不把
  它当成当前格式建议。
- OpenAI Docs 的
  [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  使用从仓库根到当前目录的分层说明，并把自动加载的项目说明默认限制在 32 KiB。
  这支持“短的全局方向 + 更靠近工作区的局部信息”，但该上限针对指令文件，不是
  repo index 的推荐预算，也没有比较 JSON 与 Markdown。
- OpenAI 的
  [Understand large codebases](https://learn.chatgpt.com/use-cases/codebase-onboarding)
  建议先给相关文件、目录或功能范围，要求模型形成模块/流程地图并指出下一批应读文件；
  这与 Triage 先路由、Survey 再定向读取的分阶段设计一致。
- OpenAI 的
  [model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  报告其内部 coding-agent eval 中更精简的 system prompt 同时改善分数并减少 tokens，
  但也明确要求在自己的代表性任务上验证。方向性数据能证明“精简值得测”，不能证明
  “换成 Markdown 就会更准”。

### 未找到的公开证据

没有找到 Anthropic、Amp、OpenAI/ChatGPT 对**同一份 repo index**做 Markdown tree 与
JSON 的准确率、召回率或 token A/B。Amp 的
[官方 GitHub 组织](https://github.com/ampcode)公开的是编辑器集成、扩展和示例等仓库，
没有公开核心 agent 实现可用于核验其内部 repo-map 序列化。因此以下建议属于结合官方
原则与 Keycloak 实测得到的项目推断，不是厂商背书。

## 同类产品与改进方案

下面把产品分成两类，避免把“生成 Wiki 的端到端系统”与“Triage 如何获得仓库上下文”
混为一谈。表中内容是官方文档、论文或官方源码能核验的**产品事实**；表后的项目建议
才是对 repo-wiki 的推断。未公开的 prompt 包装、top-k 或 token 上限明确记为未知。

### Context / repo-map 引擎：与 Index / Triage 机制可比

| 产品 | 预加载给模型的内容 | 机器侧索引 / 排序 | 按需检索 | token / 规模控制 | 模型可见格式 |
|---|---|---|---|---|---|
| [Aider repo map](https://aider.chat/docs/repomap.html) | 每次请求附一份相关仓库地图，而非全文件内容 | Tree-sitter 抽取定义/引用，构图后用 PageRank 排序；聊天中提到的文件和标识符会加权 | 模型据地图请求具体文件 | `--map-tokens` 默认 1k；[源码](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)按 token 预算二分选择 tags | 路径、缩进、`...` 与选中的类/函数签名组成的纯文本 outline；内部 tags/graph/cache 不暴露给模型 |
| [Sourcegraph Cody](https://sourcegraph.com/docs/cody/core-concepts/context) | 默认聊天带当前打开文件及当前仓库标识，不预载完整索引 | Sourcegraph Search、关键词搜索和 code graph；Enterprise 已不依赖 embeddings | `@` mention 或 [agentic context fetching](https://sourcegraph.com/docs/cody/capabilities/agentic-context-fetching)搜索、读取相关文件/片段 | [token limits](https://sourcegraph.com/docs/cody/core-concepts/token-limits)按模型和上下文类型分别设限 | 模型看到相关代码片段；公开文档没有给出稳定的片段包装、排序公式或 top-k |
| [Continue](https://docs.continue.dev/guides/codebase-documentation-awareness) | Repo-map provider 可给出文件列表及顶层类/函数/方法签名，可限定整个仓库或子目录 | [官方 indexing 源码说明](https://github.com/continuedev/continue/blob/main/core/indexing/README.md)列出 Tree-sitter、SQLite FTS5、分块与向量索引等内部构件 | 当前 Agent 推荐文件探索和搜索工具；旧 `@Codebase` provider 已 [deprecated](https://docs.continue.dev/reference/deprecated-codebase) | 大上下文可关闭 `includeSignatures`；索引按内容哈希/branch tag 增量维护 | Repo map 是文件/签名文本；搜索索引本身不进入 prompt，具体 chunk 包装和统一 token 上限未公开 |
| [Cursor](https://cursor.com/blog/secure-codebase-indexing) | 不公开预载整仓地图；agent 通过语义搜索取得上下文 | Merkle tree 做增量同步，源码按语法切块并生成 embeddings，chunk 可缓存 | 语义检索；[dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery)把长工具结果落盘后按需 tail/read | `.gitignore`、`.cursorignore`、`.cursorindexingignore` 控制范围；长结果延迟加载 | 模型得到检索出的源码上下文，不会看到 Merkle/vector 索引；稳定 wrapper、top-k 和 repo-map token cap 未公开 |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | 不预载完整知识图谱，通过 MCP 工具取局部结果 | Tree-sitter 符号、跨文件解析、聚类和流程抽取；BM25 + semantic search + reciprocal-rank fusion，存入 LadybugDB graph | `query`、`context`、`impact`、`trace` 等工具 | `query`/`context`/`impact` 支持 `maxTokens`，按 4 UTF-8 bytes/token 估算并截断；浏览器模式约 5k files，CLI 面向更大仓库 | 模型看到有界 MCP 返回，不看到内部 graph；README 未承诺 JSON 或 Markdown 这一固定模型格式 |

Aider 是最直接的格式参照：它同时证明了“机器内部可以很结构化”和“模型视图可以是
短文本 outline”，而不是要求二选一。Cody、Continue、Cursor 和 GitNexus 则进一步
显示，仓库越大，越倾向把完整索引留在检索层，只把命中的路径、签名或代码片段送入
prompt。它们没有提供“完整 Markdown 文件树优于 bounded JSON”的证据。

### Wiki 生成器：与最终产物目标可比

| 产品 / 论文 | 官方可核验的生成方式 | 规模 / 覆盖控制 | 对本问题的边界 |
|---|---|---|---|
| [DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki) | 自动索引仓库并生成带架构图、摘要和源码链接的 Wiki；Ask Devin 将 Wiki 与代码搜索结合 | `.devin/wiki.json` 可显式给 `repo_notes` 和 `pages`；官方说明大型仓库可能因内建限制遗漏重要目录，可用 pages 指定 | 证明“自动聚类规划仍需显式覆盖控制”；内部索引、排序、prompt 格式未公开，不能据此判断 JSON/Markdown |
| [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki) | coding agent 负责调查、规划和写作，OpenWiki 管理持久队列、claims 校验和确定性 finalization；输出 Markdown OKF 与证据 sidecar | [架构文档](https://github.com/langchain-ai/openwiki/blob/main/openwiki/architecture/overview.md)把探索和长文留在 agent/磁盘，最终产物和证据分离 | 更接近 repo-wiki 的产物与 gate，而非 Source Index；其 code-mode 流程未公开一个可照搬的预计算 repo map |
| [CodeWiki, ACL 2026](https://aclanthology.org/2026.findings-acl.288/) | 先用静态依赖图做 top-down 层级分解，再由 divide-and-conquer agents 生成，最后 bottom-up synthesis | 论文面向七种语言，并用层级 rubric 与 agentic assessment 评估 Wiki；报告全仓直接 prompting 在大型仓库上退化 | 支持分阶段、分层覆盖和最终质量 eval，不证明应给 Triage 增加语义排序，也不比较 JSON/Markdown |

这三项和 repo-map 引擎回答的是不同问题：Wiki 生成器表明大仓库需要层级拆分、覆盖
约束和证据 gate；repo-map 引擎才直接说明“模型在某一步应看什么上下文”。因此不能用
CodeWiki 的依赖图或 DeepWiki 的自动索引，反推 Source Index 必须升级为语义索引。

### 对 repo-wiki 的推断（非外部产品事实）

1. **可借鉴的是分层表示，不是复杂排序。** 当前 `_assemble` 的 dict、守恒断言与
   Triage scopes gate 对应机器层；bounded Markdown outline 可以作为模型层。这个分工
   与 Aider、Continue、Cursor、GitNexus 的公开架构一致，但是否提升本项目质量仍须 eval。
2. **不要完整文件树。** 同类产品均采用 budget、检索或相关性裁剪；Keycloak 的完整树
   又已实测为 259,554 tokens。把 `.json` 改成无限 `.md` 会背离产品经验和本项目数据。
3. **不引入 Tree-sitter、PageRank、embeddings 或 knowledge graph。** 这些技术在 Aider、
   Continue、Cursor、GitNexus 中有价值，但 ADR 0013 明确拒绝 parser/ranking 基础设施，
   且当前 Index 定义为不声称 semantic importance 的结构摘要。没有 Triage 召回失败的
   eval 证据时，引入它们会同时扩大依赖、缓存失效、语言覆盖和可解释性风险。
4. **保留 `task ls` 的按需补充角色。** 它已经实现同类产品的渐进披露模式，并保持 Pin、
   scope 和字节边界；当前问题是首包表示成本，不是缺少一个新检索平台。

### 按收益 / 改动风险排序的最小路线

| 顺序 | 方案 | 预期收益 | 风险 / 决策 |
|---:|---|---|---|
| 1 | 冻结同一 100 条记录和字段，离线 A/B pretty JSON、compact JSON、bounded Markdown，并跑真实 Triage eval | 直接回答格式是否影响总 token、scope 质量和工具调用；无需改 runtime | 最低风险，立即可做；以质量不降且整次 Triage token 显著下降为接受条件 |
| 2 | 已实施：只替换**模型可见 renderer**；内部 dict、选择算法、64 KiB 信息预算、守恒断言、Triage artifact 和 `task ls` 不变 | Keycloak 样本从 compact JSON 的 12,607 降至 9,266 tokens，并保留全部现有信号 | 已同步 phase reference、tests 和 e2e grader；后续用 live eval 监测语义质量 |
| 3 | 若 eval 暴露特定目录遗漏，只调整现有确定性记录优先级或 `task ls` 触发说明，一次改一个信号 | 可能改善边缘 coverage，同时保持语言无关 | 中风险；必须用失败样本证明，不应把节省的格式字节自动换成更多预载记录 |
| 4 | Tree-sitter/PageRank、embeddings、code graph 或新 repo query 层 | 理论上可提高相关性和跨文件导航 | 高风险且与 ADR 0013 冲突；当前明确 defer，只有可复现的质量缺口和 ADR 修订后再讨论 |

这条路线保持 ADR 0013 的核心不变：每 Source 一个有界结构摘要、一次 Triage、精确文件
覆盖、歧义时按需 `task ls`，Survey 不读取 Index。近期唯一值得验证的变化只是同一信息
的模型可见编码，不是把 Source Index 重新定义成 repo map、semantic index 或完整树。

## 对 repo-wiki 的判断

当前 Source Index 同时有两个角色，但没有必要让它们共享同一种落盘语法：

- 确定性 kernel 在 `_assemble` 中先用 dict 建立分区、合并记录并断言文件数守恒，见
  [`_index.py` L161-L198](../../skills/repo-wiki/scripts/_index.py#L161)。这些保证应继续
  留在结构化代码和测试里。
- 当前落盘的 Source Index 之后没有被 runtime 反序列化来执行 gate；dispatch 只是把
  路径交给 Triage，见
  [`_state.py` L533-L571](../../skills/repo-wiki/scripts/_state.py#L533)。真正被 gate 校验的
  是 Triage 输出的 scopes，而不是 Source Index 的 JSON 语法。

所以技术上可以只把**模型可见的 Source Index**渲染成 Markdown，同时保留内部 dict、
守恒断言和结构化 Triage artifact。当前没有第二个运行时消费者，不应预先增加一个同内容
JSON sidecar；若未来出现机器消费者，再为那个实际需求提供结构化接口。

实施更新（2026-08-28）：按用户决定，模型可见的 Source Index 已切换为 bounded
Markdown，同时冻结原有 100 条记录、全部字段和 JSON 体积选样算法。当前 renderer 对
同一 Keycloak payload 是 25,800 bytes / 9,266 tokens，相对 pretty JSON 少 51.0%
tokens，相对 compact JSON 少 26.5%；独立 Python 脚本已将全部 100 条记录反向重建并
验证相等，也覆盖了含换行、反引号、pipe 和 Markdown link 的文件名。

这只证明序列化无损且更小，不证明 Triage 语义质量不变。后续 live A/B 应对同一模型、
prompt、仓库 revision 重复运行，并至少记录：

- Triage gate 通过率、修复重试次数和非法/幻觉路径数；
- scope 边界与 tier 是否保住入口、认证、安全、迁移和公开 contract；
- Index 输入 tokens、后续 `task ls`/源码采样 tokens、总 tokens、工具调用数与延迟；
- 下游 Survey 的 finding 覆盖与证据质量，防止 Triage 自身更短却把成本或遗漏推后。

回归接受条件仍应是 Markdown 在这些质量指标上不劣于 compact JSON，同时显著降低
**整次 Triage 总 tokens**；若 live eval 失败，应回退模型可见 renderer，不改变内部
dict、选择算法或 gate。

## 谁会读取 Index

`run start` 为每个 revision 调用 `write_source_index`，随后创建一个 Triage target，见
[`_state.py` L226-L250](../../skills/repo-wiki/scripts/_state.py#L226)；Index 从 Pin 的全部
非 exclude 文件确定性构建，见
[`_index.py` L107-L122](../../skills/repo-wiki/scripts/_index.py#L107)。

dispatch 的实际分支在
[`_state.py` L533-L571](../../skills/repo-wiki/scripts/_state.py#L533)：只有
`phase == "triage"` 才把 `drafts/index/<source>.md` 加入 `inputs`；Survey 不进入该
分支，只有 Triage 和 Survey 都会收到 `ls_command`。运行规约也一致：

- [`references/triage.md` L3-L17](../../skills/repo-wiki/references/triage.md#L3)
  要求一次读取 packet 列出的完整 compact Index，仅在 `collapsed_dirs` 非零或结构
  不清楚时对单个目录分页 `task ls`。
- [`references/survey.md` L3-L9](../../skills/repo-wiki/references/survey.md#L3)
  明确写着 `do not read the Source Index`，而是从既定 scope 浏览和定向读取源码。
- [`test_scopes_and_connect.py` L175-L189](../../skills/repo-wiki/scripts/tests/test_scopes_and_connect.py#L175)
  锁定了 Survey packet 不含 Index 且目录浏览不能越出 scope。

所以当前上下文成本是“每个 Source 的 Triage 一次性读取一份 Index”，不是“每个
Survey target 重复读取完整 Index”。compact JSON 的 12.6k tokens 与当前 Markdown
的 9.3k tokens 都是单次、单 Source 成本；若未来一份 run 注册很多超大 Source，仍应
按每 Source 独立评估总 Triage 成本。

## 复现

本次实际命令使用 `--ref main`，`run start` 固定了当时 HEAD。为复现相同内容，应直接
使用 commit：

```bash
WORKSPACE=$(mktemp -d /tmp/okf-keycloak-index-XXXXXX)
OKF=/home/cyberspace/projects/open-okf-wiki/skills/repo-wiki/scripts/okf.py
cd "$WORKSPACE"
uv run "$OKF" workspace init --lang zh --freshness-days 90 --json
uv run "$OKF" source add clone https://github.com/keycloak/keycloak.git \
  --name Keycloak --ref 96fef56e18cabf1b3e89812315a97dbf20243d51 --json
uv run "$OKF" run start --json
uv run "$OKF" run status --json
```

当前 lifecycle 预期停在 `phase: "plan"`。结构 Index 位于 status 返回的
`run_dir/index/Keycloak.md`；运行时应通过 bounded evidence 命令导航，而不是读取该内部文件。
