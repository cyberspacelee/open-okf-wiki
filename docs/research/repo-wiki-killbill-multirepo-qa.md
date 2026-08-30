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

该场景是本仓库保留的 Java 企业财经 QA 基线，应作为人工或夜间 QA 运行。

## 2026-08-29 至 2026-08-30：GPT-5.6 Luna 复跑

本轮使用同一组冻结 revision，在全新 workspace 中执行完整 Artifact loop：

```text
WIKI_EVAL=1 uv run skills/repo-wiki/evals/run_live_eval.py \
  /tmp/repo-wiki-killbill-luna-eval.xGBKHo codex \
  --scenario killbill --model gpt-5.6-luna
```

Run `r-20260829T144917742921Z` 在 90 分 40 秒后完成 Publication。
`grade_run.py` 的 13 项检查全部通过，包括 Artifact 集合、Plan/Composition 绑定、
review digest、四个 Source Index、零 validation error、12 个 locator 抽样解析和
Publication 一致性。最终输出 4 个正文页面：

- `architecture/billing-module-boundaries.md`；
- `domains/payment-plugin-contracts.md`；
- `flows/subscription-invoice-flow.md`；
- `lifecycle/startup-event-lifecycle.md`。

### Artifact 和资源观测

| 项目 | 数值 |
|---|---:|
| Run `.okf-wiki` | 228 KiB |
| Exported Wiki | 64 KiB |
| Plan / Composition / Progress | 5,079 / 2,038 / 3,598 bytes |
| 4 个 Evidence notes | 4,888 bytes，30 行 |
| 4 个 Drafts | 20,731 bytes，340 行 |
| 4 个最终正文页面 | 25,738 bytes |
| 4 个 Source Index | 45,509 bytes |
| input / cached input tokens | 33,005,456 / 32,589,824 |
| output / reasoning output tokens | 84,090 / 20,512 |
| JSON trace events | 569 |
| commands / 非零 commands | 184 / 15 |
| command/tool output | 499,249 chars |
| status / evidence search / evidence read | 40 / 18 / 36 |
| reviewer spawn / 有效 review reports | 9 / 8 |
| tool router errors | 13 |

Host 没有给出逐 invocation 的实际 USD cost，因此不按公开单价反推一个虚假精确值。
缓存命中占 input 的 98.74%，但 cached token 仍占上下文长度，不能等同于没有资源成本。

### 语义质量人工 rubric

确定性 grader 只证明流程和结构正确，不能证明企业财经领域召回完整。按本场景原有的
8 项 rubric 重新检查最终 Wiki：

| 领域 | 结果 | 说明 |
|---|---|---|
| catalog plan/phase | 缺失 | 仅提到加载阶段，没有解释 plan/phase 语义 |
| subscription/entitlement | 部分 | 有 subscription 流程，没有 entitlement |
| usage/metering | 缺失 | Plan 和页面均未覆盖 |
| invoice/payment/overdue | 部分 | 有 invoice/payment，没有 overdue |
| public/internal API | 部分 | 有 public/plugin contract，没有 internal API |
| durable queue | 完整 | 覆盖持久事件与重试边界 |
| lifecycle | 完整 | 覆盖启动阶段和事件生命周期 |
| plugins | 完整 | 覆盖支付插件合同和边界 |

即 3/8 完整、3/8 部分、2/8 缺失，而 `plan.md` 没有把这些缺失登记为 gap。
按 0/1/2 的人工诊断 rubric，本轮 evidence correctness 2、domain coverage 0、
navigability 1、onboarding usefulness 1、concision 2、conventions/language 2，合计
8/12。该分数是单次人工诊断，不是经过校准的 human ground truth。

### 轨迹中的问题

1. Review 不收敛。8 份有效报告的 issue 数依次为 7、6、7、5、3、1、1、0；每轮都
   启动全新全局 reviewer，后期仍发现语言问题。另有一次 handoff 丢失导致第 9 个
   reviewer 重复启动。Review 成为 33M input tokens 的主要放大器。
2. 自动 gate 漏掉语义召回。流程 13/13 通过，但 8 个企业领域主题只有 3 个完整；
   当前 grader 没有验证 rubric 覆盖、Plan gap 或 worker fan-out。
3. Worker 轨迹与叙述不一致。trace 中 9 次 `spawn_agent` 全是 reviewer；Evidence 和
   Page 内容由 coordinator 直接生成，却在消息中称已并行分派 worker。
4. Bounded 命令仍可累积成大输出。38 次命令完全相同的 `run status --json`，并直接
   读取 4 个内部 Index；两个宽泛语言扫描单次返回 35,733 和 29,097 chars。
5. 错误恢复有可避免的摩擦。15 个非零命令包含错误 locator/path、错误 CLI 参数、
   workspace 外执行 `git status`，以及两次 `uv` cache/DNS 失败。13 条 router error
   主要来自多个 reviewer 对固定 `review.json` 做 delete/add、patch 上下文过期和空
   agent id。
6. Review Artifact 写入不稳。多个 reviewer 用 `apply_patch` 替换同一个固定文件，
   触发 `multiple operations target review.json`；报告一度不存在。首轮 reviewer 消息
   还报告 8 个 issue，而落盘 JSON 实际为 7 个。
