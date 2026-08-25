# pi-llm-wiki 实现分析与当前项目对照

复核日期：2026-08-25

## 范围与结论

本文只使用两个本地源码树作为证据：

- `refs/pi-llm-wiki`，HEAD `547a2219578fe3584fe37adaeed897b1075b72da`；
- 当前 `open-okf-wiki` 源码，HEAD `c9713d5e47c70492605df220031a1e6e058790b7`。

参考仓库已经位于指定 HEAD，工作树干净，不需要重新克隆。它的 git tag 是
`v0.11.4`，但树内 `package.json` 仍声明 `0.6.3`；本文固定到 git commit，不用包版本
推断实现（`refs/pi-llm-wiki/package.json:1-4`）。

核心结论：

1. `pi-llm-wiki` 是宿主主会话中的增量知识库。raw source packet 按协议不可变，
   wiki 页面持续累积，查询时自动 recall；它没有一次完整生成所需的 Run / Candidate /
   review / publish 状态机（`refs/pi-llm-wiki/docs/architecture.md:34-80`）。
2. 它把流程编排主要放在 slash-command Markdown prompt；host 负责工具、hook、路径
   guardrail、解析、投影、检索和后台任务。后台 ingest 是唯一显著的隔离子代理路径
   （`refs/pi-llm-wiki/package.json:72-83`；`refs/pi-llm-wiki/extensions/llm-wiki/index.ts:100-145`）。
3. 当前项目的 repository Wiki 生产治理已经明显强于旧笔记所述：完整 plan 和执行回执
   持久化、受限 evidence view、writer 同会话修复、强制 digest-bound review、可恢复
   publication transaction 都已落地（`extensions/wiki/lib/producer.ts:103-124,418-455`；
   `extensions/wiki/lib/publication.ts:19-88`）。
4. 不应仅因参考实现更严格就扩充当前模型输出契约。当前 `yaml` 依赖已覆盖重复 key、
   多文档和 alias expansion；handoff 路径也是 host 已知状态，现由 host 从 completed
   receipts 注入 synthesis。完整论证见 [LLM 校验与 Handoff 约束的效率分析](llm-validation-handoff-efficiency.md)。

## 1. 产品模型与工作流

### 1.1 pi-llm-wiki：增量 vault

Vault 的主要层次是：

```text
.llm-wiki/
  raw/sources/SRC-*/             # capture packet
  raw/trajectories/TRJ-*/        # opt-in 工作轨迹
  wiki/{sources,entities,concepts,syntheses,analyses,cases,skills}/
  meta/{registry.json,backlinks.json,index.md,log.md,events.jsonl}
  outputs/
```

`raw/**` 由 extension 写，`wiki/**` 由模型和用户编辑，`events.jsonl` 是 append-only
事件源，其余 meta 是可重建投影（`refs/pi-llm-wiki/docs/architecture.md:34-80`）。这里的
raw “不可变”是应用协议，不是文件系统权限：guardrail 只拦宿主事件名为 `write` / `edit`
的调用，shell、第三方工具和外部编辑器不在拦截面内
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/guardrails.ts:196-220`）。

主流程是：

```text
capture source
  -> source packet + skeleton page
  -> ingest synthesis
  -> entity/concept stubs + source summary
  -> metadata / embeddings projection
  -> recall / query / lint / retro
```

`wiki_capture_source` 在返回前写 packet 和 skeleton，随后把 O(pages) reindex 放后台；
它并不是“所有 mutation 都后台化”
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/tools.ts:180-240`）。

`wiki_ingest` 默认一次选 3 条、最多 5 条。若能解析 background model，就按 source
启动后台合成；若无 model/API key，则把 extracted content 交回主会话走同步降级
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/tools.ts:280-379,393-455`）。

后台合成只暴露 `commit_synthesis`，输出 summary、takeaways、entities、concepts、quotes、
contradictions；host 再确定性更新 source 页面、按需建 stub、写 event、重建 metadata
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/ingest-worker.ts:35-75,324-445,510-556`）。
“调用一次”只写在 system prompt，execute 本身没有二次调用锁；文件提交也是顺序写，
不是跨文件事务（`refs/pi-llm-wiki/extensions/llm-wiki/lib/ingest-worker.ts:450-463,516-539`）。

