# Repo Wiki Kill Bill 多仓黑盒 QA

日期：2026-08-28 至 2026-08-29
结论：按领域概念规划页面的方向成立，但当前运行成本、worker 接口摩擦和 review
收敛性不足以支撑企业级多仓项目。本次 Run 没有发布，不能把 7 个 Candidate 叶子页
称为最终 Wiki。

## 固定场景

场景选择依据见
[enterprise-java-multirepo-selection.md](enterprise-java-multirepo-selection.md)。
本次使用 Kill Bill 的四个仓库：

| Source | Revision | tracked files | Java files | shallow checkout |
|---|---|---:|---:|---:|
| `killbill` | `cb60779c171391be558cd7aebb1eafea60ad2b82` | 2,087 | 1,698 | 39 MB |
| `killbill-api` | `7e0fe92ed1321554069877dd65850da8df9b828a` | 234 | 209 | 1.4 MB |
| `killbill-commons` | `53ae7fbe7a427aba18a47ffc55bd5369e5f1ccb7` | 1,216 | 1,084 | 9 MB |
| `killbill-platform` | `9d62015925ec1867405edb26fd70cb3cbc43350b` | 308 | 206 | 72 MB |

合计 3,845 个文件、3,197 个 Java 文件。Run workspace、Pins、Codex traces 和
依赖缓存合计约 199 MB，位于 `/tmp/repo-wiki-killbill.7UnuVa/`。这是临时诊断证据，
不是版本化 fixture；可复现定义已经进入 `evals/setup_java_ws.py --scenario killbill`。

四个 Source 的 agent-facing Index 分别为 15,165、4,634、17,441 和 24,389
bytes，总计 61,629 bytes，每个均小于 64 KiB。Index 大小不是本次成本失控的主因。

正式运行前还预检了 Axelor ERP 的 platform + suite 两仓：10,109 个 tracked files、
5,043 个 Java files，两个 Index 为 18,034 和 20,995 bytes。Plan worker 在被主动停止
前已执行 153 个命令，产生 373,083 chars 工具输出，但仍未写出 artifact。它通过
`outline` 拉取过大的业务服务目录，并在 account、HR、contract 等模块间持续扩张。
这与 Kill Bill 结果一致：企业项目的首要问题不是 Index byte 上限，而是 Plan 没有
跨调用的总探索预算。Axelor 保留为后续 ERP 规模压力候选，不加入默认 live fixture。

## 运行结果

Plan 生成了 9 页 DAG：7 个叶子概念页，加 `architecture.md` 和 `overview.md`：

1. subscription 与 entitlement 生命周期；
2. invoice、payment 与 overdue 链路；
3. tenant/account call context；
4. public API contracts；
5. durable events 与 notifications；
6. service lifecycle；
7. plugin runtime；
8. workspace architecture；
9. workspace overview。

这个粒度明显优于按 Maven module、package 或文件建页，证明“Index 导航 +
concept Page Plan”能在企业多仓项目中避免页面爆炸。但 Plan 的 `gaps` 为空，且漏掉
Kill Bill 的 usage/metering；它也没有独立覆盖 catalog plan/phase/pricing。遗漏主题不会
产生 Page 或 Review Target，后续流程无法主动发现。

7 个叶子页全部至少一次通过 State Gate，Candidate 共 888 行、64,476 bytes。
`architecture.md`、`overview.md`、Publication `index.md` 和 `log.md` 从未生成。

## 成本和轨迹

共保留 23 个 JSONL worker trace，其中 22 个正常结束，最后一个 queue review 按用户
要求停止并标记 failed。汇总如下：

| 指标 | 数值 |
|---|---:|
| Codex input tokens | 12,515,308 |
| cached input tokens | 10,994,176 |
| output tokens | 173,525 |
| completed commands | 889 |
| command output | 2,404,692 chars |
| failed commands | 107 |
| `task read` | 536（96 次失败） |
| `task search` | 124 |
| `task outline` | 56 |
| CLI `--help` probes | 27 |
| direct `.okf-wiki` inspection commands | 50 |

