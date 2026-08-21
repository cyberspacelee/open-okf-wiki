# pi-llm-wiki 实现分析

日期：2026-08-19；当前 HEAD 复核：2026-08-20

## 范围与证据边界

本笔记分析 [zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)：Karpathy LLM Wiki 模式在 Pi / oh-my-pi 上的实现。克隆在 [`refs/pi-llm-wiki`](../../refs/pi-llm-wiki)，HEAD `547a2219578fe3584fe37adaeed897b1075b72da`（2026-08-14，tag `v0.11.4`）。树内 [`package.json`](../../refs/pi-llm-wiki/package.json) 仍写 `0.6.3`（`package.json:2-4`）；本文分析固定到 git tree，不用 npm registry 或 README 的版本文字反推实现。

一手来源：

- Karpathy 的模式说明：[LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- 实现仓库：[`refs/pi-llm-wiki`](../../refs/pi-llm-wiki) 的 README、`docs/architecture.md`、`docs/api.md`、OKF Foundation spec、extension 源码
- 本仓库：[`CONTEXT.md`](../../CONTEXT.md)、[`ARCHITECTURE.md`](../../ARCHITECTURE.md)、[ADR-0001](../adr/0001-isolated-full-generation-runs.md)

已有笔记 [pi-extension-and-dynamic-workflows.md](pi-extension-and-dynamic-workflows.md) 只把它定性为「不是同类 wiki」。本文拆实现。事实与对本仓库的推论分开。

## 结论

1. **这是宿主会话里的增量知识库，不是一次隔离生成。** 它把 Karpathy 三层（raw / wiki / schema）做成 Pi extension：捕获不可变 source packet、后台合成 entity/concept 页、每轮 recall 注入、机械 lint。知识随会话累积。本仓库是 pinned Sources 上的独立 Run，Published Wiki 只作 provenance。
2. **阶段流程抽成 slash-command prompt，不是 host 状态机。** 机械工作在工具 + hook（源码实际是 **14 个常驻工具**，trajectory 打开后 17 个；另有 2 个宿主命令）。Karpathy 的 ingest / query / lint 等操作是 `prompts/wiki-*.md`：用户打 `/wiki-query …`，Pi 把模板展开成这一轮的 user prompt，**同一个主会话**按 Steps 调工具。只有 `/wiki-model`、`/wiki-trajectories` 是 `registerCommand` 的宿主 handler，不进模型。没有 Board / nextAction。工具注册证据见 `extensions/llm-wiki/index.ts:100-145`；14 个常驻名分别落在 `lib/tools.ts`、`lib/recall.ts:939-1063`、`lib/retro.ts:101-176`、`lib/observation.ts:142-245`。
3. **机械层做得深，语义层故意浅。** YAML 解析、OKF dual-read、逐文件 atomic projection、path guardrail、hybrid recall、cache-safe injection、pi/omp 双宿主，都是 host-owned。注意「atomic」只指每个投影文件 temp+rename，不是 registry/backlinks/index/log 的跨文件事务（`lib/metadata.ts:112-143,355-361`）。页面拓扑按 type bucket（`entities/`、`concepts/`、`syntheses/`），ingest 只写 source 摘要 + 一行 entity/concept stub，跨源 thesis 靠模型后续手写。
4. **对本仓库值得学的是 extension 工程，不是 wiki 产品模型。** 尤其：volatile recall 不进 system prompt；ingest/rebuild/reindex 这类重工作可后台化并用 `nextTurn` 上报；compaction/shutdown 前 drain 后台任务；Pi 与 MCP 复用 domain functions；invalid config fail-closed。capture/ensure/observe/retro 仍先同步写权威页、只把 reindex 放后台，不能概括成「所有 mutating 工具立刻返回」。

## 1. 它是什么

### 1.1 Karpathy 模式

Karpathy gist 把「每次问题都从 raw 重做 RAG」和「中间层 wiki 持续编译」对立：raw 不可变；wiki 由 LLM 维护；schema 约束惯例；ingest / query / lint 是三种操作；好答案可以再归档成页。Obsidian 当 IDE，LLM 当维护者。gist 明确不规定目录和工具。

pi-llm-wiki 把这个模式做成可安装包：`pi install npm:@zosmaai/pi-llm-wiki`。新 vault 默认 `knowledge_format: okf-0.2`。

### 1.2 和本仓库的产品差

| | pi-llm-wiki | 本仓库 wiki-workflows |
|---|---|---|
| 时间模型 | 增量、跨会话累积 | 一次隔离的完整 Run |
| 证据 | 用户随时 capture 的 URL/文件/粘贴 | 声明并 pin 的 Git Source |
| 页面拓扑 | type bucket：`wiki/entities/`、`wiki/concepts/`… | 页在 concept 旁：`<domain>/<concept>/concept.md` |
| 会话角色 | 宿主主会话 + 后台 sub-agent | Lead / survey / write / review |
| 出版 | 无；vault 就是正在用的 wiki | Candidate → host validation → Published Wiki；独立 review 目前未强制 |
| Pi 的位置 | 扩展即产品 | 薄 adapter；生产在 host module |
| 检索 | 每轮自动 recall + 工具 | Run 内读 Candidate / Source，不注入跨项目记忆 |

本仓库推断：两边都写 Markdown wiki，但控制面不可互换。把 pi-llm-wiki 的 recall/ingest 接进 production Lead，会把「本次生成」和「历史个人笔记」混进同一 context。

### 1.3 分发面

一个包三套入口：

- **Pi**：`package.json#pi.extensions` → `./extensions`，`pi.skills`、`pi.prompts`、`pi.mcpservers`
- **oh-my-pi**：`omp.extensions` 指向 `extensions/llm-wiki/index.ts`（必须是文件，不能是目录）；slash command 走生成的 `commands/` 镜像
- **MCP stdio**：`dist/mcp/index.js`，给 Claude Code / Cursor / Windsurf

Peer：`@mariozechner/pi-coding-agent`、`typebox`。omp 在加载时把 `@mariozechner/pi-*` 改写到自己的 bundled packages，所以模块图不 fork。

## 2. Vault 与所有权

布局见 [`docs/architecture.md`](../../refs/pi-llm-wiki/docs/architecture.md)：

```
.llm-wiki/
  config.json
  raw/sources/SRC-YYYY-MM-DD-NNN/   # 不可变 packet
  raw/trajectories/TRJ-*            # opt-in 工作记忆
  wiki/{sources,entities,concepts,syntheses,analyses,cases,skills}/
  meta/{registry.json,backlinks.json,index.md,log.md,events.jsonl,embeddings.json}
```

所有权：

| 路径 | 所有者 | 规则 |
|---|---|---|
| `raw/**` | extension | capture 后按协议不可变；Pi guardrail 只拦内置 `write` / `edit`，不是文件系统权限 |
| `wiki/**` | 模型 + 用户 | 可编辑知识页 |
| `meta/events.jsonl` | extension 工具 | 权威、append-only；rebuild 不能重建 |
| `meta/**` 其余 | extension | 生成投影 |
| OKF 模式下的 `wiki/index.md`、`wiki/log.md` | extension | 生成投影，guardrail 只读 |

解析顺序实际是：cwd 自身 vault → 显式 `$WIKI_HOME` → cwd 祖先 vault（跳过作为祖先出现的 personal root）→ personal root。它还 dual-read 旧 `.wiki/` 布局；不是只认 `.llm-wiki/`。见 `lib/utils.ts:148-199,216-240`。因此 `$WIKI_HOME` 会压过祖先 project vault，原先写成「先向上找再看 `$WIKI_HOME`」不准确。

显式 `wiki_recall` 同时搜 primary + personal，但实现的合并顺序是 **personal first，再 primary**；按 page id 去重时 personal 同名页占先，并且最终再截到 `maxResults`（`lib/recall.ts:557-605`）。这和旧笔记的「project 优先」相反。自动注入传 `includePersonal=false`（`index.ts:285-311`），准确含义是「不追加 secondary personal 层」：有 project vault 时只搜 project；若 Pi 在无 project vault 时按默认 ambient 规则把 personal vault 解析成 primary，它仍会搜 personal，不是绝对的「只搜 project」。

Ambient 门控（2026-08 的 omp 适配）：session notice、observe/retro 提醒、自动 recall 只在「当前目录适用 wiki」时开火。omp 默认 `ambientPersonalVault: false`（插件全局加载）；pi 默认 `true`（历史行为，`lib/task-config.ts:106-125,154-165`）。工具和 slash command 始终注册，所以 `/wiki-init` 在任何目录都能用。`session_start` 的静默 auto-bootstrap 也在这个 gate 之后：omp 的普通无 wiki 仓库默认不会被自动建库，Pi 的 personal ambient 路径则会（`index.ts:150-181`）。

「raw 不可变」是 extension 协议而非强隔离。`tool_call` hook 只识别 Pi/omp 的 `write` 和 `edit` 事件（`lib/guardrails.ts:196-220`）；shell、第三方自定义 mutation tool、MCP 之外的文件编辑器仍可改磁盘。路径判断本身较严：会解析已有 symlink 祖先，无法安全解析时 fail closed（`lib/utils.ts:415-458`）。

本仓库对应物是 Workspace / Run / Candidate / Published Wiki，不是 personal+project 双 vault。

## 3. 模块地图

`extensions/` 下 10,747 行 TS；连 `mcp/` 生产代码共 11,448 行。`test/`（含 helper）12,268 行、48 个 `*.test.ts`。职责按文件：

| 模块 | 行数 | 职责 |
|---|---|---|
| `extensions/llm-wiki/index.ts` | 342 | 工厂：注册工具/命令/hook，ambient 门控，cache-safe 注入 |
| `lib/tools.ts` | 1374 | 11 个常驻工具的 Pi 注册与参数（recall / retro / observe 在各自模块） |
| `lib/recall.ts` | 1063 | 词法评分、PRF、hybrid 融合、links-first、layered search |
| `lib/metadata.ts` | 672 | fail-closed 投影：registry / backlinks / index / log |
| `lib/knowledge-document.ts` | 663 | 共享 YAML 解析/序列化，legacy + OKF |
| `lib/trajectory.ts` | 627 | opt-in 工作记忆：capture / distill / recall_skill |
| `lib/ingest-worker.ts` | 557 | 结构化合成 + 确定性 `commitSynthesis` |
| `lib/source-extractors.ts` | 536 | URL/PDF/HTML/DOCX/JSON/XML 抽取 |
| `lib/embeddings.ts` | 518 | 写时向量 sidecar，查询路径零 LLM |
| `lib/guardrails.ts` | 253 | `tool_call` 拦 raw/meta；`turn_end` 触发 rebuild |
| `lib/runtime.ts` | 273 | 后台 lane：single-flight、模型解析、drain、report |
| `lib/host.ts` | 125 | pi vs omp 的 settings 布局 |
| `lib/wiki-service.ts` | 183 | Pi 与 MCP 共用的 search/status |
| `mcp/operations.ts` | 219 | MCP 薄适配，禁止自写业务规则 |

48 个测试文件不只覆盖 guardrail、ingest 并发、OKF 投影、host 兼容、MCP parity、ambient 门控，也锁住 mutation writer fail-closed、后台 reindex coalescing/dirty drain、YAML parser limits、Unicode identity collision、legacy repair、cache-safe injection、embedding staleness/query cache，以及构建后 MCP JSON-RPC 子进程 smoke。代表性证据：`test/mutation-guards.test.ts:60-142`、`test/indexing.test.ts:109-166`、`test/knowledge-document.test.ts:40-147`、`test/vault-format.test.ts:93-151`、`test/agent-start-injection.test.ts:9-69`、`test/mcp-package.test.ts:51-126`。

但「LLM 边界收成一次 structured tool call」主要是**实现设计**，不是端到端锁住的协议。确定性 `commitSynthesis` 文件行为覆盖充分（`test/ingest-worker.test.ts:64-223`）；真实 `agentLoop → commit_synthesis → commit` 没有 fake-model event-stream 集成测试。`runSubAgent` 的直接测试只有空 prompt 早退（`test/runtime.test.ts:266-285`），ingest language 测试 mock 了 `runSubAgent`（`test/ingest-worker-synthesis-language.test.ts:45-103`）。

## 4. 扩展生命周期

工厂 `export default function (pi: ExtensionAPI)` 做的事：

1. **先建 `Runtime`**，让后续工具能 `launchTask`。
2. **注册 14 个常驻工具和 2 个命令**（trajectory 三件套除外，由 `llm-wiki.trajectories` 在工厂时决定；toggle 会 `/reload`）。完整注册序列在 `index.ts:100-145`。上游注释、API 文档和状态条仍写 13/16：`index.ts:59-60`、`docs/api.md:5-8`、`lib/visible-status.ts:42-47`；实际应是 14/17。这是当前 HEAD 内部事实漂移，不应把状态条数字当 tool inventory。
3. **`turn_start`**：按 `ctx.cwd` 重载 runtime config（`lib/runtime.ts:253-261`）。
4. **`session_start`**：修复 doubled personal vault；按 `process.cwd()` `ensureConfig`；ambient 关闭则返回；resolved vault 没有 `config.json` 才静默 `bootstrapVault` 并标 `needsTopicInference`（`index.ts:150-227`）。
5. **`before_agent_start`**：topic 推断指令 + hybrid recall。静态 `<wiki_status>` footer 进 system prompt；volatile 内容进 `display: false` 的 tail message（`index.ts:229-340`，issue #92）。
6. **`tool_call` / `tool_result` / `turn_end`**：guardrail 只观察 built-in `write` / `edit`；写命中 wiki 后在 turn end **调度**后台 metadata+embedding reindex，不等待它完成（`lib/guardrails.ts:196-252`、`lib/indexing.ts:46-83`）。
7. **`agent_end`**：observe/retro reminder 计数并按间隔发 `nextTurn` message（`lib/observation.ts:247-291`）。
8. **`session_before_compact` / `session_shutdown`**：`runtime.awaitAll()` drain 受 Runtime 跟踪的任务（`lib/runtime.ts:263-270`）。`awaitAll` 是无超时循环，也不主动取消任务（`lib/runtime.ts:233-242`），所以「不静默丢」成立，但不能推成有界 shutdown。

Runtime 的 live 状态主要是 label→promise、reminder counter，以及 `indexing.ts` 的模块级 per-vault `dirty` / `inflight`。drain 的单测直接覆盖 `awaitAll()`（`test/runtime.test.ts:246-263`），acceptance 测试多次走 `session_shutdown`；当前没有测试经 `session_before_compact` hook 挂入 pending task 再证明 drain。

### 4.1 Cache-safe 注入

`lib/inject.ts` 把注入拆成：

- **稳定前缀**：`appendWikiStatus` 幂等追加 `<wiki_status>…</wiki_status>`，abort/retry 不会叠多份。
- **易变尾巴**：recall 命中、topic 推断。进 `customType: wiki-recall-context` 消息，不改 system prompt。

这条 byte-level 契约有直接回归测试：不同 recall 内容必须得到相同 system prompt，footer retry 后仍恰好一份，volatile block 必须是 hidden tail message（`test/agent-start-injection.test.ts:19-69`）。

本仓库推断：若以后要在 Lead 会话注入 Board 以外的动态上下文，应走 message/tail，不要改 system prompt，否则 prompt cache 每轮失效。Board 已经是文件，Lead 自己 `read`，这条压力较小。

## 5. 捕获与合成

### 5.1 Source packet

`wiki_capture_source` 三选一：`url` / `file_path` / `text`。写出：

```
raw/sources/SRC-YYYY-MM-DD-NNN/
  manifest.json
  original/
  extracted.md
  attachments/
```

并落一页 skeleton `wiki/sources/SRC-….md`（`status: skeleton`）。抽取在 `source-extractors.ts`：HTML→markdown、MarkItDown 转 PDF（超时 `WIKI_MARKITDOWN_TIMEOUT_MS`）、magic-byte 拦二进制。事件写入 `events.jsonl` 时故意不抄本地绝对路径（只留 source id），完整路径留在 raw manifest。

细节证据：packet 总会建 `attachments/`，URL/file 才建 `original/`；local file 的绝对 `file_path` 会进入 `manifest.json`，capture event 只写 format（`lib/source-packet.ts:114-173,176-204`）。capture 本体与 skeleton 写入在工具返回前同步完成，只有随后 O(pages) metadata/embedding reindex 被 `scheduleReindex` 移到后台（`lib/tools.ts:199-240`）。因此它不是「所有 mutation 都立即返回、后台落盘」。

### 5.2 Ingest：一次 structured call + 确定性 commit

这是最能代表其 LLM 边界的设计。

`wiki_ingest` 默认 `background: true`：

1. 扫 `raw/sources/SRC-*`，对照 registry 里非 `skeleton` 的 source 页，默认取 3 条、最多 5 条（`lib/tools.ts:282-320,333-379`）。显式 `source_id` 即使已经 ingested 也会被重新放进 batch（`lib/tools.ts:350-365`），所以它不只是「处理未 ingest」。
2. `Runtime.resolveModel`：per-call `model` > `taskModel` > session model。解析失败则退回同步：把 extracted 文本交给主会话，由主会话自己写页。
3. 解析成功则 `launchTask`，主工具立刻返回「不要自己合成」。

后台 `runIngestSynthesis`：

- 截断 extracted 到 24k 字符。
- 调 `runSubAgent`（对 `agentLoop` 的薄封装，`toolExecution: sequential`）。
- 子代理只暴露一个工具 `commit_synthesis`，schema 是 summary / takeaways / entities / concepts / quotes / contradictions（`lib/ingest-worker.ts:35-75,510-553`）。「EXACTLY ONCE」只写在 system prompt；execute 没有二次调用 guard，所以不是 host-enforced cardinality（`lib/ingest-worker.ts:450-463,516-539`）。
- `commitSynthesis` 是纯文件 I/O：把 source 页标为 `ingested`、缺的 entity/concept 建 stub（已存在则只记为 linked、不覆盖）、`appendEvent`；外层 `runIngestSynthesis` 在 committed 后再 `rebuildMetadataLight`。
- 标题语言可配 `synthesisLanguage`（BCP 47）；heading 有 ru/fr/de/ja 表。

调度粒度是每个 source 一个 `ingest:${sourceId}` label，batch 内可并发；single-flight 只去重同 source label，不是全局 ingest 串行 lane（`lib/tools.ts:393-460`、`lib/runtime.ts:155-181`）。后台调用没有把 `wiki_ingest` 的 tool AbortSignal 传给 `runIngestSynthesis`，故只能靠 session 边界等待，不能靠原工具取消。

`commitSynthesis` 也不是事务：按 source page → entity pages → concept pages → append event 的顺序直接写（`lib/ingest-worker.ts:324-445`），之后 `runIngestSynthesis` 才 rebuild metadata（`lib/ingest-worker.ts:545-556`）。中途进程失败可能留下部分写入；「确定性」指同一结构化输入的 host-owned 写盘规则，不等于 atomic commit。

Karpathy 说「一条 source 可能改 10–15 页」。这里的自动合成更窄：source 摘要 + 新建 stub。跨页修订、synthesis 页、矛盾仲裁仍靠主会话的 skill 流程（`/wiki-ingest`、`/wiki-query` 提示词）。

本仓库对应物是隔离的 `write` subagent + Candidate。两边都把模型写作限制在 host
给出的路径和工具内；差别是 pi-llm-wiki 的 `commit_synthesis` 由 host 按结构化 schema
落盘，而本仓库 writer 直接用 `write/edit` 写 Candidate，再由 host 做机械校验。当前
review 仍是 prompt-level optional，不应描述为已强制的结构化 contract。

### 5.3 Retro / observe / trajectory

三条记忆通道，刻意分层：

| 工具 | 存什么 | 何时 |
|---|---|---|
| `wiki_observe` | 带 relevance 的短观察 | 任务中途，extension 会提醒 |
| `wiki_retro` | 一条 insight markdown | 任务结束 |
| `wiki_capture_trajectory` | 可重放的 tool-call packet | opt-in；再 distill 成 skill/case |

Skill 文档写明：Pi 自带 observational-memory 是散文，保 compaction 存活，不存 tool 名/参数/结果。trajectory packet 才是可蒸馏的回放记录。默认关闭（issue #80），避免三件套占 system prompt。

本仓库不需要 trajectory：Run 的 Lead session、Board 和 Candidate 已经是恢复所需工作
状态，而且不得把跨 Run 蒸馏出的隐式知识当成下一次 Run 的 Source。

## 6. Recall

`lib/recall.ts` 是最大单文件。纯词法 scorer 同步、离线且不调生成模型；hybrid 入口在已有 sidecar 且配置 embedder 时会做一次可缓存的 query embedding 网络调用，失败就退回词法（`lib/recall.ts:654-704`）。所以「查询热路径不调 LLM」只能理解为不跑 generative agent，不能理解为永远零网络。

词法：NFKC 正规化、保留 CJK、kebab 当空格、CJK bigram/trigram、字段加权（title/alias/trigger > heading > body）、chunk 级最佳预览、伪相关反馈。

语义（opt-in）：写时把页面向量写入 `meta/embeddings.json`（content hash + model 做 stale）。查询只 embed 一次短 query（session 内缓存）。融合：

```
fused = lexical + semanticWeight × 12 × max(cosine, 0)
```

默认 `semanticWeight = 0.5`。自动注入 `minScore = 5`：纯语义命中大约 cosine ≳ 0.84 才过线。无 embedder 时字节级退回纯词法。embedding 有独立 API key，不会因为存在 `OPENAI_API_KEY` 就自动打开。

Links-first（issue #68）：`registry.json` 页数 > `recallLinksThreshold`（默认 50）时，注入排名链接 + 一行 snippet，不塞普通页全文。skill/case 页可按 `recallSkillInlineMax` 内联短 body，因为蒸馏技能需要立刻能用。自动注入只搜 resolved primary vault，不追加 secondary personal 层。

更精确地说，阈值是严格 `pageCount > 50`；显式 recall 的 pageCount 会把 primary + personal registry 相加，自动注入只数 primary（`lib/recall.ts:716-752`）。skill/case 默认可内联 1,600 字符，即使 links-first 也例外（`lib/recall.ts:761-803,846-929`）。自动注入的 secondary personal 关闭，但 primary 若本身就是 ambient personal 仍会搜索，见第 2 节。

Layered merge 不是按全局 score 混排。实现先各取每个 vault 的 top N，再按 `[...personalResults, ...primaryResults]` 去重和截断；personal 结果可占满额度，重名 id 也遮住 project（`lib/recall.ts:565-605`）。这是比「同时搜两个库」更重要的实际排序语义。

`wiki_search` 是 registry 子串查找，无评分、无分层，给「已知名字」的定位。

本仓库推断：production 不该每轮往 Lead 塞 wiki 正文。Board 已经是剩余工作的投影。若以后要给 writer 做页内检索，可学「热路径无 LLM + 大库 links-first」，但检索域应是当前 Candidate，不是 `~/.llm-wiki`。

## 7. Guardrail 与投影

### 7.1 拦截写

`installGuardrails` 在 `tool_call`：

- `write`：单 path，命中 `raw/**`、`meta/**`、非法 vault config、OKF 生成的 `wiki/index.md`/`log.md` 则 `block`。
- `edit`：从 apply-patch / rename 输入里抽出全部目标 path。抽不全则直接 block（「无法确定编辑目标」），避免漏网。

这两个 bullet 的作用域必须写清：它只拦 event type 恰好为 `write` / `edit` 的工具，不拦 shell 或任意第三方 mutation tool（`lib/guardrails.ts:196-220`）。对 `edit` 的 parser 支持 path/paths、常见 destination key、hashline patch header 和 move；未知 patch shape fail closed（`lib/guardrails.ts:16-171`）。

`tool_result` 若写了 `wiki/**`，打 `pendingRebuild`；`turn_end` 调 `scheduleReindex`。

`tool_result` 不看写工具是否成功，只要 input 指向 `wiki/**` 就置模块级 `pendingRebuild`；`turn_end` 再按当时 `process.cwd()` 解析 vault 并调度（`lib/guardrails.ts:222-252`）。`scheduleReindex`：微 yield 让 hook 先返回；按 vault dirty-flag drain；single-flight；rebuild 成功后才按需 embed。N 次写通常合并成一次 O(pages) 扫描，写发生在 pass/embedding 期间则再跑 trailing pass（`lib/indexing.ts:46-83`）。

### 7.2 Fail-closed 投影

`rebuildMetadata`：先 `inspectVaultFormat`（非法 `knowledge_format` 阻塞），再发现文档（NFC / 大小写碰撞阻塞），内存里建齐 registry、backlinks、index、log、OKF 目录 index，然后逐文件 temp+rename 写出。`events.jsonl` 缺失时警告并不覆盖已有 log 投影，其它投影继续（`lib/metadata.ts:65-143,355-383`）。这是「validation fail-closed + 单文件原子替换」，不是跨投影事务：进程可在若干 rename 之间退出，obsolete index pruning 也在写新 index 后单独执行（`lib/metadata.ts:118-136,385-435`）。

`wiki_lint` 是确定性扫描：orphan（无 inbound）、broken link、矛盾标记 `⚠️ **Contradiction`、coverage gap。`auto_fix` 只给被 ≥2 页引用的缺口建 stub，矛盾不自动裁。

本仓库已经把 `index.md` 作为 host-generated projection，并在 publish 前校验 Candidate；
但当前没有 review invalidation、publication journal 或跨进程 publication lease。参考实现
值得对齐的是 fail-closed document discovery、collision 检查和 derived projection owner，
不能据此高估当前安装事务。

## 8. OKF Foundation

[`docs/superpowers/specs/2026-08-02-okf-foundation-design.md`](../../refs/pi-llm-wiki/docs/superpowers/specs/2026-08-02-okf-foundation-design.md) 是规范性 child spec。已落地的部分：

- 一个 parser（`yaml` 包），不是 legacy/OKF 两套。拒 alias、自定义 tag、多文档、>128KiB frontmatter、>32 层嵌套。
- 模式管投影，不管可读性：两种模式都 dual-read。缺 `knowledge_format` 的旧 vault 当 `legacy`；新 bootstrap 写 `okf-0.2`。
- 概念 id = NFC 正规化的 bundle 相对路径去掉 `.md`。`index.md`/`log.md` 保留。
- 新页走 OKF canonical；改旧 legacy 页保留其 frontmatter 形状，不偷偷迁移。
- 未知字段 round-trip 语义保留。
- Pi 与 MCP 复用底层 domain functions，但不是所有能力都经过一个统一 `wiki-service`。`wiki-service.ts` 直接承载 registry search/status；MCP recall 调共享 `searchWikiLayered`，capture/retro/bootstrap 分别调共享 writer（`mcp/operations.ts:9-21,46-219`）。MCP 适配器本身不 parse YAML、scan 或实现 score，这条 ownership 成立。

未做（Interchange / Intelligence child）：bundle import/export、review staging、transaction、trust-aware recall、Attested Computation 执行。

本仓库的 OKF 身份是「从仓库 Source 生成、经独立审查后安装的 Published Wiki」。pi-llm-wiki 的 OKF 身份是「Obsidian 兼容 vault 作为可携带 bundle」。Foundation 的 parser 约束（拒 alias/自定义 tag、未知字段存活、生成 index 只读）和本仓库 frontmatter 方向一致；page topology 和出版治理不一致。

## 9. 后台 Runtime 与双宿主

`Runtime` 从 pi-observational-memory 的模式移植：

- `launchTask(label)`：detached promise，同 label single-flight，错误 `ui.notify`，不抛进主循环；没有 timeout/cancel primitive。
- `launchReported`：完成后 `sendMessage({ customType: wiki-action-report, deliverAs: nextTurn })`，并 toast 第一行。
- `resolveModel`：缺模型或 API key 返回 `{ ok: false }`，调用方走同步降级，而不是失败整个会话。
- 捕获 `ctx.hasUI` / `ctx.ui` 的同步快照，避免 await 之后碰到 fork/reload 的 stale proxy。

`lib/host.ts` 解决 pi（`.pi/settings.json`）和 omp（`.omp/config.yml`）的布局分叉：project settings 同时枚举 `.pi` / `.omp`，active host 目录最后赢；同目录内 `config.yaml` > `config.yml` > `settings.json`。global settings 只从当前 `getAgentDir()` 读。写入永远是 JSON `settings.json`：优先已有 active-host 目录，其次已有 foreign 目录，否则建 active-host 目录，不改用户手写 YAML（`lib/host.ts:31-125`）。`LLM_WIKI_HOST` 可强制。

MCP 面固定 6 个工具：bootstrap、recall、search、status、capture、retro（`mcp/index.ts:64-330`；清单断言 `test/mcp-parity.test.ts:206-216`）。没有 ingest sub-agent、observe、lint、rebuild、embedding 或 trajectory。bootstrap 用 `getVaultPaths(WIKI_ROOT)` 而不是 `resolveVaultPaths()`，避免在「解析落到个人库」的地方建库（`mcp/index.ts:31-50,70-82`）。

「MCP parity」也要收窄：MCP recall 调同步 `searchWikiLayered`，是纯词法、没有 query embedding 和 links-first renderer；Pi `wiki_recall` 调 `searchWikiHybrid`（`mcp/operations.ts:68-90` 对 `lib/recall.ts:977-1059`）。parity tests 比较的是 MCP operation 与直接 shared function，不是完整 Pi tool adapter 的参数/文本/错误 parity（`test/mcp-parity.test.ts:47-171`）。真正打包后 MCP 入口有 JSON-RPC 子进程 smoke（`test/mcp-package.test.ts:51-126`）；Pi/omp 双宿主则是 manifest、settings 和 mock extension harness 覆盖，没有启动真实 host 的 E2E。

测试还有两个需记录的边界。其一，prompt/command 只做 byte parity，未执行 SOP；动态镜像断言见 `test/package-structure.test.ts:58-75`。其二，`test/mcp-parity.test.ts:97-130` 没 sandbox `WIKI_HOME`：没有 personal vault 时直接 return，有时会改真实 personal wiki 的固定测试页并 rebuild metadata，是 non-hermetic 测试，不应作为 layered recall 在干净 CI 中必然被覆盖的证据。

## 10. 阶段 prompt 与 slash command

Karpathy gist 把 wiki 维护拆成 **Ingest / Query / Lint**，并把「怎么做」放进 schema 文档（CLAUDE.md / AGENTS.md），让**同一个 agent** 按文档执行。pi-llm-wiki 把这套拆成 Pi 的三种资源，而不是写成 TypeScript 状态机：

| 资源 | 路径 | 谁消费 | 何时进模型 |
|---|---|---|---|
| 常驻 skill | `skills/llm-wiki/SKILL.md` | Pi skill 发现 | 模型按需读；描述约定、所有权、何时 recall/retro |
| 阶段模板 | `prompts/wiki-*.md`（`pi.prompts`） | Pi prompt-template 展开 | 用户打 `/wiki-*` 时，整份 markdown 变成这一轮 user prompt |
| omp 镜像 | `commands/wiki-*.md` | oh-my-pi 只扫 `commands/` | `scripts/build-commands.js` 从 `prompts/` 字节复制，测试锁 parity |
| 宿主命令 | `pi.registerCommand` | extension handler | **不进模型**：改 settings / reload |
| 后台子代理 prompt | `INGEST_SYSTEM`（`ingest-worker.ts`） | `agentLoop` | 仅 background ingest；主会话看不到 |
| 环境注入 | `inject.ts` / `observation.ts` | hook | 每轮 footer、recall tail、observe/retro 提醒 |

这就是「提供 command，且 prompt 是抽出来的」：阶段 SOP 是独立 markdown，工具只做机械动作。

### 10.1 Pi 契约：两种 slash command

Pi 官方把 `/name` 分成两类，生命周期不同。[prompt-templates.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md) [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

1. **Prompt template**（`prompts/*.md`）：文件名去掉 `.md` 就是命令名。frontmatter 有 `description`、`argument-hint`。正文里 `$ARGUMENTS` / `$1` 被替换后，**作为普通用户消息**交给当前 agent。extension `registerCommand` 先于 `input`；`input` 先于 template 展开。
2. **Extension command**（`pi.registerCommand`）：handler 在宿主跑完就结束，不触发「按这份 SOP 思考」的一轮。

pi-llm-wiki 把阶段操作做成第 1 类，把开关做成第 2 类：

| 用户输入 | 类型 | 效果 |
|---|---|---|
| `/wiki-init` `/wiki-discover` `/wiki-ingest` `/wiki-query` `/wiki-lint` `/wiki-status` `/wiki-digest` `/wiki-retro` `/wiki-req` `/wiki-run` `/wiki-record` `/wiki-skills` | prompt template | 展开 SOP，主会话按 Steps 调 `wiki_*` 工具 |
| `/wiki-model` | `registerCommand` | 读写 `taskModel`，改 status 行 |
| `/wiki-trajectories on\|off` | `registerCommand` | persist flag 后 `ctx.reload()`，因为 Pi 不能运行时增删工具 |

`package.json` 声明 `"pi": { "prompts": ["./prompts"] }`。omp 没有 `pi.prompts`，它的 `prompts/` 会进 `/prompts:` 菜单而不是真 slash command，所以另生成 `commands/`。[README dual-host 表](../../refs/pi-llm-wiki/README.md) [`scripts/build-commands.js`](../../refs/pi-llm-wiki/scripts/build-commands.js)

本仓库只有第 2 类：`pi.registerCommand("wiki", …)` 解析 `init/status/pause/…`，直接打 producer。`package.json#pi` 有 `extensions` 和 `skills`，**没有 `prompts`**。宿主会话的 skill（`repository-wiki-producer`）甚至写明：调用 `/wiki`，然后别动 `wiki/`。

### 10.2 常驻 skill vs 阶段模板

[`SKILL.md`](../../refs/pi-llm-wiki/skills/llm-wiki/SKILL.md) 是 Karpathy 的 schema：四层目录、raw/meta 不可手改、one file per thing、引用、矛盾标记、何时 `wiki_recall` / `wiki_retro`、工具清单。它不规定「这一轮先 discover 再 ingest」。

每个 `prompts/wiki-*.md` 才是一轮的程序。共同形状：

```markdown
---
description: …
argument-hint: "<required> [--flag]"
section: LLM Wiki
topLevelCli: true
---

# /wiki-query

## User Arguments
$ARGUMENTS

## Steps
1. Call `wiki_recall` …
2. Read …
**Rules:** Answer ONLY from wiki content …
```

`topLevelCli: true` 让 `pi -p "/wiki-run"` 这种无头调用能直接跑（`wiki_watch` 打出来的 crontab 就靠这个）。模板不实现工具；它点名该调哪个 `wiki_*`、读哪份 extracted、禁止改 `raw/`。

### 10.3 每个阶段模板做什么

对应 Karpathy 三操作，再加维护与工作记忆。全部跑在**同一个主会话**里。

**Init / 采集 / 合成**

| 命令 | 模板要模型做的事 | 工具实际做的事 |
|---|---|---|
| `/wiki-init <topic>` | 解析 topic/mode，调 `wiki_bootstrap`，提示下一步 capture | 建目录、config、schema、投影 |
| `/wiki-discover [--topic]` | `wiki_status` + `wiki_search` 看已有覆盖 → web search → 最多 5–10 条 `wiki_capture_source` | packet + skeleton；不搜网 |
| `/wiki-ingest [id]` | 先 `wiki_ingest`。若返回 background：**自己不要合成**。若返回 extracted：读 `extracted.md`、填 source 页、`wiki_ensure_page`、wikilink、标矛盾 | 默认同后台 sub-agent + `commit_synthesis`；无模型时把原文交回主会话 |

ingest 模板把「后台成功 / 同步降级」写成分支。这是 prompt 与 Runtime 的接缝：机械路径优先离场，prompt 只覆盖降级路径。

**查询 / 健康 / 周期**

| 命令 | 模板要模型做的事 | 硬约束写在 prompt 里 |
|---|---|---|
| `/wiki-query <question>` | recall → `read` 全文 → 带 `[[wikilink]]` 作答 → 新连接则 `wiki_ensure_page(type=synthesis)` → `wiki_log_event(kind=query)` | **只许用 wiki 内容**；缺信息就说缺，并建议该补什么 source |
| `/wiki-lint [--fix]` | 调 `wiki_lint`，向用户展示 orphans/gaps/contradictions | 矛盾 **不得**自动裁，留给人看 |
| `/wiki-status` | 调 `wiki_status`，警告时建议 `/wiki-lint` | 无 |
| `/wiki-digest [--period]` | 读 `meta/log.md`，写 `outputs/digest-YYYY-MM-DD.md` | 摘要是模型写的，落盘用 `write` |
| `/wiki-run [--schedule]` | 顺序执行 discover → ingest → lint；可选再一轮；写 `outputs/run-*.md`；`--schedule` 则 `wiki_watch` | **整条流水线是 prompt 步骤，不是 host nextAction**。明确 `wiki_watch` 只打印 crontab |

`/wiki-run` 是最能说明「编排在 prompt 里」的文件：discover/ingest/lint 的衔接没有 durable 状态。用户再打一次 `/wiki-run`，模型从头再走。compaction 或中途失败没有 Run journal。

**归档 / 需求 / 工作记忆**

| 命令 | 模板要模型做的事 |
|---|---|
| `/wiki-retro` | 从当前任务抽非显然 insight，一次一条 `wiki_retro`，带 wikilink |
| `/wiki-req <concept>` | 先和用户澄清 → `wiki_capture_source(text=澄清稿)` → 拆成原子 `requirement` 页（acceptance checkbox、`depends_on`、status/priority） |
| `/wiki-record` | `wiki_capture_trajectory`（session 里抽 tool-call）→ 填 `wiki/cases/` → 可再 `wiki_distill_skills` |
| `/wiki-skills [query]` | `wiki_recall_skill` → `read` → 套到当前任务；没有则做完再 `/wiki-record` |

`/wiki-req` 和 `/wiki-retro` 会写「先读 `.pi/skills/llm-wiki/SKILL.md`」。阶段模板不重复四层架构，只追加这一轮的程序；惯例仍在 skill。

### 10.4 没抽进 `prompts/` 的 prompt

三处仍在 TypeScript，因为消费者不是主会话的 `/` 展开：

1. **`INGEST_SYSTEM`**（[`ingest-worker.ts`](../../refs/pi-llm-wiki/extensions/llm-wiki/lib/ingest-worker.ts)）：后台子代理的 system prompt。「只许 `commit_synthesis` 一次，禁止编造」。这是唯一真正隔离的阶段 prompt。
2. **`<wiki_status>` footer**（`inject.ts`）：每轮稳定前缀，提醒有 wiki、去用 `wiki_recall` / `wiki_observe` / `wiki_retro`。
3. **Session notice + capture reminder**（`observation.ts`）：告诉模型 recall 已自动跑、该主动 observe/retro。`deliverAs: nextTurn`。

工具自己的 `promptSnippet` / `promptGuidelines` 还会进 Pi 的工具描述，等于第四条常驻微 prompt。

### 10.5 和本仓库阶段 prompt 的对照

两边都把语义 SOP 放在 Markdown，但当前本仓库已经没有旧版
`nextAction` / research-taxonomy state machine。实际实现是一个深的 Producer
interface，内部由 Lead 自主执行通用 subagent 流程。

| | pi-llm-wiki | 当前 open-okf-wiki |
|---|---|---|
| 用户入口 | 多个 prompt template + 2 个 host command | 一个 host command `/wiki`，解析 run / status / pause / resume 等 |
| 生产会话 | 当前宿主主会话；ingest 才开后台 agent | 独立 Lead session；宿主会话只控制 Producer |
| 语义流程 | `prompts/wiki-*.md` 的 Steps | [`prompts/lead.md`](../../prompts/lead.md) 的 survey / write / optional review 顺序 |
| 角色 | 主会话为主，ingest synthesizer 是特例 | [`agents/*.md`](../../agents) 的 survey / write / review 独立 session |
| 机械工具 | 14/17 个 wiki 工具直接暴露给主会话 | Lead 只有 read-only Candidate tools、`todo`、`subagent`、`publish`、可选 Catalog |
| 持久状态 | vault 文件；没有阶段 Run | `run.json` + `board.json` + Lead session file + Candidate |
| 发布 | vault 即当前知识 | Candidate 校验后安装为 Published Wiki |
| 恢复 | 重跑 prompt；后台任务只在 session 边界 drain | Board 和 Lead session 可 resume，但进程崩溃恢复仍有缺口，见第 11 节 |

这个形状的判断是：**当前外部 seam 比 pi-llm-wiki 更适合 repository
Wiki 生产，不应退回「每阶段一个 slash prompt」**。`WikiProducer` 只有
`start/list/open`，Run handle 只有 `view/subscribe/control/result`
（`extensions/wiki/lib/producer-types.ts:36-78`），却隐藏了 pin Source、Lead、
并发 subagent、Candidate、校验和安装，interface leverage 很高。Board 只保存
目标和剩余 Task，不编码 survey/write/review 阶段；阶段顺序仍可通过 Markdown
修改，而不用改 TypeScript（`extensions/wiki/lib/producer.ts:206-253`、
`prompts/lead.md:29-71`）。

值得吸收的是 pi-llm-wiki 的「短 Steps + 点名工具 + 明确 Rules」写法，以及
后台任务 drain、fail-closed parser、结构化 commit。不要吸收它的主会话编排、
ambient recall 或 type-bucket topology。

## 11. 当前项目的设计评价

### 11.1 已经做对的部分

1. **产品模型比参考实现更清楚。** Workspace / Source / Run / Candidate /
   Published Wiki 分开，Published Wiki 不作为下一 Run 的隐藏证据；Focus 只影响
   优先级，不缩窄完整覆盖。这比增量 vault 更适合可复查的 repository 文档。
2. **外部模块够深。** Pi extension 只是 `/wiki` adapter；测试可以直接构造
   `createProductionWikiProducer()`。删除 Producer 后，pin、恢复、并发、发布等
   复杂度会重新散到命令和测试里，所以这个 module 在赚取 locality。
3. **语义控制流没有硬编码回 host。** Lead prompt 和三个 agent 文件拥有 SOP；
   TypeScript 只拥有安全、持久化、会话和发布不变量。generic `subagent` interface
   也避免了为每个阶段复制一套工具 envelope。
4. **基础设施已有可复用深度。** Workspace 配置 unknown-field fail-closed，Source
   会计算 Git/dirty fingerprint，会话有并发、retry、timeout，文件写入有 durable
   replace 和 filesystem lease。当前 83 个测试全部通过。
5. **生成态和用户可见态分开。** 模型面对的 `wiki/...` 被映射到 Candidate；
   Published Wiki 只在校验后替换。这个方向正确，问题在安装事务尚未闭合。

### 11.2 设计意图与实现之间的缺口

以下不是 pi-llm-wiki 有而本项目没有的 feature list，而是当前自身 contract
没有被实现完全的地方。

#### P0：先修正确性和证据边界

1. **发布不是可恢复安装。** `publishCandidate` 先递归删除旧 `wiki/`，再 rename
   Candidate（`extensions/wiki/lib/producer.ts:273-295`）。进程在两步之间退出会
   丢 Published Wiki；这也不符合 ADR-0002 所说的 recoverable install。需要一个
   workspace publication lease、previous 备份 rename、很小的 install journal 和
   crash reconcile。这里重新引入的是跨 filesystem lifetime 必需的事务，不是恢复
   旧版整套 event ledger。
2. **Run lifecycle 没有受控状态机。** `control()` 可把 succeeded/failed Run 再
   pause 或 cancel；pause 返回前不等待旧 session 停止，立即 resume 会让旧、新
   Lead 同时修改一个 `live`；进程重启后遗留的 `running` record 既阻塞新 Run，
   `resume` 又因状态已经是 running 而直接返回（`producer.ts:93-100,297-359`）。
   start 的「查单活再创建」也没有跨进程 lease。应让终态不可逆、pause/cancel
   await drain、resume 先 await 前一 `done`，并用 owner lease 把 dead owner 的
   running Run reconcile 为 paused。
3. **模型读权限大于 admissible evidence。** `assertReadable` 只要求路径在
   Workspace 内（`extensions/wiki/lib/path-policy.ts:32-39`）。Lead/agent 因此可以
   读 `.env`、`.okf-wiki` session/Board、旧 Published Wiki 和被 exclude 的文件；
   prompt 的「不要搜 `.`」不是安全或 provenance 约束。read module 应只开放
   pinned Source view + 当前 Candidate + Catalog，并机械应用 default ignores / exclude。
4. **`validateWikiTree` 只验证“像页面”，没有验证声明的 Wiki topology。** 当前
   gate 要求非空 `type`、特定文件名有 mermaid fence、citation scope 存在；不要求
   `title`，不匹配 type 与路径，不要求 overview/source/domain/concept 层级，不要求
   任何 citation，也不检查 citation 文件存在和行号范围（`wiki-okf.ts:72-116`）。
   所以仅一个任意 type 的 `overview.md` 就能发布，现有测试也明确接受它
   （`test/wiki-okf.test.ts:38-45`）。应把文档中的 topology、page contract、实际
   source path/line、内部链接、NFC/大小写 collision 变成 validator contract。
5. **“独立审查”目前只是可选 prompt。** Lead 写的是 `Optionally review`
   （`prompts/lead.md:44-50`），host 不保存 review receipt，却给所有页盖
   `verified.by = process:open-okf-wiki`（`wiki-okf.ts:133-155`）。如果产品仍宣称
   independently reviewed，review agent 必须提交结构化 verdict + Candidate digest；
   publish 只接受当前 digest 的 pass。任何 writer 修改自然使 receipt 失效。

#### P1：深化内部 module，不扩大外部 interface

1. **把 `producer.ts` 内部职责收进三个深 module。** 保持 `WikiProducer` interface
   不变；内部提取：
   - `RunStore`：versioned parse、单活 lease、合法 transition、Board/record owner；
   - `CandidateValidator`：一次 scan 建 manifest，验证 topology/frontmatter/
     citations/links/collisions；
   - `CandidatePublisher.install()`：prepare → validate → review digest → swap →
     durable terminal record → cleanup/reconcile。

   这些依赖都属于 local-substitutable filesystem，直接用临时目录测，不要为了
   一个生产 adapter 暴露 ports。
2. **Run 必须 pin 完整生产契约，而不只是 fingerprint。** 当前 `run.json` 无
   version，读取失败会被当成不存在（`producer.ts:492-518`）；只保存最终
   fingerprint，不保存 Source plan、ignore/exclude、Catalog selection。至少持久化
   versioned plan 和非 secret Workspace config；Catalog 若继续作为 admissible
   evidence，应记录实际访问过的 schema/table definition digest。
3. **给每个 subagent invocation 独立 execution id。** 当前 telemetry 和持久 agent
   view 以 `agent` 名作 key；并行多个 `write`/`survey` 会互相覆盖，tool scope 也合并
   （`subagent.ts:58-66`、`producer.ts:431-459`）。使用 execution id，role 只是字段；
   同时跟踪并发 writer 的目标 path，对重叠写 fail fast。
4. **收紧 frontmatter parser。** 当前 `YAML.parse` 接受 alias，自定义 tag 只 warning
   后继续（`frontmatter.ts:20-30`）。可直接学参考实现的单 parser：frontmatter byte/
   depth limits、unique keys、单 document、拒 alias/custom tag、unknown fields 语义
   round-trip（`refs/pi-llm-wiki/extensions/llm-wiki/lib/knowledge-document.ts:320-469`）。
5. **释放 terminal live state。** 模块级 `active` Map 没有成功/失败后的 eviction；
   长 TUI 进程连续生成会线性保留 LiveRun。终态写盘和最后一次 emit 后删除，打开
   历史 Run 从 `RunStore` 投影即可。

### 11.3 建议的发布主路径

```text
Inspect + pin plan
  -> RunStore.create/lease
  -> empty Candidate + Board
  -> Lead (survey / write / mandatory review receipt)
  -> CandidateValidator
  -> CandidatePublisher transaction
  -> terminal Run record
```

这里仍然没有 host-owned survey/write/review 状态机。Host 只强制发布所需事实：
Source 未变、Candidate 合法、review receipt 对应当前 digest、安装事务可恢复。
Lead 如何达到这些事实继续由 Markdown SOP 决定。

### 11.4 建议验收测试

按风险优先补，不按参考仓库的测试数量追平：

1. 在 old wiki → backup、Candidate → wiki、terminal record 三个 fault point 注入
   crash；reopen 后必须得到旧版或新版之一，不能没有 Published Wiki。
2. 两个进程同时 `start` 只能一个获得 Run lease；dead owner 的 running Run 可恢复。
3. pause 等旧 Lead settle 后才返回；terminal Run 拒绝 pause/cancel/resume。
4. 模型 read 拒绝 `.env`、`.okf-wiki`、Published Wiki、excluded Source path。
5. citation 对不存在文件、越界行号、未知 scope 均 fail；所有 semantic page 至少一条
   load-bearing citation。
6. 缺 source/domain/concept page、type/path 不匹配、缺 title、大小写/NFC collision、
   broken internal link 均阻止 publish。
7. review pass 后任意一字节 Candidate 修改都会使 publish 要求重新 review。
8. 两个并行 write task 在 UI/record 中有不同 execution id；目标 path 重叠时确定性失败。

## 12. 从 pi-llm-wiki 吸收什么

### 12.1 现在就吸收

1. **Fail-closed document parser 和 projection discipline。** 这是当前 validator 最直接的
   技术补强，不涉及产品模型迁移。
2. **结构化 LLM output + host deterministic commit。** 用于 review receipt，和
   `commit_synthesis` 同一思路；但 exactly-once 必须由 host 强制，不能只写 prompt。
3. **后台工作有 single-flight，并在 compaction/shutdown drain。** 当前 pause/resume
   也应有同等级别的 settle contract；drain 要有 timeout/cancel，不照抄参考实现的
   无界 `awaitAll`。
4. **静态 system prefix 与 volatile tail 分离。** Board 已经用文件 + compaction
   message，保持这个方向；以后动态 Candidate 摘要也不要改 system prompt。
5. **同一 domain function 服务多个 adapter。** 若以后增加 CLI/MCP reader，复用
   `PublishedWiki` module，不在 adapter 重写 parse/search/status 规则。

### 12.2 第二阶段可吸收：Published Wiki reader

当前项目只生产 Wiki，缺少生产后的机械读取 interface。可以在 Producer 之外增加
独立的 `PublishedWiki` module，先只提供 `status/search/read`：

- 生成 registry/backlinks 作为 derived projection；坏了可从 Published Wiki 重建；
- 默认 lexical search + links-first，查询范围严格是当前 Workspace Published Wiki；
- `/wiki query` 可用独立 prompt/session 回答，但绝不把结果注入下一 Run；
- 只有在大 Wiki 的 lexical recall 指标不够时再加 embedding，避免先引入网络、
  sidecar stale 和额外配置。

这吸收了 pi-llm-wiki 最有用户价值的 recall/read experience，同时保持 Run isolation。

### 12.3 不要吸收

1. **Type-bucket 目录。** 本仓库明确「页坐在 concept 旁」。`entities/` vs `concepts/` 是个人知识库分类，不是 repository wiki 的域模型。
2. **每轮自动 recall 进主会话。** 会把个人 vault 和上次 Run 的残余带进本次生成。违反 Run isolation。
3. **把 Published Wiki 当可变中间层。** Karpathy 模式的价值是累积；本仓库的价值是一次可复查的生成。更新路径是新 Run，不是 ingest 进已出版树。
4. **Prompt 级 `/wiki-run` 当生产编排。** 当前独立 Lead + Board 已经更可靠；不要把 survey/write/review 拉回宿主主会话。
5. **Trajectory 工作记忆。** Run 已有 Board、Candidate 和 Lead session；跨 Run 复用技能页会变成隐藏的 Source。
6. **为了 dual-host/MCP 预先造 seam。** 当前只有 Pi adapter；等第二个真实 adapter 出现再抽，
   不为参考实现已有 omp/MCP 就复制分发复杂度。

## 13. 推荐顺序

1. **先闭合 P0：** Run transition/lease、recoverable publication、evidence read policy、
   validator、review receipt。它们决定“可恢复、source-grounded、independently reviewed”
   是否为真。
2. **再做内部 deepening：** `RunStore` / `CandidateValidator` /
   `CandidatePublisher`、execution id、versioned plan/parser。外部 Producer interface 不变。
3. **然后做 Published Wiki reader：** lexical search、registry/backlinks、显式 query。
4. **最后才评估 embedding、immutable Source snapshot、MCP/omp。** 这些都需要真实规模、
   recall 指标或第二 adapter 才形成有效 seam。

最终建议不是“把当前项目改成 pi-llm-wiki”，而是保留当前更强的 Run/Candidate/
Published Wiki 产品模型，把参考实现成熟的 parser、deterministic projection、runtime
settle 和 reader experience 移植到各自正确的 module 内。当前最值得投入的不是
recall，而是让已有架构承诺在 crash、并发、恶意路径和低质量 Candidate 下也成立。
