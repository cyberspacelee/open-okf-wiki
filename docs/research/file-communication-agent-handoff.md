# Agent / Workflow 文件通信方案

> 研究日期：2026-07-16
> 问题：在本项目引入有界递归 `SubAgents` 和单层 `DynamicWorkflow` 后，是否应以文件作为 Agent/Workflow 间的通信协议？
> 结论范围：当前代码、Pydantic AI Harness `0.7.0`、三个 `refs/` 项目，以及 Google ADK、Argo Workflows、DeepAgents 和 Python 标准库的一手文档。

## 结论先行

不要把目录扫描、lockfile 或“某个文件出现了”当作 Agent/Workflow 的主控制总线。

采用两层协议：

1. **直接返回是 control plane**：只传 `task_id/node_id`、`status`、短 `summary` 和 `receipt` 引用；它表示 child 是否完成，以及 parent 下一步应读什么。
2. **文件是 data plane**：保存完整 evidence、长报告、原始结果和可复核的 receipt；parent 按需读取，而不是把全文塞回上下文。

这与多个成熟实现的共同边界一致：Argo 将小的 output parameters 与大文件 artifacts 分开；Harness `Spill` 返回 handle、preview 和有上限的按需读取；DeepAgents 要求 subagent 返回简短结果、把大数据写入 filesystem；OpenKnowledge 要求研究成果边读边落盘。见 [Argo output parameters](https://argo-workflows.readthedocs.io/en/latest/walk-through/output-parameters/)、[Argo artifacts](https://argo-workflows.readthedocs.io/en/latest/walk-through/artifacts/)、[Harness OverflowingToolOutput](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/README.md#L12-L38) 和 [DeepAgents context engineering](https://docs.langchain.com/oss/python/deepagents/context-engineering#offloading)。

对本项目的最小可行形态是：

```text
Root plan
  └─ DynamicWorkflow（可选：同构 leaf fan-out/reduce）
       └─ SubAgents（有界 Root → Domain → Leaf）
            ├─ 直接返回：ACK / receipt 引用 / 短摘要
            └─ /analysis：完整 JSON receipt、evidence、长 artifact
```

Root 仍是唯一 Wiki 写作者。Child 只能读 `/source`、`/skill`，并写 Host 分配给自己的 `/analysis/<run>/<node>/` 子树；不能看到 `/wiki` 写权限。

## 1. 当前项目的事实约束

当前 `WikiRunApplication` 在一次 `TemporaryDirectory` 内冻结 source 和 skill，并给单个 `Agent` 配置 `/source` 只读、`/skill` 只读、`/wiki` 读写挂载；随后只调用一次 `agent.run()`（[`wiki_run.py`](../../src/okf_wiki/wiki_run.py#L417-L505)）。当前没有 `/analysis` 挂载，也没有 child receipt 协议。

项目的发布器已经有可复用的原子切换模式：先写 release 临时目录，最后用 `os.replace()` 替换 Wiki 指针（[`wiki_run.py`](../../src/okf_wiki/wiki_run.py#L1487-L1531)）。因此新增的研究文件不应直接进入 `/wiki` 或 Published Wiki；只需在同一个 run 临时根下增加独立 `/analysis`，并在 run 结束时清理。

## 2. Harness 0.7.0 能提供什么，不能提供什么

### 2.1 `OverflowingToolOutput` / `Spill` / `read_tool_result`

Harness 说明，工具返回会作为 `ToolReturnPart` 留在历史中，后续每次模型请求都会重复发送；`OverflowingToolOutput` 在返回产生时只处理一次，把大结果移出上下文（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/README.md#L12-L20)）。

`Spill` 是无损 data-plane 原语：持久化完整 payload，给模型一个相对 handle、preview 和 shape sketch；模型通过 `read_tool_result(handle, offset, limit, from_end, pattern)` 按需读取。单次读取有 `limit` 行数上限、拼接字符上限，`pattern` 是字面子串而非正则（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/README.md#L24-L38)；实现中的上限为 1,000 行和 50,000 字符，[源码](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/_capability.py#L503-L561)）。

这说明文件很适合保存长结果，但 `Spill` 不是任务状态机：handle 只说明“这个 payload 可读”，不说明 child 成功、失败、是否已复核或是否允许发布。应把 `Spill` 用作大工具结果的溢出层，不能把它当作 `/analysis` 的完成信号。

有两个容易误用的边界：

- handle 是 backend-addressable 的相对 key，不是应由模型自由拼接的绝对路径；默认 store 按 `(run_id, tool_call_id, retry)` 分文件，默认不会在 run 结束时删除（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/README.md#L128-L174)）。
- `LocalFileStore.write()` 当前直接 `Path.write_bytes(data)`，而不是临时文件加 rename；读取端虽然做了 root containment 和 symlink/`..` 防逃逸，但它不是通用的事务性 receipt 发布器（[官方源码](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/_store.py#L97-L125)）。如果需要“不可见半写文件”的 handoff，应由 Host 在同一目录写临时文件后原子 rename，或提供自定义 `OverflowStore`。

### 2.2 `CodeMode` 的 mount 与 metadata

`CodeMode` 的 `run_code` 只把脚本最后一个表达式作为模型可见返回；中间 Python 变量不会自动进入 parent context（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/README.md#L145-L157)）。nested tool calls/returns 会放在 `ToolReturn.metadata`，供应用层观测；它不是模型可见的通信正文（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/README.md#L159-L169)）。

挂载是访问真实文件的正确入口：`MountDir(..., mode="read-write")` 的写入会落到 Host，`read-only` 会禁止写；默认 overlay 写入不会回写 Host（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/README.md#L171-L188)、[挂载权限](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/code_mode/README.md#L229-L234)）。因此 child 可以把完整 receipt 写入 `/analysis`，但必须在 child Agent 上显式配置自己的 CodeMode mount；父级 capability 不会因为 `SubAgents(inherit_tools=True)` 自动继承。

`CodeMode` 的 mount 允许模型写文件，但不自动给文件定义 schema、状态或原子发布语义。故建议让 Host 预先分配路径和 quota，模型只写该路径；不要让模型决定任意绝对路径或共享目录。

### 2.3 `SubAgents` 的返回语义

每次 `delegate_task` 都是新的 `Agent.run()`，child 有独立 message history，task 必须自包含；返回 parent 的值固定是 `str(result.output)`（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md#L42-L58)）。因此 v0.7.0 的 `SubAgents` 不会把 child 的 Pydantic output 原样作为 parent 的 typed object。

Child 可以自己配置 `SubAgents`，形成树；但每层的 `max_calls` 是本层 parent run 的局部计数，不是全树深度或全树节点上限（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md#L60-L101)、[递归说明](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/subagents/README.md#L213-L216)）。这更支持“直接返回短 ACK，完整内容落文件”的协议：父级只需拿到一个小字符串和 receipt 引用，不应把全文报告再拼回自身历史。

### 2.4 `DynamicWorkflow` 的返回语义

`DynamicWorkflow` 在一次 `run_workflow` 中把 named agents 当 async functions，脚本可以 `asyncio.gather` fan-out、链式调用和 reduce；脚本中间的 reports 不离开 sandbox，只有最后表达式回到模型（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L104-L144)、[结果回传](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L265-L299)）。若 child 的 `output_type` 是 Pydantic model，脚本内得到 dict；这比 `SubAgents` 的字符串化返回更适合 leaf reduce。

它有精确的直接 child `max_agent_calls`，但 workflow 不能嵌套；child 内若另有 `SubAgents`，那些 grandchildren 不计入这个 direct-call ceiling（[预算](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L309-L349)、[禁止嵌套](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L381-L389)）。因此 DynamicWorkflow 适合 Domain 层对同构 Leaf 做一次 fan-out/reduce，不适合用目录轮询或文件锁模拟递归调度器。

成功的 workflow 不会自动持久化中间结果；如果这些结果对审计、重试或后续 parent 读取有价值，child 必须先写 receipt/artifact，再让脚本最后表达式只返回聚合 ACK。脚本异常时 Harness 会给 retry 提示和部分已完成结果，但这不是 durable store（[错误边界](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/dynamic_workflow/README.md#L478-L484)）。

### 2.5 可复用的 `FileSystem` 边界

如果未来不想让模型通过 CodeMode 任意写路径，Harness 自带 `FileSystem` capability 可提供 root containment、symlink 防逃逸、分页读取、文件 hash、glob/search 上限、`expected_hash` 乐观并发检查和 protected patterns（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/filesystem/README.md#L14-L57)）。它比在每个自定义 tool 里重新实现 path guard 更小；但它仍不替代 control-plane ACK，也不自动提供跨进程 durable commit。

## 3. Web 与一手工程材料的共同模式

### 3.1 Argo：参数传控制，小参数；artifact 传文件

Argo 的官方示例把一个步骤生成的文件作为 output artifact，再作为下一个步骤的 input artifact；artifact 可以是文件或目录，适合大 payload（[Artifacts / Basic Example](https://argo-workflows.readthedocs.io/en/latest/walk-through/artifacts/#basic-example)）。

同一文档把 output parameters 定义为步骤结果的参数，用于条件、循环和参数传递；参数值可以来自生成文件的内容（[Output Parameters](https://argo-workflows.readthedocs.io/en/latest/walk-through/output-parameters/)）。脚本/容器的 `outputs.result` 还限制为最多 256 KB，进一步表明控制返回不应无限增长。

Argo 的 artifact 文档还要求并发 workflow 用 workflow UID 等命名空间化 key，避免不同 workflow 互相删除或覆盖，并提供按 workflow completion/deletion 的 artifact garbage collection（[Artifact naming](https://argo-workflows.readthedocs.io/en/latest/walk-through/artifacts/#artifact-naming)、[Artifact garbage collection](https://argo-workflows.readthedocs.io/en/latest/walk-through/artifacts/#artifact-garbage-collection)）。这直接对应本项目的 `run_id/node_id/attempt` 命名和 run-local TTL。

### 3.2 Google ADK：artifact 是有命名空间、版本和生命周期的数据层

Google ADK 的 ArtifactService 按 `app_name/user_id/session_id/filename` 组织 artifact，并把同一文件的版本作为显式序列保存；InMemory 实现是进程内、run 临时数据，GCS 实现用于跨重启持久化（[ADK Artifacts](https://adk.dev/artifacts/#available-implementations)）。

ADK 的最佳实践要求区分临时与持久 artifact 名称、使用有意义的 filename、固定 MIME type、需要历史时显式指定版本，并为持久 artifact 配置删除或 GCS lifecycle policy；极大数据不应无条件装进内存（[ADK best practices](https://adk.dev/artifacts/#best-practices)）。这支持本项目将 receipt/artifact 命名空间化、版本化，而不是用一个共享 `latest.json`。

### 3.3 DeepAgents：subagent 返回短结果，大数据进入 filesystem

DeepAgents 官方文档把上下文压缩拆为 offloading 和 summarization：大工具输入/结果超过阈值时写入 filesystem，模型上下文只保留路径和 preview；旧消息总结后，原始消息文本也会保存到 filesystem 以便回查（[context offloading](https://docs.langchain.com/oss/python/deepagents/context-engineering#offloading)）。

其 subagent 指南明确建议：subagent 返回 essential summary，不要返回 raw data 或详细 tool output；遇到大数据时写入文件，再让 main agent 按需读取（[subagent context isolation](https://docs.langchain.com/oss/python/deepagents/context-engineering#context-isolation-with-subagents)、[官方建议](https://docs.langchain.com/oss/python/deepagents/subagents#context-still-getting-bloated)）。这和本项目的“直接 ACK + `/analysis` receipt”完全同构；但 DeepAgents 的文件 backend/state 不是 Pydantic Harness 的自动能力，不能直接假设它会替当前项目做权限或清理。

### 3.4 refs：落盘是恢复和 progressive disclosure 的基础

- OpenKnowledge 把“边读边写”定义为 crash-safe checkpoint：每获取一个 source 就 ingest，每分析一个 source 就把 findings 写进文章；发生 compaction 或 crash 后先读回已有部分，再补缺失内容（[research-body.ts](https://github.com/inkeep/open-knowledge/blob/96563d1ea9b51b5854c5651a7091d8f96512f4cd/packages/server/src/mcp/tools/research-body.ts#L65-L72)、[写作阶段](https://github.com/inkeep/open-knowledge/blob/96563d1ea9b51b5854c5651a7091d8f96512f4cd/packages/server/src/mcp/tools/research-body.ts#L218-L228)）。
- OpenWiki 要求 subagent 使用窄 scope、只读调查、返回 source paths 和 open questions，主 Agent 负责最终写入；同时要求临时 `_plan.md` 记录页面、证据和问题（[prompt.ts](https://github.com/langchain-ai/openwiki/blob/ddd1f609b23d83b96a800ea0f4d47e7d28a78c7d/src/agent/prompt.ts#L78-L90)）。
- Knowledge Catalog 为每个 concept 建立新的 session，并按目录深度从 leaf 到 root 生成 index；父级只消费 child 的 title/description，需要时再加载详细文件（[runner.py](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/d44368c15e38e7c92481c5992e4f9b5b421a801d/okf/src/reference_agent/runner.py#L206-L257)、[index.py](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/d44368c15e38e7c92481c5992e4f9b5b421a801d/okf/src/reference_agent/bundle/index.py#L49-L103)）。

三个 refs 都支持“文件是可重读的内容层”，但没有一个把目录枚举或 lockfile 当作 Agent 状态机。状态仍由宿主 session/plan/step 维护。

## 4. 建议的 `/analysis` handoff 协议

### 4.1 直接返回：只做 ACK 和索引

`SubAgents` 的直接返回在 Harness 0.7.0 会被转成字符串；`DynamicWorkflow` 可以在脚本内保留 typed dict。因此协议应允许两种外形，但语义相同：

```json
{
  "schema": "okf.analysis.handoff/v1",
  "task_id": "opaque-host-id",
  "node_id": "domain-auth-01",
  "attempt": 1,
  "status": "complete",
  "summary": "短摘要；只保留结论和需要 parent 决策的点",
  "receipt": "analysis/run-123/receipts/domain-auth-01/attempt-01.json"
}
```

推荐约束（Host policy，而非 Harness 默认值）：

- 直接返回控制在约 4–8 KiB；超过就写文件，不要把 evidence 拼进返回值。
- `status` 只能是 `complete`、`partial`、`failed`、`cancelled` 之一；缺少 `receipt` 的 `complete` 视为协议错误。
- `summary` 只用于 parent 选择下一步；精确 claim、源码路径/行号、open questions 必须在 receipt 中。
- `SubAgents` child 返回 compact JSON string 或一行 receipt reference；不要依赖 `str(PydanticModel)` 产生可解析 JSON。
- `DynamicWorkflow` 的最后表达式返回 `list[HandoffRef]` 或单个 reduce receipt；中间 child reports 若未写文件，在成功后不可再取。

### 4.2 文件：不可变 receipt + 可选长 artifact

建议使用 UTF-8 JSON receipt（机器消费）和可选 Markdown artifact（人读/长叙述）：

```json
{
  "schema": "okf.analysis.receipt/v1",
  "run_id": "run-123",
  "node_id": "domain-auth-01",
  "parent_id": "root",
  "attempt": 1,
  "status": "complete",
  "scope": "src/auth and authentication docs",
  "source_revision": "<frozen revision>",
  "summary": "...",
  "evidence": [
    {
      "path": "src/auth/service.py",
      "line_start": 42,
      "line_end": 67,
      "claim": "..."
    }
  ],
  "artifacts": [
    {
      "path": "analysis/run-123/artifacts/domain-auth-01/findings.md",
      "media_type": "text/markdown",
      "bytes": 12345,
      "sha256": "..."
    }
  ],
  "open_questions": []
}
```

Receipt 是 immutable snapshot：不要多个 Agent 共同编辑一个 `latest.json`，不要用 JSON 数组 append 作为并发协议。若需要事件日志，Host 单独写 append-only JSONL；它不是 child 完成信号。

### 4.3 命名和目录

目录由 Host 分配，模型不能自行选择根路径：

```text
/analysis/<run_id>/
  plan.json                         # Root/Host 维护；child 只读
  receipts/<node_id>/attempt-01.json
  receipts/<node_id>/attempt-02.json
  artifacts/<node_id>/findings.md
```

`run_id`、`node_id`、`attempt` 使用 Host 生成的 opaque ID；不要把用户输入或 source 中的路径直接拼成文件名。按 Argo 的 workflow UID 命名原则，每次 run 都必须有隔离命名空间，重试不覆盖旧 receipt。

### 4.4 写入、原子性和并发

写入规则：

1. 每个 child 只拥有自己的 `receipts/<node_id>/` 和 `artifacts/<node_id>/`；siblings 不共享写路径。
2. Host 先在目标目录创建随机临时文件，写完并校验 JSON/大小/hash 后，用同一文件系统的 `os.replace(temp, final)` 发布。Python 文档保证成功的 `os.replace` 是 atomic，但跨 filesystem 可能失败（[Python `os.replace`](https://docs.python.org/3/library/os.html#os.replace)）。
3. 若要求 crash 后仍保证数据落盘，Host 还需在 rename 前后执行文件和父目录 `fsync`；Linux `fsync(2)` 明确说明仅 fsync 文件不保证目录项已落盘（[fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html#DESCRIPTION)）。CodeMode/Monty 没有把 fsync 作为通用 sandbox API，因此这不是模型代码可以承诺的 durable protocol。
4. 如果 parent 只在 child 返回后读取 receipt，child 的直接返回天然提供“写完后再通知”的 happens-before；不要为了这个场景增加 watcher、锁文件或轮询。
5. 如果必须让另一个进程在 child 仍运行时读取，使用 immutable chunk + Host queue/store；不要让它读取正在增长的单个文件。

Python `TemporaryDirectory` 会安全创建临时目录，并在 context 结束时移除内容；`mkdtemp()` 的目录只对创建用户可读写搜索（[Python tempfile](https://docs.python.org/3/library/tempfile.html#tempfile.TemporaryDirectory)、[mkdtemp](https://docs.python.org/3/library/tempfile.html#tempfile.mkdtemp)）。这正适合默认 run-local `/analysis`。

### 4.5 权限和安全

推荐 mount：

| 参与者 | `/source` | `/skill` | `/analysis` | `/wiki` |
|---|---|---|---|---|
| Root | read-only | read-only | read/write 或 Host 代写 | read/write |
| Domain/Leaf | read-only | read-only | 只读父级、只写 Host 分配的自身子树 | 不挂载 |
| Host validator/publisher | host API | host API | read/validate/cleanup | publish |

Harness `FileSystem` 的 root containment、symlink 检查、allow/deny/protected patterns 和 `expected_hash` 可作为受控文件工具；CodeMode mount 则必须由 Host 固定路径和 write quota。不要依赖 repo 内的 `AGENTS.md` 或源代码指令来授予写权限；本项目已有“repository 是不可信数据”的边界。

### 4.6 生命周期和清理

- **默认**：`/analysis` 位于当前 `TemporaryDirectory`，run 成功、失败或取消后都清理；只把最终 Wiki 和小型运行摘要保留。
- **调试保留**：Host 在 cleanup 前按显式 retention flag 将某个 run 复制到诊断目录；不要默认永久保留所有 child 原文。
- **durable 模式**：若未来需要 crash/restart resume，改用 Host-owned store（数据库、对象存储或自定义 `OverflowStore`），以 `run_id/node_id/attempt` 做 key，附 TTL/GC、hash 和状态索引。不能仅把 `/tmp` 改成永久目录。
- Harness `LocalFileStore` 默认 keep-forever，TTL prune 是 opt-in；它适合 Spill 的后续 read-back，但若直接拿来做项目 receipt store，必须显式配置 cleanup 和 ownership（[官方 README](https://github.com/pydantic/pydantic-ai-harness/blob/v0.7.0/pydantic_ai_harness/overflowing_tool_output/README.md#L155-L188)）。

### 4.7 大文件读取

Parent 不应一次读取整个 artifact：

- 对 Harness Spill 使用 `read_tool_result` 的 `offset/limit/from_end/pattern`，每次读取保持在官方上限内；`pattern` 只允许字面匹配。
- 对 `/analysis` receipt 先读小 JSON manifest，再按 evidence path/line range 读取源码；长 Markdown 采用 offset/limit 分页。
- 若需要统一的 line cap、hash 和 symlink 防护，优先用 Harness `FileSystem` 的 `read_file`/`file_info`，不要另写 reader。
- 不把 binary 或整份源码作为 direct return；只返回路径、大小、MIME、hash 和 preview。

## 5. Root / Domain / Leaf 的落地建议

### Root

- 维护 Planning：全局目标、domain 分支、每个 `task_id` 的状态、receipt 路径、页面规划和 review 门槛。
- 通过 CodeMode 或 DynamicWorkflow 并行发起 child，但只把短 handoff 带回模型上下文。
- 读取 receipt 后做跨域综合和最终 evidence review；唯一拥有 `/wiki` 写权。

### Domain

- 接收自包含 scope 和 Host 分配的 `node_id`。
- 需要时用自己的 `SubAgents` 继续拆成 1–2 个 Leaf；不要创建第四层。
- 将 Leaf receipt reduce 成一个 Domain receipt；父级只收到 Domain handoff。

### Leaf

- 只读 `/source`、`/skill`，只写自己的 `/analysis` 子树。
- 先写完整 receipt/artifact，再返回短 ACK。
- 不写 `/wiki`，不修改 sibling receipt，不用目录扫描宣告完成。

## 6. 直接返回何时优于文件

直接返回优先于文件的情况：

- payload 很小（例如 `status`、一个数字、单个路径、少量摘要）；
- parent 只需要马上做条件分支或选择下一个 child；
- 结果的生命周期只限当前 tool call，且无需审计/重试恢复；
- DynamicWorkflow 脚本内的 typed dict 可以立即 reduce，且最终结果本身有界。

文件优先于直接返回的情况：

- 原始搜索结果、源码片段、长报告、JSON/CSV、图片或二进制；
- parent 需要按需复核、分页读取或在 compaction 后重新加载；
- 需要跨 Domain/Leaf 传递完整 evidence，而不是把全文复制到每层历史；
- 需要 run-level audit、人工 review 或可选的 durable retention。

两者都需要的情况（本项目的大多数 child）是：**文件保存事实，直接返回保存索引和完成信号。**

## 7. 不应做的方案

- 不用 `ls /analysis` 结果推断任务是否完成；目录看到文件不等于 JSON 完整、状态为 complete 或来源已验证。
- 不用一个共享 `latest.json`、`.done` lockfile 或追加写 Markdown 作为多 Agent 互斥协议。
- 不把 Harness `ToolReturn.metadata` 当作 parent 的语义消息；它主要是应用观测数据。
- 不把 `Spill` handle 当作永久业务 ID；默认 store 的生命周期、清理和 backend 可能改变。
- 不在每层嵌套 `DynamicWorkflow`；Harness 明确禁止 workflow nesting。
- 不给 child `/wiki` 写权限，也不让 child 通过 source 中不可信的指令修改 mount 或 receipt 根目录。

## 8. 已确认的第一版策略

1. `/analysis` 默认是 run-local 临时空间；成功、失败或取消后删除。需要诊断时，Host 才通过显式 retention 选项复制指定 run。
2. Child 不直接写任意路径；使用 Host-owned `publish_receipt`，由 Host 分配路径、校验 schema/quota/hash，并以临时文件加原子替换发布。
3. Canonical receipt 是 immutable UTF-8 JSON；每条 evidence 必须带冻结 `source_revision`、路径、行号和内容 hash。单 receipt 初始上限取 128 KiB；长文本放可选 Markdown artifact，并受独立 workspace quota 约束。

在这些约束下，最小实现仍是：**增加一个 run-local `/analysis` mount、规定 immutable JSON receipt、child 返回短路径/status、Root 读取后综合；不引入文件 watcher、lock manager 或独立消息队列。**