Plan 自身执行 75 个命令，产生 201,764 chars 工具输出，并消耗 914,897 input
tokens。首轮 7 个 Page worker 每个消耗 516,768 至 1,242,314 input tokens。
“Index 小”没有转化成“Target 探索有总预算”。

## Candidate Wiki 质量

| 页面 | 质量判断 | 主要问题 |
|---|---|---|
| Subscription/entitlement | 强；解释双时间轴、事件重放、plan change、暂停/恢复/取消 | 复审仍发现 billing date 钳制和取消策略的 Locator 范围不足 |
| Invoice/payment/overdue | 强；形成跨模块事件与状态机链路 | 初审发现提交条件、external key 校验和事件扇出被过度概括；修订后只剩 Plan-owned 语言问题 |
| Tenant context | 较强；覆盖 record id 隔离、SQL tenant guard、两层缓存失效 | 公开 record-id 查询的 null 行为 Locator 不完整 |
| Public API | 中等；区分公开契约、权限元数据、插件参数，并诚实标记 partial | 3 个 Gap 有价值，但 Plan 的 `versioned` 描述无证据，且未连接内部 API 边界 |
| Durable queues | 较强；覆盖事务可见性、认领、重试、history 和 shutdown | 独立 review 被停止，尚无最终 verdict |
| Service lifecycle | 中等偏强；启动/关闭阶段和健康轮转清晰 | 漏掉注册失败被记录后吞掉、健康标志不回滚的关键失败语义 |
| Plugin runtime | 中等；能路由 Felix、bundle registry、服务注册和节点通知 | 混淆 system bundle activator 与普通 plugin bundle，漏掉安装失败传播 |

页面正文已经超出“README 摘要”，包含实际不变量、状态迁移和失败路径；这部分有明显
agent onboarding 价值。但最终质量仍不合格：领域召回不完整，7 个叶子页中没有任何
一页获得稳定的最终批准，且最关键的跨仓 architecture/overview 不存在。

## Findings

### P0：dispatch packet 不可重放，worker 会扫描内部状态

首次 Plan worker 只拿到 attempt/artifact 后，使用 `find` 和 `rg --files` 扫描
`.okf-wiki` 来恢复 packet。后续即使 prompt 包含完整 packet，worker 仍执行 50 条直接
状态检查。`task start` 的 stdout 是瞬时数据，attempt 目录没有规范化的 packet 文件；
worker restart 和外部 host 无法通过稳定路径恢复同一 dispatch。

修复：`task start` 必须把完整 packet 持久化到 attempt 目录，并返回 `packet_path`；
增加只读的 `task packet <target>` 重放入口。worker 只消费 packet、明确列出的 inputs
和 Target CLI，不读取 `state.json`、Candidate 目录或其他 attempt。

### P0：`task read` packet 语法不足，造成系统性失败

packet 的 `read_command` 只展示 `<path>`，没有展示 `--start/--end`。Page 和 Review
worker 反复把 `path#Lx-Ly` 整体作为文件名传入，产生 96 次 read 失败，并调用 27 次
`--help` 恢复语法。

修复：packet 给出可直接替换的完整形式：

```text
task read <target> --source <source> --start <line> --end <line> <path>
```

同时明确“Locator 是文档格式，不是 read path”；每个 Source 在 packet 中提供一个
合法 `locator_prefix` 示例。`search_command` 继续显式标记 single literal query。

### P0：Plan-owned 元数据与 Review reopen owner 不一致

Plan 生成了英文 `title/description`，违反 `language: zh`。Page Plan 拥有这些字段，
Page worker 无权修复，State Gate 也会重新采用 Plan 值。首批 reviewer 却把问题标成
`reopen: page`，造成必然循环。直到 service/plugin reviewer 被明确提醒 ownership，
才正确使用 `reopen: plan`。

修复：review reference 增加确定的 owner 表：`type/owner/title/description/tags/scopes/
depends_on/evidence_seeds -> plan`，正文、sources、gaps -> page。Review artifact 的
`target` 与 `reopen` 必须按该表一致；live trace grader 覆盖一次语言错误路由。

### P0：Review 不收敛，Plan 修复的失效范围过大