7. Draft repair 先后制造 3 页、再 1 页 citation join 问题，随后靠额外 review 才发现；
   这些适合在 deterministic preflight 中一次拦截。

### 与 2026-08-28 基线比较

| 指标 | 旧运行 | Luna 复跑 | 变化 |
|---|---:|---:|---:|
| Publication | 未完成 | 完成 | 改善 |
| input tokens | 12,515,308 | 33,005,456 | +163.7% |
| output tokens | 173,525 | 84,090 | -51.5% |
| commands | 889 | 184 | -79.3% |
| tool output chars | 2,404,692 | 499,249 | -79.2% |
| 非零 commands | 107 | 15 | -86.0% |

Artifact loop 已显著减少命令、输出和失败，并真正完成发布；但多轮全局 review 把 input
tokens 推高 1.64 倍。因此本轮不能简单判定“更省”，而应判定为 outcome 改善、工具
效率改善、review 上下文成本退化。

### 最小整改项

1. 在 Page fan-out 前用固定领域 rubric 审 Plan；缺项必须建页或写入有证据的 gap。
2. Review 改成一次全局首审加一次定向复审，复审只验证旧问题和修订回归；两轮仍失败
   就保留失败 Artifact，不再无限启动新 reviewer。
3. Publication 前加确定性的 citation join 和可见语言 lint；`review.json` 由单一 owner
   原子写入，避免多个 patch writer 竞争。
4. Trace grader 增加禁止直接读 run internals、预期 worker fan-out、重复 status 和
   tool-output byte budget；宽泛扫描只返回命中位置，不回传大段正文。
5. Harness 预热 `uv` 依赖并提供唯一的运行命令，减少环境探测和无变化重试。

本次只运行 1 个 trial，足以诊断流程，不足以证明稳定性。回归判断至少重复 3 次；
模型或流程比较建议至少 5 次，并报告成功率、语义 rubric、token 和 wall time 的分布。

## 2026-08-30：Artifact loop 加固复跑

在上述 90 分钟运行之后，又用同一冻结场景和 `gpt-5.6-luna` 完成两次全新隔离
workspace 运行。两次 host 都正常退出、完成 Publication 和 `wiki/` export；以下分数
来自当前 19 项 outcome + trace grader，不能与旧版 13 项检查直接比较。

| Run | elapsed | pages / units | input / cached / output | grader |
|---|---:|---:|---:|---:|
| `r-20260829T164910220306Z` | 3,135.601 s | 4 / 8 | 10,423,406 / 10,227,200 / 30,244 | 12/19 |
| `r-20260829T175020903950Z` | 3,670.656 s | 6 / 10 | 15,775,328 / 15,537,664 / 42,726 | 18/19 |

第一轮加固运行的 `.okf-wiki` / export 为 364 / 96 KiB，Plan 8,569 bytes，6 份
evidence note、4 个 draft。它完成了 Plan review 和 bundle review，但仍漏
catalog Plan/Phase、usage metering、invoice/payment/overdue；没有替换初始 Progress，
页面元数据没有全部中文化，writer/reviewer follow-up 也没有稳定复用。该轮的价值是把
“已发布”与“语义召回、语言和轨迹质量”正式拆成独立 gate，不能再用 Publication
成功掩盖质量失败。

第二轮加固运行的 `.okf-wiki` / export 为 412 / 124 KiB，生成 3 份 evidence note、
6 个 draft 和 6 个最终正文页面。最终 Plan 有 10 个语义单元，覆盖平台生命周期、
OSGi/HTTP、公共/内部/插件 API、账户/订阅/entitlement、junction/Beatrix、tenant/
currency、catalog 到 billing events、invoice/payment/overdue、usage 以及持久队列。
Publication generation 为
`50df0a447a9db5af36b8f965188c34bbf64fb2f137c71f17547786cf5c06fb44`，
发布校验为 0 error、0 warning；12 个 locator 抽样全部可解析。

### 第二轮轨迹观测

- 390 个 trace events；16 次 status，命令输出 208,402 chars，2 个非零命令，0 次
  `--help` 探测，0 次并发上限错误。
- 3 个 evidence worker、6 个 page writer、1 个 bundle reviewer；页面修复回送原
  writer，bundle follow-up 回送同一 reviewer。Plan review 因 coordinator 抄错 handle
  误建过 1 个 replacement，正确 handle 随后证明已完成 reviewer 可以重新激活。
- 首次 Plan review 提出 4 项、替代 follow-up 提出 3 项，最终 follow-up 归零。一次
  已批准后的 seed 裁剪改变 Plan digest，造成额外复审；根因是送审前未完成规范化。
- 6 个首次 draft 共触发 6 个 scope/citation gate：3 个缺少继承 Source 的引用，3 个
  locator 超出继承 scope；定向修复后还剩 1 个 Source 引用缺失，再次修复后通过。
- bundle reviewer 首审准确发现 3 项：Composition 把 10 个单元写成 8 个、中文 Mermaid
  state 未使用 ASCII alias、取消态错误直连活动计费事件。一次定向修复后同一 reviewer
  批准，说明 follow-up 已从重复全局发现收敛为问题验证。