### 1.2 当前项目：隔离的完整生成

当前项目是另一种产品：

```text
Inspect + pin
  -> Candidate + Board
  -> survey(N)
  -> synthesize(1, multi-Source only)
  -> write(disjoint targets)
  -> candidate_check
  -> review(frozen Candidate)
  -> publish transaction
```

Lead prompt 明确要求多 Source 先完成所有 survey，再单独 synthesize，然后按 Domain、
repository aggregation、wiki-root 顺序写，最后 deterministic check、review、publish；
host 也机械阻止提前 synthesize/write，而不是只相信 prompt
（`prompts/lead.md:37-99`；`extensions/wiki/lib/producer.ts:508-556`）。

两者不能互换：

| 维度 | pi-llm-wiki | 当前项目 |
|---|---|---|
| 时间模型 | 跨会话增量累积 | 一次完整、隔离的 Run |
| 输入证据 | capture 的 URL/文件/文本 | 声明并 pin 的 Git Sources + 按需 Catalog |
| 写入位置 | 正在使用的 vault | 私有 Candidate |
| 语义角色 | 主会话；ingest 才开后台 agent | Lead + survey/synthesize/write/review 隔离 session |
| 恢复 | vault 文件 + 重跑 prompt | run/board/activity/execution/handoff/check/review receipts |
| 发布 | 无，vault 即当前知识 | validation + review 后事务替换 Published Wiki |
| 检索 | 每轮 recall + 显式工具 | 生产期只读 pinned evidence/Candidate/handoffs |

因此不应把 personal recall、type-bucket topology 或增量写 Published Wiki 引入生产 Run。

## 2. 状态设计

### 2.1 pi-llm-wiki 的 durable state

长期状态直接是 vault：

- raw source / trajectory packet；
- editable wiki pages；
- append-only `events.jsonl`；
- registry/backlinks/index/log/embeddings 等 derived projection。

metadata rebuild 先检查 vault format 和文档发现结果，在内存生成全部投影，发现 blocking
diagnostic 就不写；写入阶段则逐文件 temp+rename，不是 registry/backlinks/index/log 的
整体事务（`refs/pi-llm-wiki/extensions/llm-wiki/lib/metadata.ts:65-143,355-361`）。

它没有 durable pipeline phase、任务 Board、Candidate digest 或 review receipt。
`/wiki-run` 的 discover -> ingest -> lint 顺序只是这一轮主会话 prompt 的 Steps；中断后
重新运行该 prompt，而不是恢复一条 host-owned Run（`refs/pi-llm-wiki/prompts/wiki-run.md:16-31`）。

### 2.2 pi-llm-wiki 的 runtime state

每个 extension factory 创建一个共享 `Runtime`。内存保存 label -> Promise 的后台任务，
相同 label single-flight；错误被 UI 消化，不抛回主循环
（`refs/pi-llm-wiki/extensions/llm-wiki/index.ts:75-78`；
`refs/pi-llm-wiki/extensions/llm-wiki/lib/runtime.ts:52-80,143-180`）。

`session_before_compact` 和 `session_shutdown` 都调用无超时的 `awaitAll()`；它保证被 Runtime
跟踪的任务会 drain，但没有 cancellation 或 bounded shutdown
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/runtime.ts:233-270`）。

reindex 另有按 vault root 分区的 `dirty` / `inflight`，写入发生在 rebuild/embedding
期间会触发 trailing pass；label 也带 root
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/indexing.ts:31-83`）。

一个真实缺口是 ingest label 只有 `ingest:${sourceId}`。Runtime 在 extension 内全局共享，
而不同 vault 都会产生如 `SRC-YYYY-MM-DD-001` 的相同 ID；同一宿主跨 cwd 并发 ingest 时，
第二个 vault 可能错误复用第一个 promise。应像 `indexLabel(root)` 一样把物理 vault root
放进 label（`refs/pi-llm-wiki/extensions/llm-wiki/lib/tools.ts:303-305,407-429`；
`refs/pi-llm-wiki/extensions/llm-wiki/lib/indexing.ts:36-39`）。现有 ingest concurrency 测试
覆盖 commit 时 format 变化，但没有两个 vault 同 source id 的 case
（`refs/pi-llm-wiki/test/ingest-concurrency.test.ts:35-58`）。

