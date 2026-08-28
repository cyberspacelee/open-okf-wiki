# Repo Wiki Greenfield Redesign：面向数千文件企业仓库

日期：2026-08-28
范围：不考虑现有 contract、artifact 或 lifecycle 兼容性。资料只采用官方仓库、官方文档和论文。

> 本文是 ADR 0015 的研究输入，不是运行契约。最终实现采用有界
> `plan/page/review` DAG 与 `outline/search/read`，暂不包含 symbol service、
> 动态 split 或跨 Run 缓存；运行行为以 `skills/repo-wiki/SKILL.md` 为准。

## 结论

不要让模型“归入并分析全部文件”，也不要简单改成“一 package 一个任务”。推荐结构是：

```text
Pinned repository
  -> workspace / build-module family
  -> build module
  -> source set
  -> package/directory cluster
  -> symbol outline
  -> exact source range
```

前五层是确定性导航；只有被选中的语义 cluster、symbol 和源码片段进入 LLM。最终文档 Target
按“系统、能力、端到端 flow”定义，package 只是候选边界。执行采用 **scheduler-owned、可扩展但有上限的
DAG**，不是六段全局流水线，也不是 agent 自由递归派生 agent。

建议 lifecycle：

```text
snapshot + index (kernel)
  -> outline/plan (一次、全局有界)
  -> research+write page jobs (并行 DAG)
  -> evidence gate + independent semantic review (逐页)
  -> synthesize parent/root pages (依赖已验证 child pages)
  -> publish (kernel)
```

## 一手资料的直接启示