- 两个早期参数错误分别来自 runtime 路径抄写和首次 outline 漏 `--source`。后续
  runtime 目录改用短时间戳，status 直接返回 `sources`，不再要求模型重建路径或另跑
  Source discovery。

当前 grader 只剩 `catalog-plan-phase` 失败。`usage-metering` 的初始失败是 grader 把
明确的 `rolled-up` 用量排除在 metering 外造成的假阴性，已修正为接受
meter/rolled-up/计量/聚合；Catalog unit 则确实只写了版本、价格覆盖和 subscription
transition，没有点名公开领域层级中的 Plan/Phase，属于真实召回缺口。

### 已落地的最小调整

1. Plan 在 review 前完成 scope/seed 规范化；任何后续修改都明确使 digest approval
   失效。
2. Plan writer 和独立 Plan reviewer 都检查公开领域层级的主要 levels/types，不能只写
   umbrella domain；这条用于下一轮验证 Catalog Plan/Phase 召回。
3. Composition 每页显式写 `diagrams`，无图时为 `[]`；state diagram 使用 ASCII alias
   和带引号的本地化标签。
4. coordinator 保存并原样复用 dispatch handle；只有正确 follow-up 明确不可用时才
   允许一个 follow-up-only replacement。
5. grader 同时检查 outcome、领域 rubric、Progress、语言、locator、禁读内部脚本、
   worker role/follow-up、status/输出/失败预算，不把它们压成单一模糊质量分。

这一轮是明显改进，但 18/19 仍不是通过，也不能据此声称企业级稳定。下一次全新运行
必须补齐 Catalog Plan/Phase，并继续满足其余 18 项，随后才有两个相邻成功 trial 可用于
初步稳定性判断。

### 两次诊断性止损

`r-20260829T185307807554Z` 在 280.101 秒时由操作者误停。host 起初表示没有 child-agent
工具，但下一步已经成功发现并调用该工具、启动 Plan reviewer；因此这不是模型、skill
或 host 故障，也不计入稳定性成功率。

`r-20260829T185831616138Z` 正常启动 3 个 evidence worker。首版 Plan reviewer 找出
currency、embedded DB、主要 API、内部事件边界、取消/恢复和支付重试等 5 个真实缺口，
但没有发现两个已知语义缺口：Catalog 下的 Product/Plan/Phase 层级，以及 usage 的
capture/rollup/metering 与下游 charging 边界。修订后的 Plan 仍缺这两项，继续启动页面
writer 只会放大成本，因此在 Page fan-out 前主动停止。本次计作诊断失败，不计作完整
trial；它直接促成 Plan writer 与 Plan reviewer 中两条通用领域检查，而不是把隐藏 grader
词表暴露给被测 prompt。

`r-20260829T191750995082Z` 验证了上述两条检查：独立 reviewer 从源码识别并要求补齐
Product/Plan/PlanPhase/PriceList/Usage/Tier/Block 层级、RawUsageRecord 到
recordRolledUpUsage 的 capture/rollup 边界，还补出 subscription scope 和
public/internal/plugin contract；同一 reviewer follow-up 对新 digest 给出 0 issue。Plan
最终有 8 个单元，Composition 合并为 3 页。

该轮随后暴露跨阶段 agent 槽位管理缺陷。4 个已完成的 evidence/review handle 未在页面
扇出前关闭，第三个 writer 首次 dispatch 命中 `agent thread limit reached`。协调器关闭旧
handle 后错误地重派全部 3 页，而不是只补派失败的 1 页，导致前两页各有两个 writer。
`billing-lifecycle.md` 实际从 14,290 bytes 被并发改成 13,929 bytes，另一个 writer 随后
出现 `apply_patch verification failed`。运行在约 25 分钟、bundle review 前主动停止；
这是有效诊断失败，不是完整 trial，重复 writer 生成的 draft 不作为质量样本。

修复保持在 orchestration 层：新 phase/batch 前关闭不再需要 follow-up 的 completed
handle；每次成功 dispatch 立即保存 handle 与固定输出，partial failure 只重试未派发
输出。trace grader 同时把 `agent thread limit reached` 与 `Concurrency limit exceeded`
统一计为并发预算失败，避免此前的字符串漏检。

### 完整复跑：并发恢复后仍缺一个边界关系

`r-20260829T194353860324Z` 使用包含上述并发修复的 runtime 完整运行并发布。耗时
3,686.836 秒；input/cached/output/reasoning tokens 为
19,891,544 / 19,629,312 / 43,373 / 10,338。Plan 10 units，Composition 与最终 export
均为 7 页；`.okf-wiki` 480 KiB，`wiki/` 140 KiB；generation 为
`ca2ddf4151e4d4e21f5874caa10966d8ccf3bde11fc78ba939076a523780dec1`，
published validation 为 0 error、0 warning。

trace 共 427 个 JSON events，12 次成功 spawn（3 evidence、1 Plan reviewer、7 page、
1 bundle reviewer），15 次 status，命令输出 280,848 chars，1 个非零命令、6 个 router
errors、0 个 concurrency errors。页面严格按 3/3/1 批次派发，前一批 writer 关闭后才
启动下一批，未再发生重复 writer 或同一 draft 的跨 writer 竞争。6 个 router errors
主要是单 writer 内的 stale `apply_patch` 上下文，已计入 recovery budget。

