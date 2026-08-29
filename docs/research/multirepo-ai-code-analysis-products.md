# 多仓 AI 代码理解产品设计调研

日期：2026-08-29
范围：只采用产品官方文档、官方博客和官方源码仓库。重点判断公开可验证的产品边界，
不把“支持多仓”推断成某种未公开的 agent 拓扑。

## 结论

公开产品形成了清晰的两层设计：**仓库或工作副本是索引与新鲜度边界，多仓集合是查询
与任务边界**。Sourcegraph、Augment、GitHub Copilot 和 Cursor 都让一个查询或 agent
从多个已索引仓库中按需取回上下文；DeepWiki 和 Factory AutoWiki 则主要按仓生成 Wiki。
GitHub Copilot Fleet 已公开“并行研究独立 repositories，再由父 agent 汇总并验证”的
通用编排模式，但没有找到任何一手资料证明 Wiki 规划固定采用“每仓一个分析 agent，再
由一个 agent 合成”的 `n + 1` 拓扑。

因此，外部证据支持 repo-wiki 的**分层方向**，但不能证明固定 `n + 1` 调用次数就是
最优算法。结合本项目 Kill Bill 四仓中单 planner 的领域遗漏，合理的最小实验是：在
`plan:workspace` 内并行运行 `n` 个有界 Source scout，再由唯一 workspace synthesizer
生成 Page Plan；不新增 Target、Compose artifact 或兼容层。

## 产品对比

### Devin DeepWiki：逐仓 Wiki，跨仓问答

