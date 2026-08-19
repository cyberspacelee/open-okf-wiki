# pi-llm-wiki 实现分析

日期：2026-08-19

## 范围与证据边界

本笔记分析 [zosmaai/pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki)：Karpathy LLM Wiki 模式在 Pi / oh-my-pi 上的实现。克隆在 [`refs/pi-llm-wiki`](../../refs/pi-llm-wiki)，HEAD `547a221`（2026-08-14，`v0.11.4`）。npm 包 `@zosmaai/pi-llm-wiki@0.11.4`。GitHub 约 511 star。树内 `package.json` 仍写 `0.6.3`，以 git tag / npm 为准。

一手来源：

- Karpathy 的模式说明：[LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- 实现仓库：[`refs/pi-llm-wiki`](../../refs/pi-llm-wiki) 的 README、`docs/architecture.md`、`docs/api.md`、OKF Foundation spec、extension 源码
- 本仓库：[`CONTEXT.md`](../../CONTEXT.md)、[`packages/wiki-workflows/ARCHITECTURE.md`](../../packages/wiki-workflows/ARCHITECTURE.md)、[ADR-0001](../adr/0001-isolated-full-generation-runs.md)

已有笔记 [pi-extension-and-dynamic-workflows.md](pi-extension-and-dynamic-workflows.md) 只把它定性为「不是同类 wiki」。本文拆实现。事实与对本仓库的推论分开。

## 结论

1. **这是宿主会话里的增量知识库，不是一次隔离生成。** 它把 Karpathy 三层（raw / wiki / schema）做成 Pi extension：捕获不可变 source packet、后台合成 entity/concept 页、每轮 recall 注入、机械 lint。知识随会话累积。本仓库是 pinned Sources 上的独立 Run，Published Wiki 只作 provenance。
2. **阶段流程抽成 slash-command prompt，不是 host 状态机。** 机械工作在工具 + hook（13 个常驻工具、后台 `commit_synthesis`）。Karpathy 的 ingest / query / lint 等操作是 `prompts/wiki-*.md`：用户打 `/wiki-query …`，Pi 把模板展开成这一轮的 user prompt，**同一个主会话**按 Steps 调工具。只有 `/wiki-model`、`/wiki-trajectories` 是 `registerCommand` 的宿主 handler，不进模型。没有 Board / nextAction。
3. **机械层做得深，语义层故意浅。** YAML 解析、OKF dual-read、atomic projection、path guardrail、hybrid recall、cache-safe injection、pi/omp 双宿主，都是 host-owned。页面拓扑按 type bucket（`entities/`、`concepts/`、`syntheses/`），ingest 只写 source 摘要 + 一行 entity/concept stub，跨源 thesis 靠模型后续手写。
4. **对本仓库值得学的是 extension 工程，不是 wiki 产品模型。** 尤其：volatile recall 不进 system prompt；mutating 工具立刻返回、结果 `nextTurn` 上报；compaction/shutdown 前 drain 后台任务；Pi 工具与 MCP 共用 `wiki-service`；invalid config fail-closed。不该抄：type-bucket 目录、每轮自动 recall、把 Published Wiki 当可变知识库、在主会话里合成页面。

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
| 会话角色 | 宿主主会话 + 后台 sub-agent | Lead / researcher / writer / reviewer |
| 出版 | 无；vault 就是正在用的 wiki | Candidate → independent review → Publication Seal |
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
| `raw/**` | extension | capture 后不可变 |
| `wiki/**` | 模型 + 用户 | 可编辑知识页 |
| `meta/events.jsonl` | extension 工具 | 权威、append-only；rebuild 不能重建 |
| `meta/**` 其余 | extension | 生成投影 |
| OKF 模式下的 `wiki/index.md`、`wiki/log.md` | extension | 生成投影，guardrail 只读 |

解析顺序：cwd 向上找 `.llm-wiki/` → `$WIKI_HOME` → `~/.llm-wiki/`。`wiki_recall` 同时搜 project + personal，按 page id 去重，project 优先。自动注入（`before_agent_start`）只搜 project vault，避免个人库污染无关仓库。

Ambient 门控（2026-08 的 omp 适配）：session notice、observe/retro 提醒、自动 recall 只在「当前目录适用 wiki」时开火。omp 默认 `ambientPersonalVault: false`（插件全局加载）；pi 默认 `true`（历史行为）。工具和 slash command 始终注册，所以 `/wiki-init` 在任何目录都能用。

本仓库对应物是 Workspace / Run / Candidate / Published Wiki，不是 personal+project 双 vault。

## 3. 模块地图

扩展约 11k 行 TS + 12k 行测试。职责按文件：

| 模块 | 行数 | 职责 |
|---|---|---|
| `extensions/llm-wiki/index.ts` | 342 | 工厂：注册工具/命令/hook，ambient 门控，cache-safe 注入 |
| `lib/tools.ts` | 1374 | 13 个常驻工具的 Pi 注册与参数 |
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

测试约 49 个文件，覆盖 guardrail、ingest 并发、OKF 投影、host 兼容、MCP parity、ambient 门控。这是「机械层可测、LLM 边界收成一次 structured tool call」的策略。

## 4. 扩展生命周期

工厂 `export default function (pi: ExtensionAPI)` 做的事：

1. **先建 `Runtime`**，让后续工具能 `launchTask`。
2. **无条件注册工具和命令**（trajectory 三件套除外，由 `llm-wiki.trajectories` 在工厂时决定；toggle 会 `/reload`）。
3. **`session_start`**：修复 doubled personal vault；`ensureConfig`；ambient 关闭则返回；没有 `config.json` 就静默 `bootstrapVault` 并标 `needsTopicInference`。
4. **`before_agent_start`**：topic 推断指令 + hybrid recall。静态 `<wiki_status>` footer 进 system prompt；volatile 内容进 `display: false` 的 tail message（issue #92）。
5. **`tool_call` / `tool_result` / `turn_end`**：guardrail 与 metadata rebuild。
6. **`session_before_compact` / `session_shutdown`**：`runtime.awaitAll()`，后台工作不丢。

这与 Pi 官方「工厂不启动后台资源、session 边界 drain」一致。本仓库 extension 目前在 `/reload` 上靠 producer slot handoff；pi-llm-wiki 的 live 状态更轻（in-flight promise + reminder counter），所以 drain 就够。

### 4.1 Cache-safe 注入

`lib/inject.ts` 把注入拆成：

- **稳定前缀**：`appendWikiStatus` 幂等追加 `<wiki_status>…</wiki_status>`，abort/retry 不会叠多份。
- **易变尾巴**：recall 命中、topic 推断。进 `customType: wiki-recall-context` 消息，不改 system prompt。

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

### 5.2 Ingest：一次 structured call + 确定性 commit

这是最能代表其 LLM 边界的设计。

`wiki_ingest` 默认 `background: true`：

1. 扫 `raw/sources/SRC-*`，对照 registry 里非 `skeleton` 的 source 页，取出最多 5 条。
2. `Runtime.resolveModel`：per-call `model` > `taskModel` > session model。解析失败则退回同步：把 extracted 文本交给主会话，由主会话自己写页。
3. 解析成功则 `launchTask`，主工具立刻返回「不要自己合成」。

后台 `runIngestSynthesis`：

- 截断 extracted 到 24k 字符。
- 调 `runSubAgent`（对 `agentLoop` 的薄封装，`toolExecution: sequential`）。
- 子代理只有一个工具 `commit_synthesis`，schema 是 summary / takeaways / entities / concepts / quotes / contradictions。
- `commitSynthesis` 是纯文件 I/O：把 source 页标为 `ingested`、缺的 entity/concept 建 stub（已存在则只链接、不覆盖）、`appendEvent`、`rebuildMetadataLight`。
- 标题语言可配 `synthesisLanguage`（BCP 47）；heading 有 ru/fr/de/ja 表。

Karpathy 说「一条 source 可能改 10–15 页」。这里的自动合成更窄：source 摘要 + 新建 stub。跨页修订、synthesis 页、矛盾仲裁仍靠主会话的 skill 流程（`/wiki-ingest`、`/wiki-query` 提示词）。

本仓库对应物是 writer cluster + `inspectHandoff`。两边都把「模型产出结构化结果、host 落盘」分开；差别是 pi-llm-wiki 的 schema 是 ingest 专用，本仓库的 contract 覆盖 research/write/review 全阶段，并且 writer 不能在未审查的 Published Wiki 上增量改。

### 5.3 Retro / observe / trajectory

三条记忆通道，刻意分层：

| 工具 | 存什么 | 何时 |
|---|---|---|
| `wiki_observe` | 带 relevance 的短观察 | 任务中途，extension 会提醒 |
| `wiki_retro` | 一条 insight markdown | 任务结束 |
| `wiki_capture_trajectory` | 可重放的 tool-call packet | opt-in；再 distill 成 skill/case |

Skill 文档写明：Pi 自带 observational-memory 是散文，保 compaction 存活，不存 tool 名/参数/结果。trajectory packet 才是可蒸馏的回放记录。默认关闭（issue #80），避免三件套占 system prompt。

本仓库不需要 trajectory：Run 的 session transcript 和 Task Receipt 已经是工作记忆，而且不得泄漏进下一次 Run。

## 6. Recall

`lib/recall.ts` 是最大单文件，查询热路径不调 LLM。

词法：NFKC 正规化、保留 CJK、kebab 当空格、CJK bigram/trigram、字段加权（title/alias/trigger > heading > body）、chunk 级最佳预览、伪相关反馈。

语义（opt-in）：写时把页面向量写入 `meta/embeddings.json`（content hash + model 做 stale）。查询只 embed 一次短 query（session 内缓存）。融合：

```
fused = lexical + semanticWeight × 12 × max(cosine, 0)
```

默认 `semanticWeight = 0.5`。自动注入 `minScore = 5`：纯语义命中大约 cosine ≳ 0.84 才过线。无 embedder 时字节级退回纯词法。embedding 有独立 API key，不会因为存在 `OPENAI_API_KEY` 就自动打开。

Links-first（issue #68）：`registry.json` 页数 > `recallLinksThreshold`（默认 50）时，注入排名链接 + 一行 snippet，不塞全文。skill/case 页可按 `recallSkillInlineMax` 内联短 body，因为蒸馏技能需要立刻能用。自动注入只搜 project vault。

`wiki_search` 是 registry 子串查找，无评分、无分层，给「已知名字」的定位。

本仓库推断：production 不该每轮往 Lead 塞 wiki 正文。Board 已经是剩余工作的投影。若以后要给 writer 做页内检索，可学「热路径无 LLM + 大库 links-first」，但检索域应是当前 Candidate，不是 `~/.llm-wiki`。

## 7. Guardrail 与投影

### 7.1 拦截写

`installGuardrails` 在 `tool_call`：

- `write`：单 path，命中 `raw/**`、`meta/**`、非法 vault config、OKF 生成的 `wiki/index.md`/`log.md` 则 `block`。
- `edit`：从 apply-patch / rename 输入里抽出全部目标 path。抽不全则直接 block（「无法确定编辑目标」），避免漏网。

`tool_result` 若写了 `wiki/**`，打 `pendingRebuild`；`turn_end` 调 `scheduleReindex`。

`scheduleReindex`：微 yield 让工具先返回；按 vault dirty-flag drain；single-flight；rebuild 后再按需 embed。N 次写入并成一次 O(pages) 扫描。

### 7.2 Fail-closed 投影

`rebuildMetadata`：先 `inspectVaultFormat`（非法 `knowledge_format` 阻塞），再发现文档（NFC / 大小写碰撞阻塞），内存里建齐 registry、backlinks、index、log、OKF 目录 index，然后 `rename` 写出。`events.jsonl` 缺失时警告并保留已有 log 投影，其它投影继续。

`wiki_lint` 是确定性扫描：orphan（无 inbound）、broken link、矛盾标记 `⚠️ **Contradiction`、coverage gap。`auto_fix` 只给被 ≥2 页引用的缺口建 stub，矛盾不自动裁。

本仓库已有更强的同类机制：canonical write + review invalidation 同事务、Publication Seal、journal reconcile。pi-llm-wiki 的投影是「单 vault 的生成目录」，不是跨进程出版租约。值得对齐的只有：生成文件不要让模型手改；非法配置不要静默降级。

## 8. OKF Foundation

[`docs/superpowers/specs/2026-08-02-okf-foundation-design.md`](../../refs/pi-llm-wiki/docs/superpowers/specs/2026-08-02-okf-foundation-design.md) 是规范性 child spec。已落地的部分：

- 一个 parser（`yaml` 包），不是 legacy/OKF 两套。拒 alias、自定义 tag、多文档、>128KiB frontmatter、>32 层嵌套。
- 模式管投影，不管可读性：两种模式都 dual-read。缺 `knowledge_format` 的旧 vault 当 `legacy`；新 bootstrap 写 `okf-0.2`。
- 概念 id = NFC 正规化的 bundle 相对路径去掉 `.md`。`index.md`/`log.md` 保留。
- 新页走 OKF canonical；改旧 legacy 页保留其 frontmatter 形状，不偷偷迁移。
- 未知字段 round-trip 语义保留。
- Pi 工具和 MCP 必须走同一 service（`wiki-service` + `mcp/operations.ts`）。MCP 适配器禁止自己 parse YAML、scan、score。

未做（Interchange / Intelligence child）：bundle import/export、review staging、transaction、trust-aware recall、Attested Computation 执行。

本仓库的 OKF 身份是「从仓库 Source 生成、经独立审查后安装的 Published Wiki」。pi-llm-wiki 的 OKF 身份是「Obsidian 兼容 vault 作为可携带 bundle」。Foundation 的 parser 约束（拒 alias/自定义 tag、未知字段存活、生成 index 只读）和本仓库 frontmatter 方向一致；page topology 和出版治理不一致。

## 9. 后台 Runtime 与双宿主

`Runtime` 从 pi-observational-memory 的模式移植：

- `launchTask(label)`：detached promise，同 label single-flight，错误 `ui.notify`，不抛进主循环。
- `launchReported`：完成后 `sendMessage({ customType: wiki-action-report, deliverAs: nextTurn })`，并 toast 第一行。
- `resolveModel`：缺模型或 API key 返回 `{ ok: false }`，调用方走同步降级，而不是失败整个会话。
- 捕获 `ctx.hasUI` / `ctx.ui` 的同步快照，避免 await 之后碰到 fork/reload 的 stale proxy。

`lib/host.ts` 解决 pi（`.pi/settings.json`）和 omp（`.omp/config.yml`）的布局分叉：两边都读，host-native 最后赢；写入永远是 JSON `settings.json`，不改用户手写 YAML。`LLM_WIKI_HOST` 可强制。

MCP 面比 Pi 小：bootstrap、recall、search、status、capture、retro。没有 ingest sub-agent（需要模型凭证和 `agentLoop`）。bootstrap 用 `getVaultPaths(WIKI_ROOT)` 而不是 `resolveVaultPaths()`，避免在「解析落到个人库」的地方建库。

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

两边都把「怎么写」从 TypeScript 里抽成 markdown。抽的位置和绑定的会话不同。

| | pi-llm-wiki | 本仓库 wiki-workflows |
|---|---|---|
| 用户命令 | 每个阶段一个 **prompt template** `/wiki-query` 等 | 一个 **host command** `/wiki`，子命令是 producer 控制面 |
| 阶段怎么往下走 | 模板里的 `## Steps`；`/wiki-run` 用编号步骤串起来 | host Board `nextAction`：research → taxonomy → write → review → finish |
| 常驻说明 | 一个 skill，给**主会话** | `repository-wiki-producer` 给宿主会话（只说去调 `/wiki`）；`wiki-production/SKILL.md` 给 **Lead 会话** |
| 角色怎么写 | 无独立角色；query/ingest 都是主会话 | `briefs/researcher.md`、`writer.md`、`reviewer.md` + `references/*.md`，装进**各自的 Pi session** |
| 模板加载 | 用户打 `/` 才展开进 transcript | 开 session 时 host 把对应 brief 放进 skill tree；Lead 不读 writer 的页模板 |
| 失败/恢复 | 无阶段持久化；再打一次 `/wiki-run` | Run journal、pinned sessions、skill digest；resume 接着 Board |
| 可编辑性 | 改 `prompts/*.md` 即改 SOP，不用发 extension | 改 production skill 会进下一 Run 的 digest；当前 Run pin 住旧 digest |

本仓库推断：

- **值得学的是分层，不是把阶段做成 `/wiki-research` 这种 prompt command。** 惯例（skill）与「这一轮程序」（短 markdown）分开，模板点名工具、写清禁止项（只许 wiki 内容、矛盾不自动裁、raw 不可改）。
- **本仓库已经把角色 prompt 抽出来了**（briefs + references + page templates），而且比 pi-llm-wiki 更隔离：writer 只在写时读对应 `templates/<pageType>.md`。不要再给宿主会话加一套阶段 SOP。
- **不要把 Board 换成 `/wiki-run` 式步骤清单。** 那份清单没有 wave、没有 review assignment、没有 fail-closed 的下一动作。Lead skill 已经是「读 board，调 `wiki_delegate_*` / `wiki_plan` / `wiki_finish`」；阶段权威是 host 文件，不是展开进 Lead transcript 的 `/research` 模板。
- 若要把某段 Lead 说明再缩短，应对齐 pi-llm-wiki 的形状：短 Steps + 点名工具 + Rules，而不是在 extension 里 `registerCommand` 去驱动 Lead 说话。

## 11. 对本仓库的取舍

### 11.1 值得吸收（工程，不是产品）

1. **Volatile 上下文不要写进 system prompt。** 已实现于 `inject.ts`。Lead 若开始注入动态摘要，走 tail message 或文件（Board）。
2. **重 mutation 立刻返回，结果下一轮可见。** `dispatchReported` + compaction 前 drain。本仓库的 producer 已在 Pi 会话外跑；extension widget 仍可学「完成用 notify，不要把长报告刷进 transcript」。
3. **结构化工具 + 确定性 commit。** ingest 的 `commit_synthesis` 与本仓库 `inspectHandoff` 同构。保持「模型填 schema，host 写盘」。
4. **Pi 与其它入口共用 service。** 若以后有 CLI/MCP 读同一 Run 视图，业务规则只放一处。
5. **非法配置 fail-closed。** 未知 `knowledge_format` 不降级。对齐本仓库 Run format 3 / publication format 1。
6. **Ambient 默认保守。** omp 在「这个仓库没有 wiki」时保持沉默。本仓库 extension 也不该在未 init 的 Workspace 里主动说话。
7. **惯例 skill 与阶段 SOP 分开。** pi-llm-wiki 的 `SKILL.md` 只讲所有权和何时 recall；每轮程序在 `prompts/wiki-*.md`。本仓库已有同类分层（Lead skill vs researcher/writer/reviewer brief vs page template）。继续让角色 markdown 短、工具点名、禁止项写死；不要把 SOP 塞回 extension handler。

### 11.2 不要抄

1. **Type-bucket 目录。** 本仓库明确「页坐在 concept 旁」。`entities/` vs `concepts/` 是个人知识库分类，不是 repository wiki 的域模型。
2. **每轮自动 recall 进主会话。** 会把个人 vault 和上次 Run 的残余带进本次生成。违反 Run isolation。
3. **把 Published Wiki 当可变中间层。** Karpathy 模式的价值是累积；本仓库的价值是一次可复查的生成。更新路径是新 Run，不是 ingest 进已出版树。
4. **Prompt 级 `/wiki-run` 当生产编排。** 发现/写作/审查已经是 host 状态机。也不要把 research/write/review 做成宿主会话上的 `/wiki-research` prompt template：那会把角色工作拉回主会话，丢掉独立 session 和 Board。
5. **Trajectory 工作记忆。** Run 已有 receipt 与 session 文件；跨 Run 复用技能页会变成隐藏的 Source。

### 11.3 明确不对应的能力

pi-llm-wiki 没有：Source pin、Focus、WikiSpec、Cluster dispatch、独立 Reviewer、Publication Seal、Workspace 单活 Run、skill digest 校验。本仓库没有：personal vault、Obsidian 实时维护、写时 embedding、opt-in trajectory。缺的不是没做完，是产品边界不同。