三份 evidence note 为 19,834、24,035、12,633 bytes；最大 note 还被重叠读取，说明
Artifact 在磁盘上并不自动保证 coordinator context 小。后续 skill 增加“通常不超过
12 KiB、禁止命令转录、只读一次且超长用不重叠分段”的约束。

Plan reviewer 首审提出 5 项，覆盖 supporting APIs、Product/Plan/PlanPhase、usage
capture/rollup/charging、question/seed 对齐与 subscription recovery。第一次 follow-up
错误复用了旧 `subject_digest`；第二次修复补齐 currency 实现、public contracts、invoice
commit/payment bus、queue recovery 和 shutdown seeds，最终同一 reviewer 批准。该问题
促成 follow-up 协议明确区分 packet 顶层 digest 与嵌套 `previous_review` digest。

7 个初稿的确定性 gate 一次发现 9 个 scope/citation 问题并回送原 writer。bundle
review 的 issue 数为 5、1、0；它纠正了 subscription retry 状态、overdue fan-out、plugin
启动顺序、invoice event bus 边界和 tenant isolation 过度断言。最终 grader 为 18/19，
唯一失败是 `public-internal-api`：Plan 分别写了 public API、plugin boundary，并引用
`DefaultInternalBillingApi`，但没有一个 unit question 或 gap 联合说明 public API、internal
API/events 与 plugin SPI 的关系。这是实际 Plan 语义缺口，不能通过放宽 grader 消除。

下一版 Plan writer/reviewer 因此要求：仓库同时存在三类边界时，必须在同一个 unit
question 或 explicit gap 中联合区分 public API、internal API/events 和 plugin SPI。

### 首次 19/19：关系覆盖与上下文预算同时改善

`r-20260829T204715132735Z` 使用上述关系规则完整运行。耗时 3,387.503 秒；
input/cached/output/reasoning tokens 为
9,890,288 / 9,713,152 / 29,715 / 5,651。Plan 7 units，Composition 与 export 为 6 页；
generation 为
`e860a8cf02db6ed7dbd7c4ac610ac605ea5b218e002458cdf78716627fd626d9`。
发布校验 0 error、0 warning，12 个抽样 locator 全部解析。

三份 evidence note 为 12,207、6,840、12,287 bytes，合计约 31.3 KiB，相比上一完整轮
约 56.5 KiB 下降约 45%；coordinator 每份只读一次。完整 trace 为 286 events、13 次
status、110,260 command-output chars、0 个非零命令、3 个 router errors、0 个并发错误；
成功 spawn 为 3 evidence、1 Plan reviewer、6 page writers 和 1 bundle reviewer，没有
replacement 或重复 page writer。相较上一完整轮，input tokens 下降 50.3%、output tokens
下降 31.5%、trace command-output chars 下降 60.7%。

Plan review issue 数为 8、3、0。它明确要求 Product/Plan/PlanPhase、SubscriptionBundle、
usage rollup 到 charging、REMOVED、invoice retry/payment cancellation、supporting APIs，
并在同一 question/gap 中连接 public API、internal API/events 与 plugin SPI。修订没有把
未证实的 raw usage capture/metering 写成事实，而是保留为 gap。

6 个 draft 的确定性首检只有 3 个局部问题；bundle review issue 数为 6、0，纠正英文
模板标题、重复 change point，以及 API/OSGi、runtime components、subscription blocking、
invoice/payment/overdue 的未证实图边。首次 grader 把对 runtime skill
`assets/templates` 的只读 `rg --files` 误判成直接扫描 Source；grader 修正为只豁免该
skill asset 路径后，同一冻结 trace 为 19/19。没有重跑模型来改变该结果。

这是当前配置的第一个完整成功 trial，证明本次修复有效，但单次成功仍不足以声称稳定；
需至少再有一个相邻 fresh success 才能作初步判断，正式 regression gate 仍建议 3 次。

### Plan review packet 交接失败与止损

`r-20260829T214530207588Z` 使用同一 Kill Bill 场景和 `gpt-5.6-luna` 启动第二个
fresh trial。三份 evidence note 最终为 10,724、12,274、12,229 bytes，coordinator
只合并读取一次；首版 Plan 有 6 个单元，已覆盖 billing lifecycle、usage 汇总到发票、
payment/overdue feedback、public/internal API、plugin SPI 与 durable queue。

运行在独立 Plan review 暴露出协议歧义：`okf review plan --json` 的 stdout 是 packet，
其中 `artifact` 是 reviewer 应写入的报告路径；coordinator 却把该输出路径描述成
"exact packet at .../plan-review.json"。reviewer 因输入文件尚不存在，写出
`changes_requested`；follow-up 又读取同一路径上的旧报告并重复要求“regenerate packet”，
形成确定性循环。该样本运行约 18 分 57 秒、记录 108 个 item events 和 6 个 router
recovery errors，尚未进入 page fan-out 即主动停止，不计完整 trial。

修复只在 orchestration 文档中消歧：Plan 阶段必须执行 status 返回的 `review plan`，
不能替换成后期 bundle 的 `review prepare`；明确 JSON stdout 是输入 packet，
`artifact` 是输出报告而非可读 packet 文件。没有新增 schema、命令或兼容分支。