| 系统 | 已验证的做法 | 对本方案的含义 |
|---|---|---|
| [Aider repo map](https://aider.chat/docs/repomap.html) | Tree-sitter 提取定义/签名，用依赖图排序，在 token budget 内只给最相关 map；需要时再读文件 | 全仓地图应短且可下钻，symbol skeleton 比逐文件正文有效；PageRank 不是 v1 必需品 |
| [SWE-agent ACI](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md) | 文件查看器每次约 100 行；全仓搜索只列命中文件，过多 match context 会干扰模型 | 搜索先返回路径/命中数，再按范围展开；工具输出必须有界 |
| [Agentless](https://arxiv.org/abs/2407.01489) | 用 repository tree 做 file -> class/function -> line 的分层 localization；采用简单固定 workflow 而非复杂 agent 自主规划 | 先粗后细有效；每增加 agent/phase 都应有 eval，而非默认存在 |
| [OpenHands CodeAct](https://docs.openhands.dev/openhands/usage/agents) / [paper](https://arxiv.org/abs/2402.01030) | 用 shell/Python 统一 action space，通过 action-observation loop 迭代 | 页面 worker 可自主搜索和读源码；无需为每种调查动作造 phase 或专用 artifact |
| [Continue context selection](https://docs.continue.dev/ide-extensions/agent/context-selection) | agent 结合文件内容、LSP definitions、imports、最近文件与工具结果选 context；旧 `@Codebase` RAG 已被 agent exploration 取代 | 默认用原生探索、搜索和符号导航，不先建 embedding 基础设施 |
| [Serena](https://github.com/oraios/serena) / [memories](https://github.com/oraios/serena/blob/main/docs/02-usage/045_memories.md) | LSP/IDE 提供 symbol、reference 和 overview；memory 先给名称，再由 agent 主动读取 Markdown | symbol 工具按需下钻；长内容留磁盘，dispatch 只放名称、路径、计数 |
| [OpenWiki architecture](https://github.com/langchain-ai/openwiki/blob/main/openwiki/workflows/repository-generation.md) | `begin -> plan -> next_page -> submit_page -> finish`；每页独立持久化、验证和恢复；规划避免 exhaustive file inventory | 一次 bounded plan 加 durable page jobs 足够；无需独立 triage/connect |
| [CodeWiki paper](https://aclanthology.org/2026.findings-acl.288.pdf) | 依赖/语义 module tree、leaf 调查、bottom-up parent synthesis；超预算时动态拆分 | 模块 DAG 与父子综合有效，但不必照搬全语言依赖图和自由递归 delegation |
| [RepoAgent paper](https://arxiv.org/html/2402.16667) | Python AST/Jedi 建 project tree 和 caller/callee DAG，按 code object 生成并按 Git 变更更新 | 确定性关系适合路由和失效；“每对象都写文档”不适合 thin wiki 或数千文件仓库 |

这些项目研究的任务和评测不同，不能横向比较分数。这里采用的是反复出现的设计证据：有界地图、
粗到细 localization、符号级按需读取、独立持久化单元和依赖驱动综合。

## 1. Module / Package / Symbol 层级导航

### Kernel 必须看见全部文件，但不做全部语义分析

1. 在不可变 revision 上枚举所有受管文件，应用 ignore/generated/vendor policy，保存路径、大小、语言和 digest。
2. 从原生 manifest 建 workspace/build tree：Maven/Gradle modules、npm/pnpm workspaces、Cargo crates、Go modules、
   Bazel packages 等。没有 manifest 时才退化为目录树。
3. 在 module 内识别 main/test/generated/resources source set。测试和资源附着到生产 cluster，不创建镜像任务。
4. 展示 package/directory tree，折叠无分叉长链；节点只给文件数、主语言、manifest、entrypoint/public surface。
5. 对当前选中节点按需生成 symbol outline：定义种类、签名、所在范围、imports/references。优先复用 LSP；
   LSP 不可用时用已有 Tree-sitter grammar，最后退化到文本搜索。

不要把 Java package 当架构真相：同名 package 可跨 module，配置/迁移/模板没有 package，一个业务 flow
也常跨 `api/service/model/persistence`。因此 planner 从 build/module/package 获得候选，再按 entrypoint、
公共接口、状态 owner、依赖和运行 flow 合并为 page scope。

最小 worker 导航面只需四类能力：

```text
outline(path)              # 直属 children、统计、折叠提示
symbols(path, depth=1)     # 类/函数/方法签名，不带完整 body
search(pattern, scope)     # 先返回命中文件和数量
read(path, line_range)     # 固定最大窗口，可继续翻页
```

`find references` 可直接复用 LSP 能力，不另造 graph query DSL。所有返回都绑定 Pin、稳定排序、限字节，
并显式报告 truncation/continuation。

## 2. 固定阶段是否必要

| 原阶段 | Greenfield 判断 | 替代 |
|---|---|---|
| Triage | 删除独立阶段 | outline/plan 一次选择系统、flow、seed paths 和 page frontier |
| Survey | 删除独立 handoff | page worker 在同一 session 调查并写作，避免 findings 被二次转述和源码重读 |
| Connect | 删除全局阶段 | 跨模块关系由 parent/root synthesis node 消费已验证 child claims，并可按需重开证据 |
| Plan | 保留能力，不保留多级 phase | 一次 bounded page plan；任务超预算时由 scheduler 局部 split/replan |
| Write | 保留为 page job 的结果 | 一页一个 durable job；可并行，不建立全局 Write barrier |
| Review | 保留为独立角色/节点 | kernel 先验 locator/link/schema；reviewer 重新打开关键证据检查语义 |

Review 是否必须取决于产品承诺。若输出只标 `draft/evidence-linked`，可只做确定性 gate；若声明
`machine-confirmed`，必须有独立 reviewer。作者自评和 locator 存在性都不能证明论断正确。

## 3. 固定 Pipeline、DAG 还是递归 Delegation

采用 **小的固定外壳 + 动态任务 DAG**：

- 固定外壳只负责 snapshot/index、最终 publish 和失败恢复。
- `outline/plan` 产生 page nodes；独立 module/flow page 可并行。
- parent overview 明确依赖 child page 通过 gate/review；跨模块 page 依赖相关 leaf pages。
- task 可返回 `complete | skip | split`。`split` 只是提议；scheduler 验证 scope 不越界，并限制深度、children、
  总 task 数和 token budget，再建立 child nodes。
- 每页单独 checkpoint、retry、invalidate；一个失败不回滚 sibling。

不采用全局阶段 barrier：慢 module 不应阻塞无关页面。不采用 agent 自由递归 delegation：任务规模、成本、
依赖和失败状态会藏进会话，难以复现。CodeWiki 的递归说明这种方法可行，但不证明它比受控 DAG 更值得。

## 4. 上下文渐进披露

每个 worker 从最小上下文开始，按下面顺序主动展开：

```text
L0 dispatch: task id、page purpose、seed paths、预算、artifact paths
L1 repo map: build-module tree + 已有 page/claim 名称
L2 local map: 当前 module/package children + public symbol signatures
L3 relation: imports、callers/callees、tests、配置与迁移命中
L4 evidence: 精确源码 range；只有形成或核验 claim 时读取 body
```

稳定的 index、source extract 和 child artifacts 留在磁盘；协调器只传路径与计数。新 task 使用新 context，
不要携带完整前序对话。父节点优先读 child 的短 claims/page，再按争议点重开 Pin；不能规定“下游禁止读源码”。

页面 claim 至少记录 `revision + path#Lx-Ly`。kernel 可派生 evidence window/cache，但 cache 可删可重建，
不能成为事实来源。增量运行按 changed paths、symbol/reference impact 和 page evidence 失效，不按“整个 source 重跑”。

## 5. 不应先引入的复杂技术

- 不建 embedding/vector DB 或全仓 semantic RAG；先用路径、`rg`、LSP 和显式引用，只有 localization eval 失败再加。
- 不要求统一全语言 AST/call graph/knowledge graph，更不引入 graph DB；build metadata + 可选 LSP 已覆盖首版导航。
- 不做 LLM 文件 coverage ledger、每 package Target、每 symbol 文档或“全部文件总结”；它们与 thin wiki 目标冲突。
- 不做自由递归 multi-agent、角色群聊、debate 或 writer 自己扩容；只允许 scheduler 建有界 child tasks。
- 不为 triage/survey/connect 分别保存大 JSON；页面、claims/review report 已是足够的 durable boundary。
- 不默认生成图表、示例和 API catalog；只有页面目的需要且能绑定证据时生成。
- 不先实现 PageRank、语义聚类、自动复杂度模型或通用 invalidation engine；先用 manifest、入口、符号引用和硬预算。

## 验证顺序

先用三类真实仓库做同 revision 对照：大型 Java multi-module、JS/TS monorepo、混合语言仓。记录导航/源码 token、
LLM 调用数、墙钟时间、无证据 claim、重复页面、人工发现的关键遗漏和增量重写页数。消融顺序应是：

1. baseline：module tree + `rg/read` + 一次 plan + page DAG；
2. 加 LSP symbol/reference；
3. 只有 file/page localization 仍显著失败，再试 Tree-sitter dependency ranking；
4. 只有 lexical/symbol 检索仍漏掉跨词汇概念，再试 embeddings。

任何新阶段或索引技术都必须证明：它减少的遗漏或成本，大于它新增的 token、延迟、失败模式和维护面。