### 2.3 当前项目的 durable/runtime state

当前 `run.json` 是严格 `schemaVersion: 1`，保存完整 pinned plan、fingerprint、execution
receipts、review/check receipts、lead attempts、Candidate、template fingerprint 和 session
file；不是旧笔记所写的“只存 fingerprint”
（`extensions/wiki/lib/producer.ts:73-124,1027-1107`）。

`board.json` 限制一个 `in_progress` Task 和 1500-token recovery budget；checkpoint 汇总
fingerprints、Candidate revision、check/review freshness、未完成 execution，并把整个恢复
frame 控制在 4096 estimated tokens
（`extensions/wiki/lib/board.ts:27-72`；`extensions/wiki/lib/checkpoint.ts:38-84`）。

每次 worker 有独立 execution id。handoff 首行是结构化 envelope，并绑定 task digest、
partition、write target 和 Candidate revision；resume 时已落盘且验证通过的 handoff 会被
收养，其他 running receipt 标为 interrupted
（`extensions/wiki/lib/subagent.ts:94-120,338-340`；`extensions/wiki/lib/handoff.ts:51-120`；
`extensions/wiki/lib/producer.ts:647-729`）。`activity.jsonl` 另外持久化 agent/tool/input/output
时间线，半截尾行在恢复时丢弃（`extensions/wiki/lib/run-activity.ts:29-54,56-115`）。

run transition 有文件系统锁和 pid/token owner；pause 后 resume 先等待旧 `done`，终态
拒绝非法 transition，并从模块级 `active` Map 清理
（`extensions/wiki/lib/producer.ts:827-910,1226-1272`）。成功和取消后删除当前 Run，失败/
暂停保留以恢复（`extensions/wiki/lib/producer.ts:296-315`）。

publication 通过 journal + `previous` backup + filesystem lease 完成 old Wiki -> backup、
Candidate -> Wiki，并在重启时完成或回滚；fault tests 覆盖两个 rename 窗口
（`extensions/wiki/lib/publication.ts:19-88`；`test/publication.test.ts:18-58`）。

## 3. Prompt、skill 与 command

### 3.1 pi-llm-wiki

它把不同职责拆成六层：

| 资源 | 消费者 | 职责 |
|---|---|---|
| `skills/llm-wiki/SKILL.md` | 主 agent 按需读 | vault 结构、所有权、引用、工作惯例 |
| `prompts/wiki-*.md` | Pi prompt template | 一轮阶段 SOP |
| `commands/wiki-*.md` | oh-my-pi | `prompts/` 的生成镜像 |
| `/wiki-model`, `/wiki-trajectories` | host handler | 配置和 reload，不进模型 |
| `INGEST_SYSTEM` | background agent | 结构化合成和唯一工具 |
| hooks/tool descriptions | 当前会话 | recall、status、observe/retro reminder |

包 manifest 同时声明 extensions、skills、prompts、MCP 和 omp entry；`commands/` 由脚本从
`prompts/` 字节复制，测试锁住 parity
（`refs/pi-llm-wiki/package.json:40-83`；
`refs/pi-llm-wiki/scripts/build-commands.js:1-35`；
`refs/pi-llm-wiki/test/package-structure.test.ts:53-75`）。

阶段模板都是短的“Steps + Rules”：

- `/wiki-ingest` 先调工具；若后台启动，主会话禁止重复合成；若同步降级，才读 extracted
  并写页面（`refs/pi-llm-wiki/prompts/wiki-ingest.md:16-36`）。
- `/wiki-query` recall -> read -> 回答 -> 可选归档 analysis，且要求只用 wiki 内容；缺证据
  时明确报告缺口（`refs/pi-llm-wiki/prompts/wiki-query.md:16-27`）。
- `/wiki-lint` 只展示机械扫描，contradiction 不自动裁决
  （`refs/pi-llm-wiki/prompts/wiki-lint.md:16-25`）。