### Fresh 验证：packet 已修复，follow-up 批次仍越界

`r-20260829T220630141040Z` 从包含 packet 消歧的新 runtime 启动。`review plan` 的完整
JSON stdout 被直接内联给独立 reviewer，`artifact` 只作为报告输出；首审提出 3 项真实
问题（subscription 取消/暂停恢复、usage capture/rollup/charging、public API/internal
events/plugin SPI 联合边界），同一 reviewer follow-up 后按新 digest 批准。此前的
packet/report 自引用循环已消失。

该轮首批 3 个 evidence worker 另暴露角色歧义：worker 把 coordinator 的 child-agent
可用性门禁套在自己身上，将 Run 标成 blocked 且没有取证。coordinator 识别到 host
实际支持 dispatch，resume 后用明确 evidence-worker 角色重派；三份有效 note 为
12,105、12,183、8,520 bytes。主 skill 已明确：仅 coordinator 检查 host dispatch，
被派发 worker/reviewer 不改变 Run 状态。

Plan 8 units，Composition 收敛为 4 页；首批 3 页后再派第 4 页，没有重复 draft。
确定性 draft gate 发现 4 页 citation join 和 3 个 diagram caption 问题，coordinator
正确回送原 writer，却同时激活 4 个 follow-up handle，触发一次真实
`Concurrency limit exceeded`。运行约 37 分 7 秒、211 行 trace、11 次 spawn、3 个
router errors，在 bundle review 前主动停止，不计完整 trial。主 skill 随后明确：首次
dispatch 与 repair/follow-up 共用同一三-agent 上限，必须最多激活 3 个并等待槽位后再发
剩余 handle。

### 完整复跑：调度稳定，仍缺跨单元因果桥

`r-20260829T224449992431Z` 使用 worker 角色与 follow-up 批次修复完整运行并发布。
耗时 3,897.911 秒；input/cached/output/reasoning tokens 为
13,609,951 / 13,388,800 / 33,703 / 6,778。Plan 8 units，Composition 与 export 为
6 页；generation 为
`f83670acdb197b60367940bd766c9291690e42d5d7e5171062ec3b934d145ce9`，
published validation 为 0 error、0 warning。

三份 evidence note 为 10,879、9,334、10,945 bytes。3 个 evidence worker 没有再
误改 Run 状态。Plan reviewer 首次报告 digest 少 1 位，被 kernel 拒绝；同一 reviewer
修正 digest 后提出 7 项语义问题，覆盖 Product/Plan/PlanPhase、usage
capture/rollup/charging、SubscriptionBundle、payment commands、安全与管理面 gap、
public/internal/SPI 关系，修订后批准。

6 个 page writer 按 3+3 批次执行。确定性 gate 的 5 个受影响页面严格按 3+2、随后 1
个二次修复回送原 writer，0 concurrency errors。bundle review issue 数为 5、1、0，
纠正 queue failure 分支、overdue clear-state 重评、invoice event 发布方向、事件 payload
覆盖与管理面 gap。trace 共 357 events、11 次成功 spawn、19 次 status、121,617
command-output chars、1 个非零命令、5 个 router errors、0 个并发错误。

grader 最初把 `APIs` 漏出 `\bapi\b`，修成 `\bapis?\b` 后同一冻结 trace 只剩
`invoice-payment-overdue`：invoice/usage 与 payment/overdue 分属两个 unit，没有一个
question 或 gap 明确 invoice event 触发 payment、失败再反馈 overdue 的因果关系。
这是语义缺口，不放宽评分。Plan 与 Plan reviewer 新增通用检查：因果生命周期跨 unit
时，必须用一个 question 或 explicit gap 写出 handoff 与 feedback，不能用分散 noun
presence 代替关系。

`r-20260829T235312307129Z` 是该通用 causal-bridge 检查的诊断验证。Plan reviewer
首审明确拒绝把 account、entitlement、invoice、payment、overdue 分散出现当作因果链，
要求一个 question/gap 写出 Subscription event 经 invoice/payment、持久通知、Overdue
再反馈 Entitlement 或 invoice 的路径；第一次 follow-up 仍只写在说明正文，reviewer 再次
拒绝，第二次才进入 explicit gap。同时它要求 usage capture/metering/rollup/charging 与
subscription cancellation/failure/retry/recovery。

但同一首审漏掉了另一处已知缺口：Plan 写“公共 API、事件值对象和支付插件 SPI”，
没有显式说明 internal API/events。该表述必然无法通过冻结 rubric，故运行约 12 分钟、
133 行 trace、3 个 router errors 时在 page fan-out 前主动停止。规则进一步收窄为：同一
question/gap 必须显式命名 public API、internal API/events、plugin SPI 三层；泛称 event、
facade 或 extension 不能替代 internal boundary。

### 两次短诊断：dispatch 误判与拆分后因果桥回归

`ws-1788048497` 在约 67 秒内错误结束：coordinator 从文字说明推断 host 不支持
child-agent dispatch，尽管 Codex CLI 已暴露可用的 multi-agent 工具。该样本没有进入
取证，不计完整 trial。skill 已改为直接尝试 host dispatch；只有实际 inventory 缺少
该能力或工具明确返回 unsupported 时才 block，不再另做推测式 pre-check。