首批 4 页 review 全部 `changes_requested`，合计 17 项；修订后复审仍产生 7 项。
Subscription 复审重新读取大量源码，单次又消耗 652,566 input tokens。随后一个
Plan-owned 语言问题重开 `plan:workspace`，使已经修订的多个页面回到 pending。

修复：复审 packet 带上“上一轮 issues + 对应 resolution”，默认只验证旧问题和修订
引入的回归；新问题必须说明为何首审无法发现。Plan diff 需要区分：

- 仅 title/description/tags 变化：确定性重建 frontmatter，只重开 review；
- scopes/owner/type/evidence seeds 变化：重开该 page 及依赖；
- depends_on/page set 变化：重算受影响 DAG。

### P1：缺少 Plan 语义审查，遗漏领域没有下游 Target

Plan 能抽取 7 个合理概念，但遗漏 usage/metering，`gaps` 仍为空。Schema gate 只能
验证已有页面，无法判断缺失页面。等 Page review 才发现 Plan 问题已经太晚。

修复：在 Page fan-out 前增加一个独立、低预算的 `review:plan` Target，只审查领域
召回、边界、owner、语言和页面过载，不重新做全仓研究。保留当前三类核心工作，变为：

```text
plan:workspace -> review:plan -> page:* -> review:*
```

Kill Bill fixture 的最小 rubric 已登记到 `evals.json`：catalog plan/phase、
subscription/entitlement、usage、invoice/payment/overdue、public/internal API、queue、
lifecycle 和 plugins。

### P1：bounded 单次输出不等于 bounded Target

Index、单次 search 和单次 read 都有大小上限，但 Target 可以无限累计调用。结果是
2.4 MB 工具输出和 12.5M input tokens。

修复：按 attempt 在 CLI 中计量 navigation calls 与返回 bytes。初始保护线可用本次
数据做保守压缩：Plan 40 calls/128 KiB，Page 30 calls/96 KiB，Review 20 calls/
64 KiB；触顶时 worker 必须收窄 scope、记录 partial Gap 或 fail Target，不能继续
探索。token 由 host 观测，不作为跨 host 的确定性 gate。

不要因此下调 64 KiB 的 per-Source Index 上限。本次四个 Index 总计仅 61,629 bytes，
而 Plan 已消耗近 91.5 万 input tokens；应先控制 Target 总导航。

### P1：多 Source Locator 的首次提交体验差

前三个 Page 首次完成时，全部 evidence 因缺少 `killbill/` 前缀被拒；worker 全局替换
后又破坏 YAML `sources` 缩进，再失败一次。Gate 最终阻止了错误 Candidate，但每页
多付出两轮修复。

修复：packet 提供每个 Source 的 exact locator 示例，并由 worker 使用结构化 YAML
写入而非文本替换。Page template 的多 Source 示例应与当前 packet source 一致。

## 整改顺序和验收

1. 先修 packet 持久化、read 命令形状、locator 示例和 review owner 路由。
2. 再加入 `review:plan` 与复审收敛规则，避免错误 DAG 扇出到昂贵 Page worker。
3. 加 per-attempt 调用/bytes 预算和 trace grader；暂不调整 Index byte budget。
4. 最后实现 metadata-only Plan repair 的细粒度失效。

同一固定 Kill Bill 场景的通过条件：

- Plan rubric 不漏 usage/metering，或明确记录有证据的 Gap；
- 不按 3,845 个文件或 Maven module 建页；
- `#Lx-Ly` read 误用和直接 `.okf-wiki` 扫描均为 0；
- Page 修订最多一轮，复审不重复已解决问题；
- 中文 title/description 在 Page fan-out 前通过 Plan review；
- architecture、overview、index 和 Publication 完整生成；
- 命令数和 tool-output 至少比本次基线下降 50%，同时保持领域 rubric 与引用抽样通过。

## 复现

只搭建固定 workspace：

```text
uv run skills/repo-wiki/evals/setup_java_ws.py /tmp/okf-killbill --scenario killbill
```

执行高成本 live eval：

```text
WIKI_EVAL=1 uv run skills/repo-wiki/evals/run_live_eval.py \
  /tmp/okf-killbill codex --scenario killbill
```

该场景应作为人工或夜间 QA，不应替换默认的 Feign 快速 live fixture。