- `/wiki-run` 把 discover/ingest/lint 串起来，但没有 durable next-action
  （`refs/pi-llm-wiki/prompts/wiki-run.md:16-31`）。

源码实际注册 14 个常驻工具，trajectory 开启后 17 个，另有 2 个 host command；API docs
和 skill frontmatter 仍写 13/16，是文档漂移
（`refs/pi-llm-wiki/extensions/llm-wiki/index.ts:100-145`；
`refs/pi-llm-wiki/docs/api.md:3-8`；`refs/pi-llm-wiki/skills/llm-wiki/SKILL.md:1-4`）。

### 3.2 当前项目

当前只有一个 host command `/wiki`，处理 init/source add/run/status/pause/resume/cancel；
生产会话不会把宿主主聊天当工作区
（`extensions/wiki/index.ts:18-55,58-100,124-157`）。

语义 SOP 在 `prompts/lead.md` 和四个 `agents/*.md`。Lead 只有 Candidate read/ls、todo、
subagent、candidate_check、publish；write/edit 和 Catalog 工具只给合适 worker
（`extensions/wiki/lib/producer.ts:320-372`；`extensions/wiki/lib/subagent.ts:224-267`）。

这个分层比参考实现更适合 repository 生成：host 强制 safety/provenance/publication
事实，Markdown 决定调查和写作方法。无需改成多个 `/wiki-*` prompt template。

一个可优化点是 resume：现有 session file 被重新打开后，`leadPrompt()` 仍把完整
`prompts/lead.md`、run metadata 和 checkpoint 再作为新 user prompt 发送。恢复所需信息
其实已经在 bounded checkpoint；可只发送“resume instruction + checkpoint”，避免重复静态
SOP 和上下文噪声（`extensions/wiki/lib/pi/session.ts:70-73,202-209`；
`extensions/wiki/lib/producer.ts:1275-1283`）。

## 4. 检索、索引与注入

### 4.1 pi-llm-wiki recall

显式 recall 可搜 primary + personal vault。实现先搜两层，再按
`[...personalResults, ...primaryResults]` 去重和截断，所以 personal 同 id 会先占位；这与
`docs/architecture.md` 同时写“project duplicate priority”和“personal first”存在内部矛盾，
应以源码为准（`refs/pi-llm-wiki/extensions/llm-wiki/lib/recall.ts:557-605`；
`refs/pi-llm-wiki/docs/architecture.md:21-30`）。

自动注入只搜 resolved primary，不追加 secondary personal；但当没有 project vault、
personal 被解析为 primary 时仍会搜 personal。vault 解析顺序实际是 cwd -> `WIKI_HOME` ->
ancestor project -> personal fallback
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/utils.ts:148-199`；
`refs/pi-llm-wiki/extensions/llm-wiki/index.ts:285-311`）。

recall 词法路径包含 NFKC/CJK token、字段权重、chunk preview 和 PRF。hybrid 路径只对
query 做一次可缓存 embedding，失败退回 lexical；因此它“不跑生成模型”，但配置
embedder 时并非零网络（`refs/pi-llm-wiki/extensions/llm-wiki/lib/recall.ts:607-704`）。

大 vault 采用 links-first，阈值默认 50；skill/case 可内联短 body。目的是让 context
开销不随页面正文线性增长（`refs/pi-llm-wiki/extensions/llm-wiki/lib/recall.ts:716-803,846-929`）。

### 4.2 cache-safe 注入

`before_agent_start` 把稳定 `<wiki_status>` footer 留在 system prompt，把每轮变化的 recall
和 topic inference 放 hidden tail message，避免破坏 provider prompt-cache prefix
（`refs/pi-llm-wiki/extensions/llm-wiki/index.ts:229-340`）。测试直接断言不同 recall 结果下
system prompt 字节相同、footer 幂等、dynamic content 在 tail
（`refs/pi-llm-wiki/test/agent-start-injection.test.ts:9-69`）。

当前项目的 Board/receipts/checkpoint 已经是显式文件状态，没有必要每轮 recall Published
Wiki。可继续遵守同一原则：未来增加动态 Candidate 摘要时，放 follow-up/checkpoint，
不要动态改 system prompt。

### 4.3 indexing ownership

pi-llm-wiki 的 registry/backlinks/index/log/embeddings 是增量 vault 必需的 derived
projection，写后后台 coalesce 合理。当前项目则在 `candidate_check` 统一 materialize
目录 index，再 stamp publication，随后重跑 validator；生产期不需要常驻 reindex worker
（`extensions/wiki/lib/producer.ts:457-485`；`extensions/wiki/lib/wiki-okf.ts:514-530`）。

若未来增加 Published Wiki reader，可另建只读 registry/backlinks/search module；在有
真实查询需求和 recall 指标前，不应先复制 embedding sidecar、personal layering 或后台
索引复杂度。

## 5. 校验与 guardrail

### 5.1 pi-llm-wiki

guardrail 对 built-in `write` 逐路径判断；对 `edit` 必须完整提取所有 mutation target，
无法确认就 fail closed。成功的 wiki edit 在 `turn_end` 调度后台 reindex
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/guardrails.ts:196-252`）。