`ws-1788048679` 验证了 Plan reviewer 能发现 Product/Plan/PlanPhase、usage
capture/rollup/charging、public/internal/plugin 三层和 cancellation/recovery 等问题，
但修订时把 usage/invoice/payment 与 overdue 拆成不同单元，reviewer 随后批准，导致
原有因果桥在 split 后丢失。该样本在 page fan-out 前止损，不计完整 trial。Plan review
现在要求每次 split/merge 修复后重新检查跨单元因果链；各半段独立有 seed 仍不能替代
一个明确的 handoff/feedback question 或 gap。

### 2026-08-30 fresh 完整运行：冻结 trace 19/19

`r-20260830T002942835462Z` 在全新 workspace 以 `gpt-5.6-luna` 完整运行并发布。
runtime skill digest 为
`76a723a15c69779ec1092533a6be9ecbf0d784a15e80264c68fd3d94c0a5d8aa`，运行前后未变；
耗时 4,052.667 秒。Plan 5 units，Composition、draft 和 export 均为 5 页；generation
为 `be3fb131f072f7524b445252d88bbf445113e6d7bcf7af6cf08a53fe0e805c23`，published
validation 为 0 error，12 个抽样 locator 全部解析。

| 项目 | 数值 |
|---|---:|
| input / cached input tokens | 15,033,353 / 14,804,480 |
| output / reasoning output tokens | 32,028 / 6,192 |
| trace events / status | 374 / 17 |
| command output | 215,631 chars |
| router / concurrency errors | 4 / 0 |
| worker | 3 evidence、1 Plan review、5 page、1 bundle review |
| evidence notes / drafts / exported Wiki | 36,296 / 65,749 / 75,866 bytes |
| `.okf-wiki` / `wiki/` 磁盘占用 | 416 / 128 KiB |

Plan reviewer 首审提出 Bundle 关系和 cancellation/payment recovery 两项问题，原 Plan
writer 修复后同一 reviewer 批准。最终 Plan 在同一个 billing lifecycle question 中明确
公共 API、内部 billing events/event bus 和 plugin SPI，并分别覆盖 Catalog
Product/Plan/PlanPhase、usage raw records/rollup/charging/settlement、invoice/payment/
overdue feedback，以及 platform lifecycle/PersistentBus/NotificationQueue。

5 个 page writer 按 3+2 批次派发，没有重复 writer 或并发上限错误。首次 draft gate
报告 26 个 diagram、citation join 和 scope 问题；定向回送原 writer 后依次降为 19、5、
1、0。bundle reviewer 首审发现 3 个真实问题：重复用量段落、VOID adjustment 引用不符、
invoice lock 被泛化到 payment；原 writer 修复后同一 reviewer 批准。

初次 grader 为 18/19，唯一失败是 matcher 只识别“公开 API”，不识别 Plan 已使用的
“公共 API”；加入中文同义词后对同一冻结 run 重评为 19/19。这里没有修改被测 Artifact，
属于 grader 假阴性修复，不通过放宽关系要求掩盖模型缺口。

本轮仍暴露两项直接浪费。第一，planner 已把三份 evidence notes 综合进已批准 Plan，
Composition 又读取同一批 36,296 bytes；契约现改为只有 fresh composer 才各读一次，
同一 planner/composer 直接使用 Plan。第二，Page/Contract 只写 matching `%% okf-id`，
没有给 validator 要求的冒号形式，4 个 writer 和 coordinator 首次 repair 都写错；文档现
明确唯一形式 `%% okf-id: <diagram-id>`。这两项是冻结 trace 后的提示澄清，已进入本地
确定性/skill 校验，但没有为纯文档消歧再消耗一次完整 live run。

当前有两个独立 fresh 完整 run 可在冻结 grader 下达到 19/19：
`r-20260829T204715132735Z` 与本轮。其间诊断 run 继续发现并修复真实问题，因此可称为
初步 enterprise readiness，不称为正式稳定；正式 regression gate 仍需同 revision、
model、runtime 和 harness 连续至少 3 次 fresh trial，并报告 `pass@1` 与 `pass^3`。

### 5 页通过暴露了错误验收目标

上一完整 run 虽在旧 grader 下达到 19/19，但 5 个正文页分别达到约 8.4--16.9 KiB：
`billing-lifecycle` 同时承担公共/内部/plugin 边界、订阅、发票、支付与恢复；
`account-catalog-subscription` 合并账户、目录层级和订阅模型；platform 页同时覆盖 OSGi、
生命周期、总线、队列、锁和持久化。关键词覆盖成立，但维护者无法按独立 change surface
直接路由，旧 grader 因只检查 Plan 词项而给出假绿。

第三个 fresh workspace `ws-1788054152`、Run `r-20260830T014234058965Z` 因此在 page
fan-out 前停止，不计完整 trial。它还暴露 evidence handoff 竞态：coordinator 把固定文件
出现误当成 worker 已完成，在 worker 仍压缩 note 时读取；API note 随后被重写并短暂缺失，
产生 2 个 stale/invalid `apply_patch` router errors。三份 note 初稿均超过 12 KiB，原 worker
最终压到 12,046、12,201、10,923 bytes。