- 索引操作明确以 repository 为单位，并逐仓选择 branch；DeepWiki 的控制文件
  `.devin/wiki.json` 位于仓库根目录。默认页面结构采用 `cluster-based planning`，也可
  由用户给出完整的层级 page list 后重新生成。官方还明确承认大仓自动规划可能漏目录或
  组件。[DeepWiki 文档](https://docs.devin.ai/work-with-devin/deepwiki)、
  [索引仓库](https://docs.devin.ai/onboard-devin/index-repo)
- 生成物是每仓的层级 Wiki、架构图、摘要与源码链接。官方 MCP 的
  `read_wiki_structure` / `read_wiki_contents` 也都接收单个 GitHub repository；另一个
  `ask_question` 工具才支持一次查询一个或多个仓库，最多十个。
  [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp)
- 未公开：多仓统一 Wiki、增量索引算法、cluster/page 与 agent 的对应关系、独立 Wiki
  review gate。现有质量控制是 repo notes、显式页面树、重新生成和源码链接，不是自动
  审查阶段。

这说明“先保留仓库局部知识，再在查询层跨仓”是直接产品先例；但 DeepWiki 没有解决
repo-wiki 所需的单一 workspace Wiki，因此不能直接照搬“每仓各出一套页面”。

### Factory AutoWiki：多阶段多 agent，但仍是一仓一 Wiki

- AutoWiki 明确以 repository 为生成和发布单元，每仓得到一套结构化 Markdown Wiki，
  并可同步到该仓的 GitHub Wiki；Factory App 的顶层视图也是多份 repository Wiki 的
  列表。[AutoWiki 文档](https://docs.factory.ai/software-factory/wiki/overview)、
  [Wiki Browser](https://docs.factory.ai/software-factory/wiki/web-viewer)
- 官方公开生成是多阶段、多 agent：先做结构扫描与语义扫描，再规划 Wiki，最后按依赖
  顺序生成页面。专门 agent 按 repository 的不同 facet 获得隔离上下文，而不是按关联
  repository 固定分片。[AutoWiki 发布说明](https://factory.ai/news/wiki)
- 首次运行分析全仓；后续按上一 Wiki 记录的 commit 做 diff，只重新生成受影响页面，
  未变化页面原样保留。[AutoWiki 发布说明](https://factory.ai/news/wiki)
- 未公开：多仓统一 Wiki、每阶段 worker 数、survey handoff schema、独立语义 review
  gate。官方示例在发布前仍称为供团队 review/customize 的生成预览。

AutoWiki 直接验证了“大代码库 Wiki 不宜由一个 agent 线性完成”，也验证了唯一规划和
依赖顺序页面生成；但其分工维度是结构/语义/facet/page，而不是仓库数。这支持引入 scout，
不支持把 `n + 1` 写成不经评测的固定合同。

### Sourcegraph Deep Search：逐仓索引，共享 scope 内由一个 agent 聚合

- Sourcegraph 默认给每个 repository 的 default branch 建 Zoekt 索引，未索引 revision
  走另一条搜索路径；仓库 Git 数据更新后，全局搜索索引通常在数分钟内自动更新。
  [架构](https://sourcegraph.com/docs/admin/architecture)、
  [仓库更新频率](https://sourcegraph.com/docs/admin/repo/update-frequency)
- Search Context 是“多个仓库在指定 revisions 上的集合”。Deep Search 在所选 context
  中运行一个 agentic loop，反复调用搜索和代码导航工具；官方示例明确覆盖跨仓服务消费
  链、依赖盘点，并可生成 CSV/JSON/SVG 后继续过滤、join 或补充。
  [Search Contexts](https://sourcegraph.com/docs/code-search/working/search-contexts)、
  [Deep Search](https://sourcegraph.com/docs/deep-search)
- 输出是有 sources 列表的 Markdown 答案或结构化 artifact，不是持久化 Wiki/Page
  DAG。用户检查 sources 并追问缺失项是显式的人类质量反馈；没有公开自动 review gate。
- 未公开：大查询是否内部按 repository 分派 worker。官方公开的是一个 agent loop 和
  sandbox 中的有界脚本/搜索结果压缩，不能据此推断 `n + 1`。

这是 `n + 1` 的主要反例：当底层跨仓检索、聚合与结构化计算足够强时，一个 shared-scope
agent 可以完成工作。但它也建议缩小 repository scope 以提高速度和质量，说明扩大共享
上下文并非免费。

### Augment Context Engine：多仓索引与统一检索分层

- Remote Context Engine 自动索引 GitHub App 选中的各仓 default branch，并在 push 时
  更新；本地模式实时索引 working directory。官方明确声称 retrieval 能理解 repos、
  services 与 architectures 之间的关系。
  [Context Engine MCP](https://docs.augmentcode.com/context-services/mcp/overview)
- 其多来源产品允许同时索引多个仓、文档站和内部 Wiki，再通过一个 MCP
  `codebase-retrieval` 能力提供给任意 agent；这暴露的是统一检索接口，不是内部分析
  worker。[Context Engine MCP 产品页](https://www.augmentcode.com/product/context-engine-mcp)
- 官方工程文章披露个人实时索引、分支切换后数秒更新以及租户内重叠索引共享，但没有披露
  多仓请求如何分解成模型调用。
  [实时索引设计](https://www.augmentcode.com/blog/a-real-time-index-for-your-codebase-secure-personal-scalable)
- 没有 Wiki/page 生成或 Wiki review gate；其 code review 是 Context Engine 的另一个
  消费者，不能当作文档审查阶段。

它支持 repo-wiki 继续复用已有 per-Source Index，并让 synthesis 消费多个 Source，而不
支持为 scout 新增持久化公共 Target。

### Cursor：multi-root 共享 session，显式并行但不按仓固定拆分

- Multi-root workspace 会把多个 codebase 全部索引并提供给 Cursor；当前一个 agent
  session 可直接跨 frontend、backend 和 shared libraries 修改。
  [multi-root 发布说明](https://cursor.com/changelog/0-50)、
  [跨仓 agent session](https://cursor.com/changelog/04-24-26)
- Cursor 使用 Merkle tree 只同步变化的文件/目录，并按语法 chunk 缓存 embeddings，
  因而新鲜度维护是增量的。
  [安全索引设计](https://cursor.com/blog/secure-codebase-indexing)
- `/multitask` 会把大任务拆成较小任务交给异步 subagents，但官方没有说拆分维度是仓库，
  也没有把它描述成 multi-root 索引或跨仓理解的实现。
  [Multitask](https://cursor.com/changelog/04-24-26)
- 没有自动 Wiki/page plan 或 Wiki review gate；Markdown chat export 不是受管理文档生成。

Cursor 证明“单 shared session”和“显式 subagent fan-out”可同时存在，却没有证明应让
仓库数量决定 agent 数量。repo-wiki 的 Source scout 应由多仓漏召回问题触发，而不是把
`n + 1` 固化成通用 agent 规律。

### GitHub Copilot Spaces：仓库级索引，人工策展的多仓上下文

- GitHub 为 repository 建语义索引；首次索引后台运行，后续通常在新会话开始后数秒内
  更新，而且可索引的仓库数量不限。
  [Repository indexing](https://docs.github.com/en/copilot/concepts/context/repository-indexing)
- 一个 Space 可以包含多个完整仓库、文件、PR、Issue 和文本。附加整仓时不会把全仓放进
  prompt，而是在查询时检索相关内容；GitHub 来源随项目变化自动更新，Space 始终引用
  `main` 最新版本。
  [Spaces 概念](https://docs.github.com/en/copilot/concepts/context/spaces)、
  [创建 Space](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/copilot-spaces/create-copilot-spaces)
- 官方把附加 repository 定位为在一次对话中比较或切换多个仓库，但没有公开跨仓排序、
  worker 数、依赖图或 synthesis 流程。
  [代码库探索教程](https://docs.github.com/en/copilot/tutorials/explore-a-codebase)
- Space 是人工维护的共享上下文，不自动生成 Wiki/Page DAG，也没有自动文档 review gate。

Spaces 的启示是把“哪些仓属于一个 workspace”建模为显式输入；它不支持为每仓分析结果
再增加长期中间层。

### GitHub Copilot Fleet：最接近 `n scouts + 1 synthesizer` 的公开编排

- Fleet 由主 agent 先判断任务能否拆成独立子任务，再作为 orchestrator 管理依赖和并行
  subagents；每个 subagent 有独立 context window。[Fleet 概念](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet)
- SDK 文档把“并行研究独立 repositories、services 或 feature areas”列为适用场景，
  示例 prompt 是分别研究各 crate 后汇总计划；同时要求一个 worker 只拥有一个 todo、
  handoff 简洁、最后由 parent 验证组合结果。
  [Fleet mode](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/fleet-mode)
- 官方也明确提示更多 subagent 会增加模型交互和 credits；连续共享推理、强顺序依赖或小
  任务不适合 Fleet。[Fleet 概念](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet)
- Fleet 是通用任务编排，不是 Wiki 产品，也没有规定一个 repository 必须对应一个
  subagent。任务拆分是自适应的。

这是对 repo-wiki 内部 `Source scout x n -> workspace synthesizer` 最直接的外部支持：
仓级研究可以独立并行，Page Plan 综合必须串行且由父 worker 核验。它同时否定“所有场景
机械执行 `n + 1`”：是否 fan-out 应由多仓复杂度和评测收益决定。

### Greptile：逐仓知识图谱，关联仓作为 review context

- Greptile 公开流程先为 repo 构建 files/functions/dependencies 图索引，再用并行 agent
  swarm 审查 PR。其索引 agent 会持续 crawl repository，并维护描述代码及关系的
  “living internal wiki”。
  [产品流程](https://www.greptile.com/)、
  [索引与 internal wiki](https://www.greptile.com/blog/nvidia-nemotron-ultra-in-code-review)
- `context.repos` 可为某仓 review 显式加入 shared libraries、SDK 等关联仓的只读上下文。
  [Multi-Repo Context](https://www.greptile.com/changelog)
- Review agent 使用工具循环递归追踪多跳调用；公开 swarm 是围绕 PR finding 并行，而不是
  “每仓一个 scout”。[agentic review](https://www.greptile.com/blog/greptile-v3-agentic-code-review)
- internal wiki 不是面向用户的页面制品，也没有公开其 schema、跨仓 synthesis 或质量门。
  Greptile 的 PR 审查和运行时验证属于代码变更质量门，不能视为 Wiki 质量门。

这是最接近“仓库局部 map + 任务级跨仓 context + 并行 agents”的公开设计，但仍不足以
证明固定 `n + 1`。

## 对 repo-wiki 的设计判断

建议实现下面的内部策略并做 A/B，而不是修改生命周期合同：

```text
plan:workspace
  Source scout x n          # 每个只产出有界、带 Locator 的 brief
  workspace synthesizer x 1 # 唯一 Page Plan/DAG 写入者，核验跨仓两端
review:plan                 # 现有独立召回与边界质量门
```

理由：

1. 它复用了本项目已有的 per-Source Index，与各产品“仓库级新鲜资料、工作区级消费”的
   分层一致。
2. 它针对本地实测的单 planner 召回遗漏；外部产品并未给出可替代这项本地证据的固定
   agent 拓扑。
3. synthesizer 必须独占 page path、owner、`depends_on` 和最终 evidence seeds。若 scout
   各写 Plan，会退化为多个 per-repo Wiki，丢失 repo-wiki 的跨仓领域页面目标。
4. scout brief 只保留 Source 角色、候选概念、少量 Locator、跨仓对端和 gaps；不引入
   新 Target 或 Compose Gate。Sourcegraph/Deep Search 的有界中间结果也表明，综合层应
   消费压缩结果而非完整探索轨迹。
5. `review:plan` 仍有必要。检索产品普遍只提供 sources、配置 steering 或人工追问，没有
   可借用的自动 Wiki 质量门；repo-wiki 的“遗漏主题不会生成下游 Target”需要自己的独立
   召回检查。

验收应比较单 planner 与内部 `n + 1`：领域 rubric 召回、跨仓两端 Locator、Page 数量、
Plan review 重开次数、uncached tokens、导航调用和 wall time。只有固定多仓评测证明 scout
brief 本身需要独立重试、缓存或失效管理时，才考虑把它提升为持久化 Target；在此之前，
新增公共 `source-analysis` 类型没有外部证据，也没有本地必要性。