文档 parser 是其最值得复用的部分：128 KiB byte limit、core schema、unique keys、单
document、拒 aliases/custom tags、32 层 depth limit，然后才转成受控 value
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/knowledge-document.ts:320-469`）。文档发现还会
NFC normalize，并把 identity collision 作为 blocking diagnostic
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/vault-format.ts:281-324`）。

`wiki_lint` 检查 orphan、broken link、contradiction marker 和 coverage gap；auto-fix 只
为被至少两页引用的 gap 建 stub，不自动解决语义矛盾。它是 vault health check，不是
发布 gate（`refs/pi-llm-wiki/docs/api.md:220-251`）。

### 5.2 当前项目

当前 evidence view 只允许 pinned Sources、Candidate 和 handoffs，应用 ignore/exclude，
并在实际读取前 realpath 检查 symlink escape；Published Wiki 和 `.okf-wiki` ledger 不在
普通可读域（`extensions/wiki/lib/path-policy.ts:49-107`）。writer 只能写 assigned
Candidate target，越界和重叠 target 都机械拒绝
（`extensions/wiki/lib/path-policy.ts:115-175`；`extensions/wiki/lib/subagent.ts:342-377`）。

全局 validator 已覆盖：

- symlink/non-regular entry、非法 path；
- template filename/type/placement、title/description、精确 H1/H2、空 section、placeholder；
- source resource 语法、文件存在、行号范围、footnote 映射；
- broken internal links、required topology、至少一个 concept cluster；
- Mermaid section/kind/content；
- Source/Catalog ownership和 Catalog availability。

证据分别见 `extensions/wiki/lib/wiki-okf.ts:70-151,194-301,304-405,442-512`。citation 是
按页 `sources[]` 的 provenance，不再要求每个 H2 都有 citation；Catalog citation 也只
验证命名/availability/ownership，不强迫 worker 为代码中出现的表名读取数据库
（`extensions/wiki/lib/wiki-okf.ts:256-301`）。

writer 在退出前由同一 session 做 exhaustive completion check：只对本次 touched 页面
核对 cited file 是否在本 session 成功读取且覆盖指定行，再合并 Todo 和 target validator
问题，一批返回修复；默认最多 6 轮，不经过 Lead 重开 worker
（`extensions/wiki/lib/completion.ts:30-65,84-192,245-270`）。reviewer 同样在原 session
修复 verdict 格式（`extensions/wiki/lib/completion.ts:69-81`）。

publish 会重跑 Source pin 和 validator，要求 final `candidate_check` revision、强制当前
Candidate digest 对应的 `verdict: pass` 和未修改的 review handoff，然后才安装
（`extensions/wiki/lib/producer.ts:418-455`；`extensions/wiki/lib/wiki-okf.ts:407-430`）。

`frontmatter.ts` 虽然直接调用 `YAML.parse`，但当前锁定的 `yaml@2.9.0` 已默认拒绝重复
key、多文档和过量 alias expansion，YAML 1.2 下 merge 默认不展开；随后 validator 还会
检查顶层 mapping 和允许字段。没有资源耗尽事故或不可信外部 Wiki 导入前，不应把额外
byte/depth/alias 禁令列为产品 P0（`extensions/wiki/lib/frontmatter.ts:12-30`）。