修复把 “thin” 从“最少页数”改为去库存、去签名清单和去重复背景。Composition 采用
Task Routing Test：一个具体变更或失败问题路由到一页；独立 owner、failure mode 或
change surface 必须拆分，只有拆开会迫使读者重建同一因果链时才合并。能力路径承担信息
架构，`flow/`、`domain/`、`lifecycle/` 等页面类型目录不再自动算有效路由。

在 Page worker 前新增 digest-bound `work/composition-review.json` 和
`okf review composition`。同一 Plan reviewer 检查 Plan、批准的 Plan report 与
Composition，驳回 split/merge/move/routing 问题；Composition 任意修改都会使审批失效。
bundle prepare、candidate validation 和 Publication 都重新验证该 gate。worker 文件存在
不再算 handoff；必须等原 handle 返回、完成 <=12 KiB 修复后，coordinator 才读取一次。

该阶段的 Kill Bill 固定 eval 检查 11 个企业维护意图：account/tenant/currency、
Product/Plan/Phase、subscription/entitlement、usage capture/rollup、invoice
generation/commit、payment retry/recovery、overdue blocking/feedback、
public/internal/plugin、durable event delivery、runtime lifecycle/OSGi、
persistence/locking。当时的诊断 rubric 还要求最终 Composition 至少 8 页、非地图页最多
承担 2 个意图；后续完整实跑证明这两个数量代理会推动机械拆页，现已删除。当前只要求
每个意图有可解释的任务路由、同时出现在对应页的 metadata 和正文，且普通页面不能依赖
纯文档类型目录；页面内聚与拆并由独立 Composition review 判断。

旧 5 页冻结 Publication 作为反例重新评分后按预期失败：缺 Composition approval、页数
仅 5、4 个普通页面使用 `lifecycle/domain/flow/integration` 类型目录，多个运行时与持久化
意图没有独立路由。该反例证明新 grader 能拒绝旧假绿；新 contract 的正向 live run 仍需
重新执行。

### 首次 Task Routing 正向诊断：gate 存在但 Plan 粒度仍失效

`r-20260830T024117301205Z` 使用包含 Composition Review 的新 runtime 和
`gpt-5.6-luna` 启动。三个 evidence worker 都在返回固定路径后才被 coordinator 读取，
notes 为 6,100、9,387、11,548 bytes；文件存在不再被误判为完成，12 KiB 上限也未再
越界。

但 planner 直接把三份 evidence question 综合成 5 个 Plan units。首个 unit 把
account/tenant、Product/Plan/PlanPhase、subscription/entitlement、usage capture/rollup
和 invoice generation 合并成一条生命周期。Plan reviewer 连续三轮发现并修复了目录层级、
source scope、usage 阶段、取消/恢复和 provider failure 等 6 个语义问题，却没有执行
独立 change-surface split；补充更多名词后反而让 umbrella question 更宽。随后
Composition 只能把 5 个已批准 unit 一对一映射成 5 页，无法合法拆分 unit。

该轮在 Composition review 等待期间、page fan-out 之前主动停止，耗时约 16 分钟，不计
完整 trial，也不继续消耗 page writer token。诊断证明仅新增 Composition gate 不足：
路由决策必须先在 Plan unit 粒度成立。修复因此不增加 kernel schema，而是要求 planner 和
Plan reviewer 对每个 compound unit 执行两个具体维护探针；evidence note 数量不得决定
unit 数量。若 Composition reviewer 才发现过宽 unit，流程明确回退修改 Plan、重跑 Plan
review，再重建 Composition。该阶段 grader 曾用至少 8 个 units、单 unit 最多匹配 2 个
企业维护意图来防止关键词覆盖掩盖 umbrella Plan；后续已用独立 Plan/Composition review
替代这些数量代理，避免从防止过度合并摆向过度拆分。

### 第二次 Task Routing 诊断：8 页已形成，Gap 仍可掩盖漏查

`r-20260830T030132267420Z` 使用加入具体维护探针的新 runtime 运行到
Composition review。三个 notes 最终为 7,197、6,598、12,075 bytes；其中 runtime note
在 worker 运行期间曾达到 15,193 bytes，coordinator 没有读取半成品，worker 自行压缩到
上限内并返回后才交接，确认文件存在竞态已修复。

首版 Plan 有 8 units。Plan reviewer 首审按 probe 返回 11 项，其中 8 项要求拆开 catalog/
entitlement/subscription、invoice/junction/usage/payment、public/internal/plugin、transaction/
queue、lifecycle/OSGi、clock/config 等独立 change surfaces；三轮 follow-up 收敛到
3、1、0。批准后的 Plan 有 23 units，Composition 合并成 8 个能力路径页面。
Composition reviewer 另发现 2 个缺少具体因果依据的多 unit merge rationale，说明两个
pre-write gate 都在真实发挥作用。

