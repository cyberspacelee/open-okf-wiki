# Repo Wiki 的 Codex CLI Java 黑盒 QA

日期：2026-08-28
结论：当前实现能为单个中型 Java Source 生成有价值的 Domain Page Plan，但官方双
Source Java live fixture 无法启动，且现有 gate/eval 不能阻止语义过浅的 Plan。

## 范围和方法

使用 `codex-cli 0.150.1` 的非交互 `codex exec --json` 运行 repo-wiki，保留 JSONL
事件，以便分别检查 LLM 消息、命令调用、工具输出和 token usage。`--json` 是 Codex
CLI 提供的 JSONL 事件输出接口，参见
[Codex CLI command reference](https://developers.openai.com/codex/cli/reference)。

固定的 Java Source：

| Source | Revision | tracked files |
|---|---|---:|
| OpenFeign `feign` | `65b42b82989d10c9df9e22156cc4019c7a346d3e` | 734 |
| `spring-cloud-openfeign` | `d666180973c01b0969ed82cb8e78db7a7e1b1971` | 274 |

先运行 `evals/setup_java_ws.py` 的双 Source fixture。它在 `run start` 失败后，改用
单 Source `spring-cloud-openfeign` 建立 run，再分别执行协调器和独立
`plan:workspace` worker。没有继续生成 page、review 或 Publication，因为本次 QA
聚焦用户报告的 Plan 深度，并且协调器的 worker dispatch 已经挂起。

临时证据保存在 `/tmp/repo-wiki-qa.h90cUR/`：

- `plan-trace.jsonl`：首次协调器运行，暴露 sandbox 中的 `uv` cache 问题。
- `plan-trace-2.jsonl`：预热 cache 后的协调器运行，暴露 worker dispatch 挂起。
- `worker-trace.jsonl`：独立 Plan worker 的完整 JSONL 工具轨迹。
- `qa-ws/.okf-wiki/runs/r-20260828-4cee9f/drafts/plan/workspace.json`：State Gate
  接受的 Page Plan。

## 结果摘要

独立 worker 最终生成 6 页 DAG：4 个 source-owned Domain 叶子页、
`architecture.md` 和 `overview.md`。四个 Domain 是：

- 客户端注册与配置；
- Spring MVC 契约与编解码；
- 负载均衡与重试执行链；
- 熔断器与降级调用。

这个结果比按 package 或文件建页明显更合理，说明“结构 Index + 按需导航 + Page
Plan”方向可行。不过，结果质量主要依赖本次模型主动探索，不是当前 contract、gate
或 eval 能保证的行为。

worker 的已完成导航调用为 6 次 `outline`、7 次 `search`、3 次 `read`。Codex CLI
报告 313,076 input tokens，其中 265,728 cached，未缓存 input 为 47,348；工具输出
合计 82,499 bytes。单次最大的两个搜索结果分别为 12,303 和 11,123 bytes。

## Findings

### 1. Blocker：官方 Java live fixture 无法 `run start`

`setup_java_ws.py` 注册 `feign` 和 `spring-cloud-openfeign` 后，`run start` 抛出：

```text
ValueError: required structural anchors exceed the index byte budget
```

对相同 Revision 直接计算 Index floor：

| Source | Maven modules | source sets | required anchors | floor | budget |
|---|---:|---:|---:|---:|---:|
| `feign` | 55 | 110 | 165 | 76,836 B | 65,536 B |
| `spring-cloud-openfeign` | 5 | 4 | 9 | 5,385 B | 65,536 B |

根因在 `_index.build_index`：所有 Maven module 和所有 source set 都进入不可折叠的
`required` 集合；预算只允许折叠 candidates。当 required floor 已超预算时，没有
进一步降级策略，只能终止整个 Run。失败对象是官方 tier-2 eval 自己选择的
`feign` fixture，因此不是假想的超大仓库边界。

### 2. High：浅 Plan 没有语义回归防线

本次 Plan 的页面名称有价值，但 4 个 Domain 中只有“客户端注册与配置”的 scope
读过源码。契约与编解码、负载均衡与重试、熔断与降级都仅凭目录枚举和文本搜索完成
规划，没有 `task read` 命中其 scope。

临时 QA 检查：

```text
uv run python /tmp/repo-wiki-qa.h90cUR/check_plan_depth.py
FAIL: 2 regex-like queries sent to literal search; no source read for:
spring-mvc-contract-and-codecs.md, load-balancing-and-retry.md,
circuit-breaker-and-fallback.md
```

这不是说 planner 必须完整研究每一页；深度研究本应由后续 page worker 完成。问题是
当前没有任何可测的 Plan 探索下限：

- `references/plan.md` 要求使用导航命令，但没有要求每个 Domain 决策具备源码抽样
  或记录未确认的 gap。
- `_validate_page_plan` 只验证 schema、必需根页、owner、scope 存在性和 DAG。
- Plan 没有独立 review Target。
- `evals/grade_run.py` 的 `required routing concepts exist` 只检查
  `overview.md` 和 `architecture.md`；一个没有任何 source-owned Domain 页的 Plan
  不会被这条断言判失败。

因此“模型这次找到了 4 个 Domain”和“系统能持续生成深入 Plan”是两回事。遗漏的
Domain 不会产生 page/review Target，也就没有后续机制发现这个遗漏。

### 3. High：Codex CLI 协调器的 worker dispatch 可永久挂起

预热 `uv` cache 后，协调器正常完成 `run status`、`task start plan:workspace` 和
reference 读取。第一次 worker launch 报 orchestration error；重试后进入：

```text
tool: wait
receiver_thread_ids: []
status: in_progress
```

没有 receiver、超时、失败 Handoff 或自动 `run pause`，目标保持 in-progress，直到
外部中断 `codex exec`。`SKILL.md` 已写“workers unavailable 时 pause”，但当前
host loop 没有确定性机制执行这个回退。结果是一个平台侧 dispatch 故障可变成无限
等待，而不是可恢复的 paused Run。

### 4. Medium：`search` 的 literal 语义没有进入 worker packet

worker 两次把 `<pattern>` 当作正则：

```text
CircuitBreaker|LoadBalancer|Capability
class FeignClientsRegistrar|class FeignClientFactoryBean|class FeignAutoConfiguration
```

两次都返回空结果。实现实际执行 `if query not in line`，CLI `--help` 也称其为
literal text；但 dispatch packet 只暴露 `<pattern>`，`references/plan.md` 也只写
`search`。常见 grep 心智模型会把 `|` 当 alternation，导致静默的假阴性。worker
后来用 5 个单独 literal 查询补救，但这是模型偶然恢复，不是接口防误用。

### 5. Medium：Plan 探索的总上下文成本偏高

单 Source 只有 274 个 tracked files，agent-facing Index 实际回传约 8.9 KB，但
Plan worker 的累计 input 已到 313k tokens。主要放大器是宽泛 literal search：50
条/16 KiB 的单次上限对单个工具响应是 bounded 的，却仍允许多个 7--12 KB 结果进入
同一累积对话。

这不证明 64 KiB Index 预算本身过大。本次 Index 不是主要输出项；更直接的问题是
search 没有默认 path 收窄、命中摘要或更小的 Plan 专用预算，reference 也没有要求
先限定 module/package 再搜。应分别记录总 tool-output bytes、cached/uncached input、
查询数和有效查询率，不能只看最终 Index 大小。

### 6. Medium：live-eval 的失败信息被吞掉

`setup_java_ws.py` 的 `call()` 对所有子进程使用 `capture_output=True`，但不捕获并
重报 `CalledProcessError` 的 stdout/stderr。fixture 失败时，顶层只显示命令返回码；
必须人工重放 `run start` 才能看到 Index budget 异常。这直接降低 live QA 的可诊断
性，也会让 CI 日志缺失真正根因。

### 7. Harness limitation：默认 sandbox 不能直接复用 `uv` 环境

第一次 `codex exec --sandbox workspace-write` 中，全局 `uv` cache 只读；切到空的
`/tmp` cache 后，sandbox 又不能联网下载依赖。agent 为此执行了多轮 cache 探测，尚未
进入 repo-wiki Target。外部预热并设置 `UV_CACHE_DIR` 后可以运行。

这是 Codex CLI live-eval harness 的环境准备问题，不足以判定 repo-wiki runtime
本身有缺陷；但如果 Codex 是受支持 host，eval driver 应准备可写且已解析依赖的
cache，避免把环境排障混入 skill 质量轨迹。

## 已证实和未证实

已证实：

- package-aware Index 能帮助模型从 274 文件中提取 4 个合理 Domain，而没有按
  package/file 全量建页。
- required-anchor floor 会让 `feign` 在 64 KiB 预算下确定性失败。
- 当前 Plan gate 和 live grader 不验证 source-owned Domain recall 或探索深度。
- literal search 的接口文案不足已在真实轨迹中造成两次空查询。
- Codex CLI coordinator 的空 receiver wait 不会自行恢复。

尚未证实：

- 4 个 Domain 是否足以覆盖 `spring-cloud-openfeign` 的最高价值概念；需要人工 rubric
  或独立 Plan evaluator，而不是从页面数倒推。
- 增加 planner 源码读取是否一定提高最终 Wiki；应比较最终 page 质量和总成本。
- Ponytail skill 在本次 worker 中被自动加载并强调“smallest plan”，但单次运行不能
  分离它与 repo-wiki 的 Grep Test 对页面数量的影响。

## 建议的整改顺序

1. 先修 required-anchor budget，使官方 Java fixture 能启动，并让 setup 透传子进程
   stderr；这是后续所有 live eval 的前提。
2. 为 Plan 增加独立的语义 eval/rubric，至少检查 source-owned Domain 的存在、每个
   Domain 的源码抽样证据和已知 fixture 的关键概念召回。不要把这类 LLM 质量判断
   塞进确定性 schema gate。
3. 在 packet/reference 明示 search 是 single literal query，并要求优先用 `--path`
   收窄；同时把 Plan 搜索结果预算与 page research 分开计量。
4. 给 host dispatch 增加可观察的失败/超时回退：没有实际 worker id 时禁止 wait，
   并按现有 SOP 将 Run pause。
5. 用同一固定 Revision 做 baseline/A-B：记录 Plan concepts、有效导航率、tool output、
   cached/uncached tokens，再决定是否需要更丰富的 Index 信号。

首次黑盒 QA 只记录问题；以下 follow-up 记录随后实施的快速整改和复验。

## Follow-up：快速整改复验

整改保持 Target DAG 不变，没有恢复 triage/survey/connect，也没有新增
`review:plan`：

- Index 将 build module/source-set 从不可折叠 required anchors 改为优先保留的
  structural candidates；root 是唯一不可折叠记录。
- Page Plan 增加稳定的 `evidence_seeds` 字段。source-owned Git/files 页面必须提供
  1--3 个 Pin 内、Page Scope 内且行范围有效的 Locator。
- plan/page reference 要求先用单个 literal query 和 `--path` 定位行为，再读取命中
  窗口；search 单次上限从 50 条/16 KiB 收紧为 20 条/8 KiB。
- live grader 要求至少一个 source-owned concept，且所有 source-owned concept 都有
  evidence seeds；fixture setup 和 driver 现在透传失败详情。

确定性验证：

```text
98 passed in 2.93s
run_cli_e2e.py: passed=true, pages=4
```

原双 Source fixture 重新运行成功。输出 Index 为：

| Source | agent-facing Markdown |
|---|---:|
| `feign` | 23,995 B |
| `spring-cloud-openfeign` | 8,925 B |

没有提高 64 KiB 上限；此前 76,836 B 的 required-anchor floor 不再阻断 Run。

Codex CLI 的隔离 Plan worker 完成 6 次 `outline`、8 次 path-bounded literal
`search` 和 15 次 `read`，State Gate 接受 5 页 DAG：

- `data/feign/invocation-lifecycle.md`；
- `data/spring-cloud-openfeign/client-registration.md`；
- `data/spring-cloud-openfeign/request-routing.md`；
- `architecture.md`；
- `overview.md`。

三个 source-owned Domain 各携带 3 个已读取的行为窗口，覆盖动态代理分派、同步调用/
重试/解码、Spring 客户端扫描与按客户端上下文、直连和负载均衡选择、断路器及
fallback。与首次运行相比，不再出现 regex-like literal 查询，也不再有 Domain 只靠
文件名而没有源码窗口。

仍未解决：

- 双 Source Plan 的 Codex CLI 累计 input 为 582,483 tokens，其中 504,064 cached；
  evidence contract 提高了深度，但总上下文成本仍需单独优化。
- State Gate 验证 seed 可解析、在 scope 内且行范围有效，不能证明 host 真的调用过
  `task read`；本次 JSONL 轨迹证明实际读取，长期需要 trace grader 或 Plan Review。
- coordinator 的空 receiver worker wait 没有在这次快速整改中修改；本次使用明确的
  short-lived worker 直接验证 Plan contract。
- 本机持久 Ponytail 会干扰 repo-wiki worker。显式 `Normal mode` 后运行正常；这是
  host skill 路由问题，不应通过放宽 repo-wiki gate 规避。