## 6. 并发与后台 worker

pi-llm-wiki 的 ingest 是 detached background task：工具先返回，完成后 toast +
`nextTurn` report；batch 内每个 source 可并发，session boundary drain
（`refs/pi-llm-wiki/extensions/llm-wiki/lib/tools.ts:393-455`；
`refs/pi-llm-wiki/extensions/llm-wiki/lib/runtime.ts:183-242`）。它适合日常增量 vault，但
没有 timeout/cancel 和跨 vault label 隔离。

当前项目没有 detached production writer。Lead 的 `subagent` tool 等待 worker batch，
但 batch 内按 `maxConcurrentAgents - 1` 并发；survey 可共享执行，synthesize/review 独占，
write 只能在一个独占 batch 内并行不重叠 targets
（`extensions/wiki/lib/producer.ts:336-349`；`extensions/wiki/lib/subagent.ts:80-160,342-377`）。
AbortSignal、wall-clock timeout、transient retry、compaction checkpoint 都由 session wrapper
统一处理（`extensions/wiki/lib/pi/session.ts:43-69,169-219`）。

这个设计不用迁移到 detached background：Run 的结果、pause/cancel、Candidate ownership
都要求 producer 知道 worker 何时 settle。参考实现值得借的是 single-flight/drain 思路，
不是 fire-and-forget 语义。

## 7. 测试设计与证据边界

参考仓库有 48 个 `*.test.ts`。代表性覆盖包括：

- parser limits、format collision、mutation fail-closed；
- reindex non-blocking/coalescing/trailing pass；
- Runtime single-flight/drain/report；
- ingest deterministic commit 和 format race；
- recall scoring/layering/embedding fallback/cache；
- cache-safe injection；
- Pi/omp manifest/settings mock；
- 打包后的 MCP JSON-RPC 子进程 smoke。

例证：`refs/pi-llm-wiki/test/indexing.test.ts:109-178`、
`refs/pi-llm-wiki/test/runtime.test.ts:143-285`、
`refs/pi-llm-wiki/test/knowledge-document.test.ts:40-147`、
`refs/pi-llm-wiki/test/agent-start-injection.test.ts:9-69`、
`refs/pi-llm-wiki/test/mcp-package.test.ts:51-190`。

边界也要写清：真实 `agentLoop -> commit_synthesis -> commit` 没有 fake-model event-stream
集成测试；prompt/command 只锁 byte parity，不执行 SOP；Pi/omp 没有真实宿主 E2E。API docs
仍落后于实际工具数，也是现有测试没有阻止的文档漂移。

当前项目 `pnpm test` 包含 boundaries、typecheck 和 20 个 test 文件中的 186 个 Node tests
（`package.json:26-30`）。风险导向覆盖已经包括 publication fault recovery、run transition/
resume、strict read policy、execution/handoff attestation、writer repair loop、topology/citation/
link/Catalog ownership 和 stale review。例如：

- `test/publication.test.ts:18-58`；
- `test/producer.test.ts:439-568,603-712`；
- `test/completion.test.ts:39-82`；
- `test/wiki-okf.test.ts:447-517`；
- `test/subagent.test.ts:636-788`。

当前测试同样主要使用 fake session，没有真实 model/host E2E。这在模型行为不稳定且 host
不变量已机械覆盖的前提下是合理取舍；只有需要发布兼容性保证时再加一条真实 Pi smoke。

## 8. 当前项目优化结论

### 撤销：strict frontmatter parser

参考实现的 parser 规则不能直接证明当前产品受益。当前依赖已经处理主要 YAML 结构风险，
额外拒绝 alias/custom tag/depth 只会在边缘输出上增加 repair；现有代码和历史里没有对应
故障证据。只有出现资源耗尽，或允许不可信外部文件直接进入 Published Wiki 时，再在文件
读取入口增加简单 byte limit。不要扩充 writer 的 frontmatter contract。

### 撤销：model-facing handoff 引用和 completion status