但 Plan 把 `account/tenant/currency/overdue` 写成“bounded evidence pass 未追踪”的 Gap，
尽管这些模块就在注册的 `killbill` Source 中。Plan reviewer 和 Composition reviewer 都
放行；最终 8 页因此仍不会路由这些企业维护意图。该轮在 page fan-out 前主动停止，不计
完整 trial。修复明确区分 Gap 与 planner 待办：只要注册 Source 暴露相关领域，"not
traced/inspected" 就必须触发 residual evidence worker；只有 revision 缺证据、依赖未注册、
bounded 导航实际失败或存在具体语义不确定性时才能保留 Gap。Kill Bill grader 相应要求
11 个意图必须由 Plan unit 路由，仅允许 invoice/payment/overdue 因果桥显式 gap。

### 2026-08-30 Luna 完整运行：发布成功，但 eval 识别出过度拆页与轨迹浪费

`r-20260830T071122245073Z` 在全新 workspace 使用 Codex CLI 显式指定
`gpt-5.6-luna` 完整运行。runtime skill digest 为
`d6e59b3e0b916b5bf4d379601e64e146db1049348cf6c360a2ca9f0acb3caea1`，运行前后未变；
耗时 9,171.006 秒。Run 最终为 `published`，generation 为
`b27467c5e4065392a515ead692dc647ff685239328c0a63130743eadadc84f56`，发布校验
`complete=true`、0 error、0 warning，12 个抽样 locator 全部解析，26 个正文页已导出。

| 项目 | 数值 |
|---|---:|
| input / cached input tokens | 50,325,993 / 49,875,968 |
| output / reasoning output tokens | 77,752 / 15,629 |
| trace events / status calls | 809 / 25 |
| command output | 283,548 chars |
| router / concurrency errors | 15 / 0 |
| worker | 6 evidence、1 Plan review、26 page、1 bundle review |
| evidence notes / drafts / Candidate Markdown | 53,239 / 188,187 / 212,083 bytes |
| exported Wiki Markdown / disk usage | 217,821 bytes / 312 KiB |

Plan 首审一次返回 8 个问题，follow-up 保留完整 ledger 并最终全部 resolved。修订把初始
13 units 拆成 27，再删除一个重复 umbrella unit，最终为 26。Composition 初稿有 25 页，
审查一次返回 provider/control 边界和页面类型目录两个问题，修订后成为 26 个能力路径页，
但仍基本是一 unit 一页。该结果从上一轮 5 页过度合并摆到本轮 26 页机械拆分；unit 是
coverage obligation，不应成为 page-count 代理。

26 个 writer 的首次确定性 gate 一次返回全部 10 个内容问题，包括 8 个 citation join、
1 个越界 locator 和 1 个 diagram evidence caption。最终 bundle reviewer 首次又一次性
返回 13 个问题，覆盖 overview routing、provider/control 与 usage/recording 边界、表格和
转换引用、extension concept 引用、tenant/currency/overdue change-entry 引用。第一次修复
后 9 resolved、4 open；第二次精确修复后 13 条全部保留并 resolved。一次返回全部问题和
稳定 issue ledger 均按预期工作。

轨迹仍有明显浪费：coordinator 把三个 Plan unit ID 当成 page ID，kernel 一次报告 3 个
missing 与 3 个 unplanned draft 后才改名；writer 按三人整批等待最慢者，没有在空槽返回
时补位；首次 bundle repair 只发送“read current draft and review reference”，没有携带
具体 issue，造成 4 条重复返工；一个 follow-up 又手抄了旧 Candidate digest，虽然 kernel
以 `review-digest-invalid` 拦截，仍多消耗一轮 reviewer。新的运行协议因此要求 literal
`Composition.pages[].id`、滑动三槽、按 `review complete` 完整 open issue 分组并原文交接，
以及 review packet 原样转发、禁止另抄 digest。

15 个 router errors 中，7 个是同一 evidence worker 同时启动过多 search 导致的
`UnknownProcessId`，其余 8 个是基于旧文本的 patch、同一路径多操作或固定 Artifact stale
patch。新协议把 agent fan-out 作为并发边界，单 worker 的 evidence 命令顺序执行；固定
Artifact 单次替换，repair 前重读当前目标。页面 fan-out 本身没有触发并发上限错误。

初始 grader 的领域 matcher 有 4 个失败，其中 account/tenant/currency 被错误要求同 unit、
`retry` 未覆盖 `retries/retried`、JDBC/persistent 未计入持久化、Overview 又被排除在合法
路由之外。修正这些 grader 假阴性后，没有改动冻结 Artifact，结果为 21/23。两个真实
失败保留：Overview metadata 没有联合写出 public API、internal API/events 与 plugin SPI；
payment-overdue metadata 没有写出锁失败语义。另一失败维度是轨迹恢复预算，15 个 router
errors 超限；25 次 status 仅报告，不再用固定次数判失败。

本轮直接促成的 skill 修复还包括：Composition 增加共享 reader entry、evidence
neighborhood 和 maintenance session 的正向合并判据；Overview 只需路由常见任务簇，
不必平铺每个 leaf；删除 Plan/page 的固定数量和每项最多两个 intent 的 grader 代理；
去掉 Kill Bill 专属的 Product/Plan/Phase 与 measurement 文案，保留通用层级和管线规则。
这些修复已通过确定性测试、CLI e2e、ruff 和 Skill Creator 校验，但本次 live run 使用的是
修复前冻结 runtime，因此只能证明失败模式存在，不能证明新提示已稳定消除它们。