`SubagentTask` 仍只有 `task` 文本，没有 `contextRefs`。multi-Source synthesis 所需的
survey handoff 由 host 从 completed receipts 注入初始 prompt 和 compaction checkpoint；
fan-in 不再用 `task.includes(handoff.path)` 要求模型精确回显 host 已知状态
（`extensions/wiki/lib/subagent.ts`；`extensions/wiki/lib/producer.ts`）。handoff envelope
和 digest attestation 继续由 host 生成，知识 body 保持 Markdown。这个改动删除了一个
模型形式门槛，没有扩充 model-facing tool schema。

writer 有 Todo + target validation + evidence-read repair，review 有 verdict repair；survey 和
synthesize 只要 session 正常结束就写 handoff，host 不检查规定章节、terminal status 或
未决 gaps，随后 fan-in 会把它当 completed receipt
（`extensions/wiki/lib/subagent.ts:264-303`；`extensions/wiki/lib/producer.ts:559-637`）。

新增 `status: complete|blocked` 只能证明模型写了一个字符串，不能证明调查完整。没有
真实漏项数据前不增加该格式门槛；语义缺口继续由 Markdown handoff、Lead 和最终 reviewer
判断，技术失败继续由 session/runtime receipt 表达。

### 已实施：resume 只发送状态增量

session file 存在时只发送短 resume prompt + 当前 checkpoint；新 session 才发送完整
Lead SOP。补一条测试断言 resumed prompt 不重复 `prompts/lead.md`，但仍含最新 Candidate、
Board、check/review freshness（`extensions/wiki/lib/producer.ts:358-372,1275-1283`）。

### P2（按产品承诺触发）：Catalog observation receipt

当前 Run pin 的是 Catalog 配置和 Source binding，不是查询时返回的 live table definition；
validator 对 `catalog:<catalog>/<table>` 只确认 Catalog 可用和归属，不确认 live table 版本
（`extensions/wiki/lib/inspect.ts:181-236`；`extensions/wiki/lib/wiki-okf.ts:216-235,291-300`）。

如果“同一 Run 可跨时间完全复现 Catalog 证据”成为明确承诺，再把实际使用过的
`db_describe` 输出写成 digest-bound artifact。不要恢复“看到表名就必须查库”或“每个表
citation 都强制读库”的旧校验；它们与按需 evidence 原则冲突。

### P3（有查询需求再做）：Published Wiki reader

先提供 `status/search/read` 和可重建 lexical registry/backlinks；大库指标证明不足后才
加 embeddings。查询域只限当前 Published Wiki，不注入下一 Run，也不引入 personal vault。

## 9. 不建议吸收

1. 不采用 type-bucket 页面目录；当前 repository/domain/concept topology 与 Source
   ownership 更符合 repository Wiki。
2. 不把 personal/previous Wiki recall 注入生产 Run；它会成为未声明证据。
3. 不把 Published Wiki 改成可变中间层；更新仍应是新 Run。
4. 不把 `/wiki-run` prompt Steps 当可靠生产编排；当前 host receipts/gates 更强。
5. 不复制 trajectory memory；Board、Candidate、session、handoff 已覆盖 Run 内恢复，跨 Run
   trajectory 会成为隐藏 Source。
6. 不为了参考实现已有 omp/MCP 就预造 adapter；第二个真实消费者出现时再抽 reader seam。
7. 不拆已有 `publication.ts` / `wiki-okf.ts` 再套接口。`producer.ts` 很长，但只有在
   transition/storage 继续变化导致局部性恶化时才提取内部 `RunStore`，外部
   `WikiProducer.start/current` interface 保持不变
   （`extensions/wiki/lib/producer-types.ts:104-115`）。

## 10. 推荐顺序

1. 不实施 strict frontmatter、`contextRefs` 或 survey/synthesize status contract；
   survey handoff 继续由 host 注入，不要求模型回显。
2. 用固定真实 Workspace 统计发布成功率、repair rounds、issue 修复率、token、耗时和
   fan-in rejection；结构合法率不能替代 Wiki 内容质量。
3. Catalog observation receipt、Published Wiki reader、embedding、
   MCP/omp 都按实际成本或明确产品承诺触发。

最终方向不是把当前项目改造成 `pi-llm-wiki`。应保留当前更强的 Run/Candidate/review/
publication 模型，也不因参考实现存在某项校验就复制；只吸收经本项目失败数据证明的机制。
