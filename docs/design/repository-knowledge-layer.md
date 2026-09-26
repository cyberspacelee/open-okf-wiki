# Repository Knowledge Layer 设计

Status: accepted. 决策见 [ADR 0027](../adr/0027-repository-knowledge-layer.md)，
证据见 [research](../research/repository-knowledge-layer-evidence.md)。本设计从零开始，
以正确性为准，不兼容旧的 Run、Plan 或 Publication 状态。模块边界、数据结构与 CLI 输出
见 [kernel 契约](repository-knowledge-layer-kernel.md)。**代码层面的细节（字段名、原因类型、
规则代码、输出格式、phase 条件）以 kernel 契约为准**；本文描述意图，两者冲突时按契约实现并修正本文。

本文每个机制都要回答同一个问题：**去掉它，会丢失哪条正确性或哪项 Agent 价值？**
答不出的机制放进 §14 的"延后/拒绝"清单。

---

## 1. 目标与非目标

**目标：** 为代码仓生成一个面向 Coding Agent、同时适合人读的知识层。Agent 用它完成三件事：

1. 按开发任务找到相关页面，读完一页后再回源码核实；
2. 修改代码前拿到仓库的术语、规范、约束和同步修改点；
3. 改完代码后知道哪些知识页面需要更新。

**非目标：**

- 逐类、逐函数、逐字段的 API 文档；
- 目录镜像；
- README 复述；
- 通用"最佳实践"；
- 常驻上下文的长篇说明；
- evidence graph、provenance DAG、置信度评分；
- 全文 embedding 检索。

---

## 2. 设计原则

1. **拉取式，不常驻。** 常驻的只有 AGENTS.md 中不超过 15 行的指针块。其余内容按任务检索。
2. **只写再发现成本高的知识。** Grep Test 适用于所有人写内容：凡是 grep 加读 2–3 个文件
   一分钟内能重建的，一律不写。已有文档只链接，不复述。
3. **优先写 why。** 按下面的优先级取舍，越靠前越优先：
   1. 设计理由
   2. 边界与依赖方向
   3. 不变量与 failure mode
   4. workflow 与生命周期
   5. 术语
   6. 开发规范
   7. 扩展点
   8. 同步修改点与 gotchas
4. **术语和规范是 canon。** 它们在其他页面之前写成、先定稿。所有页面使用同一套词汇，
   由 kernel lint 检查。
5. **引用轻但不能省。** 只用一层 claim → `path#Lx-Ly` footnote，不做 evidence 注册表。
   重要事实必须引用，普通描述不要求。
6. **判断归 Agent，确定性工作归 kernel。** SKILL.md 只写"识别什么、产出什么"。
   状态推导、校验、映射、影响分析、盖章都由 `okf` 完成。每条校验失败都带修复提示。
7. **Git 提供事务和历史。** 知识层与代码一起提交、review、回滚。
   kernel 只负责把每页绑定到它被核实时的 revision。
8. **一个目录就是全部。** skill 只写 wiki 目录（以及用户同意时 AGENTS.md 里的托管指针块）。
   不建运行时目录，不改 `.gitignore`。工作状态就是 draft 页面本身。
9. **OKF 只是持久化格式。** 它约束 frontmatter、footnote 和 index 的形态，不驱动流程。

---

## 3. 正确性不变量

以下是系统必须保证的全部性质。§7 的每条 kernel 规则都对应其中至少一条。

| ID | 不变量 | 由谁保证 |
|---|---|---|
| I1 | 每个 locator 在所属页面的 `revision` 上存在，行号在范围内，且是 git 跟踪的文本文件 | `validate` 通过 `git cat-file` 按 revision 读取 |
| I2 | 必须引用的内容都有 footnote：术语、规范、命令、不变量表的每一行 | `validate` 的表格规则 |
| I3 | 每页的 `sources` 与正文 footnote 一一对应，不多不少 | `stamp` 从 footnote 派生 `sources`，`validate` 做 join 检查 |
| I4 | 带 `verified` 的页面，内容正是被 review 批准的那一版 | review subject digest 加 `stamp.content_sha256`（覆盖正文、除 `status`、`sources`、`verified`、`stamp` 外的全部 frontmatter，以及批准者 `stamp.reviewed_by`，换行统一为 LF）；`verified` 只能是 stamp 写入的批准者条目，加上 `okf verify` 追加的 `human:` 条目；手改过正文、frontmatter 或 `verified` 的 stable 页面会报错 |
| I5 | 页面的 `revision` 之后，只要它 scope 或引用的文件发生变化，该页一定会被报告为 stale | 写作期间：draft 页的 `revision` 必须等于 HEAD 才能 stamp。stamp 之后：`impact` 执行 `git diff revision..HEAD -- scope ∪ cited` |
| I6 | 每个扫描到的模块，要么被某页的 scope 覆盖，要么在 Architecture 的 Not covered 表中写明理由 | `validate` 的覆盖规则 |
| I7 | 其他页面不使用术语表中标为"避免"的别名，除非 reviewer 接受 | `validate` 发出 warning，由 review 裁决 |
| I8 | 知识层中不含 secret | `validate` 做 secret 模式检查；`.env` 类文件不可引用 |
| I9 | 页内链接都能解析，生成的 index 覆盖每一个 stable 页 | `validate` 与 `stamp` |

I5 的关键在于写作期间 HEAD 不能变。draft 页面记录的是写作基线；源码在 draft 期间一旦变化，
就必须先执行 `okf update`，把变化作为待办写进页面，再重新设定基线。因此不存在"写作时依据 A 版代码、
盖章时记录 B 版代码"的漏洞。

不属于不变量、但由 review 负责的质量项：

- claim 是否真的被所引源码支持；
- why 是否是编造的；
- 是否在复读代码；
- 是否遗漏高价值知识。

---

## 4. 目录规划与中间产物

### 4.1 逐项审查

对旧设计和上一稿里的每个产物，都用同一个问题检验：**它保护了哪条不变量，或者承载了哪些不可再生的信息？**

| 产物 | 承载什么 | 能否从别处得到 | 结论 |
|---|---|---|---|
| `.okf-wiki/` 运行时目录 | 下列各项的容器 | — | **删除**。本身没有独立职责，还要求改 `.gitignore` |
| `scan.json` | 仓库事实（模块、命令、CI、术语候选、co-change） | 是。它是 HEAD 的确定性函数，可以随时重算 | **删除**。`okf scan` 只输出到 stdout，需要这些信息的命令内部重算模块列表；scout 自己跑 `scan` |
| scan 记录的 commit | 写作基线 | 能：下沉到每个 draft 页的 `revision` | **下沉到页面** |
| `notes.md` | 发现阶段的候选、进度、跨上下文记忆 | 能：每条候选都有归属页面 | **删除**。候选直接写进对应页面的 todo brief，页面本身就是持久化的工作记忆 |
| `review.json` | 旧设计中是 issue 台账（稳定 ID，跨修复轮次）与批准记录 | 批准与 issue 不能，这是 reviewer 的判断；台账不需要 | **改为 review report** `<wiki>/_review.json`：只保存当前一轮的 verdict 与 issues，没有 ID 和状态，下一轮 reviewer 把它当输入读；stamp 时删除。批准结果沉淀为页面的 `verified` |
| review subject 文件 | 批准对象 | 能：subject 由 draft 页的 hash 和 HEAD 算出 | **删除**。`review prepare` 只输出 digest，stamp 时重算并比较 |
| `repo-wiki.yaml`（放在仓库根） | lang、wiki 位置、exclude、多仓 sources | 部分能 | **移入 wiki 目录**。exclude 改为 Architecture 的 Not covered 表：这既是 I6 的依据，也是 Agent 需要知道的知识（例如"vendored 目录不要改"） |
| `log.md` | 变更历史 | 能：`git log -- <wiki>` | **删除** |
| 每个目录的 `index.md` | 分层导航 | 能：由根 index 按 type 分组即可 | **删除**，只生成根 `index.md` |
| manifest（页面到 blob 输入） | 页面与源码的映射 | 能：`scope`、footnote、`revision` 都在页面 frontmatter | **删除** |
| OpenGauss catalog JSON 缓存 | 表结构证据 | 能：生成的 Table 页就是渲染后的 capture，其 frontmatter 带 hash | **删除**。`db capture` 直接渲染成页面 |
| Run ID、pin worktree、generation 目录、current/previous pointer、export | 事务、冻结、回滚 | 能：git commit 与干净工作树检查 | **删除** |

这样一来，中间产物只剩两种，而且都在 wiki 目录内：

- **draft 页面**：`status: draft`，带 `revision` 基线，正文里的 `<!-- okf:todo … -->` 注释块就是写作简报或待协调变更；
- **`_review.json`**：reviewer 的 review report，只保存当前一轮，stamp 后删除。

### 4.2 放在哪里：为什么不放 `.git/` 或系统缓存

- **不放 `.git/<tool>`。** 有些 agent 沙箱会把 `.git` 设成只读（例如 Codex 的 workspace-write
  模式），reviewer 就写不进去。
- **不放系统缓存目录。** 沙箱常禁止写工作区之外的目录，而且换机器、多人接力时状态会丢失。
- **不放隐藏目录，例如 `.agents/wiki`。** ripgrep 默认跳过隐藏目录，Agent 用 grep 会找不到知识层。

结论：全部放在可见、会被提交的 wiki 目录内。session 中途提交也没关系，因为 `status: draft` 如实标明了状态。

### 4.3 单仓布局

```text
<repo>/
  AGENTS.md                   # 可选：okf pointer 生成的托管指针块（需用户同意）
  docs/wiki/                  # 知识层 = OKF bundle，与代码一起提交；位置在 init 时可选
    repo-wiki.yaml            # 配置：lang（多仓时另有 sources）
    index.md                  # 生成：按 type 分组的路由表 + Source map
    architecture.md           # canon：边界、依赖方向、理由、Not covered 表
    glossary.md               # canon：术语表
    conventions.md            # canon：命令表 + 规则表
    modules/<name>.md
    workflows/<name>.md
    _review.json              # 仅在 review 进行中存在；stamp 时删除
```

- **定位规则。** kernel 在 git 跟踪文件和工作树中查找唯一的 `repo-wiki.yaml`，它所在的目录就是 wiki 根。
  找不到时提示先 `okf init`；有多个时要求用 `--wiki` 指定。只读命令（`status`、`validate`、`impact`）
  可以在仓库任意子目录运行，会向上找到 git 根（hub source 内则是 hub 根）；写入命令仍须在根目录运行。
- **默认位置 `docs/wiki`。** 如果仓库用 mkdocs、docusaurus 这类工具发布 `docs/`，这些页面会被一并发布；
  不希望这样的话，init 时改用例如 `wiki/`。
- **Locator** 相对仓库根目录，例如 `src/billing/run.py#L10-L40`；路径含空格时写成
  `<my app/run.py>#L10-L40`。

### 4.4 多仓（hub）布局

```text
<hub>/                        # 一个独立的 git 仓，只装知识层
  .gitignore                  # 忽略下面的 source 子目录（由 okf init --hub 写入）
  api/                        # source：独立 git 仓（clone 或挂载），不被 hub 跟踪
  worker/
  docs/wiki/
    repo-wiki.yaml            # lang + sources: [api, worker]
    …                         # 与单仓完全相同
```

- **Locator** 相对 hub 根目录，第一段自然就是 source 名，例如 `api/src/…`。
- **Revision** 按 source 记录。
- **clone 和 fetch** 由用户或 Agent 用普通 git 完成。kernel 只检查 source 目录存在、是 git 仓、tracked 文件干净。

### 4.5 配置 `repo-wiki.yaml`

```yaml
lang: en                    # en | zh；正文语言，标识符保持原文
sources: [api, worker]      # 仅 hub；单仓省略
```

配置只有这两项。任何可以放进页面的信息都不放进配置。

---

## 5. 页面格式

### 5.1 Frontmatter 与正文

```markdown
---
type: Module                        # OKF 必填
title: Billing run
description: Read before changing invoice generation, proration or billing retries.
tags: [billing]
scope: [src/billing/**]             # 作者维护：本页负责的源码 glob
status: draft                       # OKF lifecycle：draft 或 stable
revision: {.: 3f2a…}                # kernel 写：draft 页 = 写作基线；stable 页 = 核实时的版本
# stamp 时由 kernel 追加：
# sources: [{id, resource}]         # 从 footnote 派生
# generated: {by, at}
# verified: [{by, at}]
# stamp: {content_sha256: <hex>, reviewed_by: <reviewer actor 或 null>}
#                                  # hash 覆盖正文、除 status/sources/verified/stamp 外的 frontmatter，以及 reviewed_by
---

<!-- okf:todo
Brief: invoices immutable after posting? see src/billing/invoice.py#L40-L58;
retry policy in src/billing/retry.py (Open question: why max 3?)
-->

Invoices are immutable once posted; corrections are new credit items.[^posted]

[^posted]: src/billing/invoice.py#L40-L58
```

规则：

- **`description`** 写成"什么时候该读这一页"。它是检索入口，会原样进入 index。
- **`scope`** 是本页负责的源码范围，用于 impact 和覆盖检查。不同页面的 scope 可以重叠，
  例如某个 workflow 页与其所涉模块页。
- **`revision`** 只由 kernel 写：`okf new` 和 `okf update` 把它设为当前 HEAD，stamp 保留它。
  单仓的 key 是 `.`，hub 模式下的 key 是 source 名。
- **Footnote。** 定义的第一个 token 必须是 locator（含空格的路径用 `<path>#Lx-Ly`），后面可以跟一段不超过
  1 行的说明。
  label 使用语义 slug，这是 OKF 的连接键。
- **页间链接** 用 bundle 绝对路径，例如 `[billing](/modules/billing.md)`，这是 OKF 推荐的形式。
- **`<!-- okf:todo … -->` 是唯一的待办载体。** 它有两种用途：
  - Discover 阶段写入的简报：候选事实、locator、open questions；
  - `okf update` 写入的待协调变更。

  页面里只要还有 todo 块，就不能 stamp。写完后删除。HTML 注释在渲染时不可见。
- **只强制必需章节。** `okf new` 按模板写入必需标题，缺少时 validate 报 `section` error；
  可选章节从 §5.2 的菜单里按需选择，没有内容就省略。

### 5.2 页面类型与章节菜单

| type | 何时建 | 必需结构（en / zh 标题，`section` 规则检查） | 可选章节 |
|---|---|---|---|
| `Architecture` | 恒有，1 页 | Boundaries and dependencies / 边界与依赖方向；Not covered / 未覆盖（Path / Reason 表） | 设计理由；跨模块不变量；变更影响表（改 X → 还要改 / 要检查什么）；已有 ADR 链接 |
| `Glossary` | 恒有，1 页 | 术语表（见 §5.3） | 歧义与上下文边界 |
| `Conventions` | 恒有，1 页 | Commands / 命令（命令表）；Rules / 规则（规则表），见 §5.3 | 扩展方式（新增一个 X 的步骤） |
| `Module` | 有真实边界、不变量或扩展点的模块 | Responsibility and boundaries / 职责与边界 | why；不变量表（不变量 / 强制位置 / 违反后果）；扩展点；failure modes；变更指引；gotchas；相关测试 |
| `Workflow` | 跨模块、Agent 需要调试或扩展的流程 | Trigger to outcome / 从触发到结果 | 顺序约束与不变量；失败与恢复；从哪里改 |

图是推荐项，不是必需项：Architecture 的边界和 Workflow 的触发到结果通常各配一张 mermaid 图。

扩展类型 `Schema` / `Table` 只由数据库扩展生成（见 §7.8），不由作者编写。

**一律不写：** 签名列表、字段清单、目录树、配置文件原样复制、注释复述、
与 README 重复的概览、泛泛的"最佳实践"。

### 5.3 Canon 页的结构

这些表格的列由 kernel 识别，en 和 zh 两种表头都接受。

**Glossary**

| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run | In billing, the scheduled pass that turns due subscriptions into invoices. | invoice job, cycle | `BillingRun`[^billing-run] |

- 只收项目特有的术语：领域词、内部缩写、模块别名、协议名、状态名、配置里的核心概念。
- `Meaning` 用文字写明术语归属的模块或上下文（例如 "In billing, …"）。
- 通用技术词不收，除非它在本仓库里有特殊含义。
- 每行必须有 footnote，指向定义位置（I2）。
- `Avoid` 列填别名，逗号分隔，供 I7 的 lint 使用。

**Conventions / Commands**

| Purpose | Command | Status |
|---|---|---|
| Unit tests | `uv run pytest -q`[^pytest] | verified |

- `Status` 取值为 `verified`（本次实际跑过并成功）、`not-run` 或 `failed`。
- Command 单元格要带 footnote，指向命令的定义位置，例如 Makefile、package.json 或 CI 配置。

**Conventions / Rules**

| Area | Rule | Enforced by |
|---|---|---|
| errors | Service code raises `DomainError` subclasses; HTTP mapping happens only in `api/errors.py` (4 instances).[^err] | convention |

- `Area` 取值：layout、naming、api、errors、logging、config、testing、build-ci、dependencies、vcs
  （提交信息、分支、PR 约定）。同步修改点不是规则，统一写进变更影响表（见下）；扩展知识也不是规则，
  写进 Conventions 的"扩展方式"和 Module 的"扩展点"。
- `Enforced by` 取值：lint、typecheck、test、ci、review、convention。
  它告诉 Agent 违反这条规则时工具会不会报错。
- 证据要求：规则要么来自配置文件，要么至少有两处代码实例（引用其中一处，Rule 单元格里写明实例数）。
- 没有依据的规则不写。

**变更影响（Change impact）**

| Change | Also change or check |
|---|---|
| Add an invoice state | `InvoiceState` transitions and `tests/test_invoice_states.py`[^states] |

- 只有一个归宿：跨模块的写在 Architecture，模块内的写在该模块的 Change guide。
- 每行必须引用证据：scan 的 co-change 对、测试，或把两处耦合起来的代码。

**Architecture / Not covered**

| Path | Reason |
|---|---|
| `third_party/` | Vendored upstream code; never modified here. |

### 5.4 生成物

- **只生成根目录的 `index.md`**（OKF §8 格式，只带 `okf_version` frontmatter），内容包括：
  - 按 type 分组的 `[title](path) - description`，只列 stable 页；
  - **Source map**：扫描到的每个模块 → 覆盖它的页面或 Not covered 理由。Agent 按路径就能找到页面。
- **不生成 `log.md`。** 变更历史用 `git log -- <wiki>`。
- **可选的 AGENTS.md 指针：** 由 `okf pointer` 生成，写入 `<!-- repo-wiki:begin/end -->` 托管块。

---

## 6. 主 SOP：5 个阶段

每个阶段最后都运行 `okf status --json`。status 从 wiki 目录和 git 推导出当前阶段并给出 `next_actions`。
全部工作状态都在 wiki 目录的页面里，所以上下文压缩后可以直接续跑。

**前置条件（全程）：** 源码的 tracked 文件保持干净（wiki 目录除外），HEAD 不动。
如果需要改代码，先提交；status 会指引执行 `okf update` 重新设定基线。

### 阶段 1 — Discover：收集事实，形成简报

1. **`okf init` 已创建三页 canon 桩。** 它们不依赖任何发现结果，从一开始就作为候选的落点。
2. **运行 `okf scan`（stdout）。** 它输出：
   - 模块：来自构建 manifest，例如 workspaces、Maven/Gradle、Cargo、go.mod、pyproject；
     再加上有代码的顶层目录；顶层代码根（`src`、`lib`、`app`、`pkg`、`internal`、`packages`、
     `source`、`cmd`）按子目录拆成模块，除非它有自己的 manifest、下面有声明的模块或有 `main` 子目录
     （`src/main`、`src/test` 仍是一个模块）；顶层测试根（`tests`、`test`、`spec`、`specs`、`__tests__`、
     `e2e`、`testing`）不算模块，既不需要 scope 也不需要 Not covered 行；
     只聚合子模块、自身没有代码的父模块不算模块；
   - 入口点：声明的脚本、JVM `main`、带 `if __name__ == "__main__":` 的 Python 文件、Dockerfile、API spec 等；
   - 语言和文件数；
   - 命令：package.json scripts、Makefile、justfile、Taskfile、tox/nox、各构建工具的惯用命令，以及带 PEP 723
     内联元数据的 Python 脚本（`uv run <path>`，在 source 根目录运行）；每条命令带 `cwd`（相对其 source 根的
     运行目录），`eval_canon.py --run-commands` 用同一规则推导；CI 步骤单独列出，不当作命令；
   - lint、format、type 配置；
   - 测试目录和测试命名模式；
   - 已有文档：README、CONTRIBUTING、CONTEXT、GLOSSARY、ARCHITECTURE、docs、ADR、AGENTS/CLAUDE.md、PR 模板；
     `templates/` 或 `assets/` 目录下的文件是页面骨架，不算文档；
   - 术语候选：文档中加粗的定义、跨文件出现的缩写（在任何地方被赋值的全大写词是常量，不算）、enum 类状态类型
     （附前几个成员）、出现在多个模块的 CamelCase 类型名，每项带首次出现的 locator，各类公平分配，最多 50 个；
     测试文件与 `templates/`、`assets/` 下的 Markdown 不提供候选；
   - co-change 文件对：来自最近 500 个提交，support ≥ 3 且 confidence ≥ 0.6，取前 30。
3. **Agent 在 scan 结果基础上阅读：** README、CONTRIBUTING、构建和 CI 文件、入口点，以及 scan 列出的已有文档。
4. **大仓按区域并行派 2–4 个 scout。**
   - 每个 scout 可以自己运行 `okf scan`，并为本区域的模块或 workflow 执行 `okf new`，把简报写进这些桩页面；
   - canon 候选（术语、规范、命令、全局不变量）通过 handoff 返回；
   - coordinator 收到一个 handoff 就立即合并进 canon 桩的 todo 简报。
5. **6 类发现各有落点：**

   | 类别 | 落点 |
   |---|---|
   | 模块与边界 | architecture 简报与 module 桩 |
   | workflow | workflow 桩 |
   | 术语 | glossary 简报 |
   | 规范与命令 | conventions 简报 |
   | 不变量与风险 | 所属 module 或 workflow 的简报；跨模块的写进 architecture 简报 |
   | open questions | 所在页面的简报 |

**退出条件：** 页面已存在。

### 阶段 2 — Structure：确定页面集合

- **Module 与 Workflow 页只在通过 Grep Test 时保留。** 需要的补建，不值得的删掉。页数由知识边界决定，不设目标。
- **不值得建页的模块** 写进 Architecture 的 Not covered 表，并附理由。
- **每页的 `description` 和 `scope` 在此定稿。**
- **退出条件：** `okf validate` 的覆盖规则（I6）和 scope 规则通过。

### 阶段 3 — Research：先写 canon

- **写作顺序：** Glossary、Conventions、Architecture 在所有其他页面之前写完。
  由 coordinator（或它派出的一个 owner）负责，这三页同一时间只有一个写者。
- **验证每条候选：** 在源码中核实；核实不了的丢掉，不进入知识层。
- **Glossary：** 为每个概念选定 canonical 名称，把其他叫法填进 `Avoid`。
- **Conventions：** 规则按 §5.3 的证据门槛核实；在安全的前提下运行 build、test、lint 命令，
  如实填写 Status。
- **Architecture：**
  - 把边界、依赖方向和设计理由写成正文；
  - 源码或文档里找不到理由的，写"rationale not recorded"，不去推测。
- **退出条件：** 三页没有 todo 块，且 `validate` 没有 error。

### 阶段 4 — Write：并行写其余页面

- **分工：** 每页派一个 writer。writer 的输入只有：本页路径、Glossary、Conventions、Architecture
  （变更影响"只有一个归宿"需要它）、`references/pages.md`。
  简报已经在页面的 todo 块里。
- **调研：** writer 在本页 scope 内直接读源码、做调研，自己写 footnote。
- **写作约束：**
  - 章节从菜单中选择；
  - 使用 canonical 术语；
  - 写完删除 todo 块；
  - 需要新术语时在 handoff 中提出，由 coordinator 合并进 Glossary。
- **Handoff：** 页面路径、新术语提议、仍未解决的 open question 数量。
- **退出条件：** 没有 todo 块，且 `validate` 没有 error。warning 交给 review 裁决。

### 阶段 5 — Review & Stamp：审查，然后盖章

- **`okf review prepare --json`** 只读，输出：
  - `subject_digest`，由每个 draft 页的路径与文件 hash 计算（文件内容含 `revision`，因此源码变化也会让 digest 失效）；
  - draft 页清单；
  - `_review.json` 的路径；
  - 现有 review report 的 `state`，以及上一轮 changes_requested 时的 `previous_issues`（issue 数）。
- **一个没有写过这些页面的独立 reviewer**，按 `references/review.md` 审查。它只读页面、源码和上一轮的
  review report：
  - 抽查 claim 与所引源码是否一致（必须覆盖每一行不变量和规范）；
  - 找出编造的 why；
  - 找出复读内容；
  - 找出遗漏的高价值知识；
  - 裁决术语漂移 warning；
  - 路由测试：从 index 出发，为 3 个模拟开发任务定位页面；
  - 可以用 `git diff -- <wiki>` 查看页面的改动。
- reviewer 写入 review report `_review.json`：

  ```json
  {"subject_digest": "…", "reviewer": "repo-wiki-reviewer/<model>",
   "verdict": "approved|changes_requested",
   "issues": [{"page": "modules/billing.md",
               "kind": "unsupported|invented-why|parrot|missing|terminology|routing|other",
               "claim": "…", "fix": "…", "locator": "optional path#Lx-Ly"}]}
  ```

  文件只保存当前一轮：approved 必须没有 issue，changes_requested 至少一条。issue 没有 ID 和状态，
  不是跨轮台账。
- **修复与复审：** 修复后重新 prepare，**派一个新的 reviewer**（全新上下文），
  它把上一轮的 review report 当作输入，核对旧 issue 是否已修复，只重新列出仍未修复的，再覆盖写入本轮结果。
  最多 3 轮；仍未通过就把剩余 issue 交给用户。依据：同一上下文重复审查的精度反而下降，
  新上下文审查明显更好，且 2–3 轮即可发现大部分可发现的问题
  （见[研究笔记 §8](../research/repository-knowledge-layer-evidence.md)）。
- **`okf stamp --by repo-wiki/<model>`** 的前置条件：
  - `validate` 零 error；
  - 源码干净，且每个 draft 页的 `revision` 等于 HEAD；
  - `_review.json` 的 verdict 为 approved，且 digest 与重算结果一致。

  满足后，stamp 会：
  - 派生 `sources`，写入 `generated`、`verified`、`stamp.content_sha256`；
  - 把 `status` 置为 stable；
  - 重新生成 `index.md`；
  - 删除 `_review.json`；
  - 输出 `warnings`（仍存在的 warning，不阻塞 stamp）和 `verified_by`，供 Agent 转告用户。
- **提交：** stamp 不提交 git。由 Agent 或用户提交，git diff 就是人工 review 的界面。
- **没有独立子 agent 时：** 可以运行 `okf stamp --unreviewed`，这样不写 `verified`。
  按 OKF 的信任分级，这些页面如实标为 unverified，不伪造 review。`_review.json` 的 verdict 为
  changes_requested 时（无论当前还是已过期）拒绝 `--unreviewed`，不能用它绕过未修复的 issue。
- **可选的人工确认：** `okf verify --actor human:<id> <page>`，追加一条 human-reviewed 记录。
- **可选的 AGENTS.md 指针：** `okf pointer` 生成指针块（含标记不超过 15 行），包含：
  - 怎么用知识层：index → 按 description 或 Source map 选页面 → 回被引行核实；
  - glossary 和 conventions 是命名、改代码前的必读页；
  - 改代码前运行 `okf impact --files <paths> --json`；改了某页 scope 内的文件后更新该页或置为 draft；
  - 打印不变量表的 `rg -nU` 模式；
  - Status 为 `verified` 的命令。

  写入 AGENTS.md 需要用户同意（ADR 0004 精神）。hub 模式下指针多一行，请人把它粘贴进每个 source 的
  AGENTS.md；kernel 从不写入 source。

### Update — 增量入口

适用于两种情况：已有 stamped 知识层；或者 draft 期间 HEAD 移动了。

1. **`okf impact --json`（只读）。** 对每个页面，比较 `revision..HEAD` 在 `scope ∪ cited` 上的差异，
   按 §7.5 的原因类型报告：
   - 引用：`cited-moved`（内容未变、只是位置移动，给出建议的新 locator）、`cited-context`、
     `cited-changed`、`cited-deleted`；
   - scope：`scope-added`、`scope-modified`、`scope-deleted`；
   - `revision-missing`、`catalog-changed`、`catalog-deleted`；
   - 新出现的未映射模块，以及已删除的 Not covered 路径。
2. **`okf update`。** 对每个受影响的页面：
   - 置为 `status: draft`；
   - 把 `revision` 设为 HEAD；
   - 在正文开头插入一个 todo 块，每条原因一行，以 ` (since <sha12>)` 结尾（`git diff <sha12> -- <path>`
     即可看到变化），moved 的引用附建议的 locator；`revision-missing` 和 catalog 原因没有该后缀。
   - 目标页面缺失或无法解析时（如 architecture.md 被删），原因不写入任何页，而在输出的 `unplaced` 中列出。
3. **对 draft 页面重跑阶段 3 或 4：** writer 协调完变更后删除 todo 块。
   只有出现未映射模块或删除时，才回到阶段 2。
4. 走阶段 5。review subject 只包含 draft 页面。

开发中的 Agent 还可以运行 `okf impact --files <paths>`。它对每个路径输出
`{read, update, change_impact, canon, note}`：scope 匹配的页面（修改前读）、引用它的页面（改完后更新）、
涉及它的变更影响行 `{page, line, change, also}`、canon 页面，以及说明（hub 路径的解析或歧义、Not covered
理由、`no page covers this path`；路径有歧义时只报歧义）。这个命令只读，任何时候都能用；在子目录或
hub 的 source 目录内也能运行，相对路径从当前目录算起（source 内补上 source 前缀）；写入命令仍指回根目录。

---

## 7. Kernel 规格

### 7.1 命令

| 命令 | 读/写 | 作用 |
|---|---|---|
| `okf init [--wiki DIR] [--lang en\|zh] [--hub --source …]` | 写 | 创建 `<wiki>/repo-wiki.yaml` 和三页 canon 桩；hub 模式下还会在 `.gitignore` 中追加 source 目录。先检查全部前提（仓库或每个 source 已有提交）再写；中途失败则回滚，不留半成品 |
| `okf status --json` | 只读 | 输出 phase、next_actions、counts，以及最多 20 条 issue |
| `okf scan --json` | 只读 | 见 §6 阶段 1，stdout 有界，不落盘 |
| `okf new PATH --type T --description D [--title T] [--scope GLOB…]` | 写页面 | 按 lang 模板创建桩页面（含必需标题）：`status: draft`、`revision: HEAD`，外加空的 todo 块；拒绝匹配不到任何文件的 scope glob |
| `okf validate [--json] [PATH…]` | 只读 | 规则见 §7.3，一次报告全部问题 |
| `okf review prepare --json` | 只读 | 见 §6 阶段 5 |
| `okf stamp [--unreviewed] --by ACTOR` | 写页面和 index | 见 §6 阶段 5，幂等 |
| `okf impact [--files …] --json` | 只读 | 见 Update |
| `okf update --json` | 写页面 | 见 Update |
| `okf verify --actor human:ID PAGE…` | 写页面 | 追加人工 verified |
| `okf pointer [--write AGENTS.md]` | 只读或写托管块 | 生成 AGENTS.md 指针 |
| `okf db capture …`（扩展） | 写页面 | 见 §7.8 |

`--wiki DIR` 在子命令之前或之后都可以。每条 issue 的格式为 `{code, severity, page, line, message, fix}`，
其中 `fix` 是一句可执行的修复提示。

### 7.2 status 推导

按下面的顺序匹配，第一个成立的条件决定当前 phase：

1. 找不到 `repo-wiki.yaml` → `init`
2. 配置错误（`--wiki` 指错而配置在别处时，给出正确的 `--wiki`），或源码 tracked 文件不干净 → `blocked`
   （next action：修正配置，或先提交或 stash 源码改动）
3. canon 页缺失、frontmatter 无法解析或类型不对 → `research`（next action：恢复该页的确切 `okf new` 命令，
   或手工修 frontmatter）。它排在 update 之前：update 把未映射模块等原因记到 architecture.md，
   该页不在时 update 无从落笔。
4. 源码在页面基线之后变了，且 update 能落笔 → `update`（next action：`okf update --json`）。两种情况：
   - 某个 draft 页的 `revision` 与 HEAD 的源码内容不同；
   - 没有 draft 页，且 update 的计划（`_impact.plan`）会把 stale 页面、未映射模块或已删除的 Not covered
     路径写进某页。status 因而不会连续两次给出不产生任何改动的 `update`。
5. canon 简报全空且发现还没产出桩简报 → `discover`：至少有一页 canon，每页现存 canon 都有 todo 块且全为空；
   并且没有 Module/Workflow 页，或其中至少一页只有空 todo 块。next action 为 `okf scan`，有桩时列出
   仍缺简报的桩。任一 canon 页有简报，或每个桩都有简报，即结束发现阶段。
6. 覆盖、scope 或 not-covered 规则失败 → `structure`
7. canon 页有 todo 块或 error → `research`
8. 其他页面有 todo 块或 error → `write`
9. 存在 draft 页面，且 `_review.json` 缺失、无效、过期或为 changes_requested → `review`
   （next actions 同时给出无独立 reviewer 时的 `okf stamp --unreviewed`）
10. 存在 draft 页面，且 review 已批准 → `stamp`
11. 否则 → `done`。next action：index 过期时用 `okf stamp` 重写；wiki 有未提交改动时
    `review and commit the wiki (<n> changed files)`；否则 `nothing to do: the wiki is committed and current`。

`blocked` 之后的每个 phase，status 都列出最多 20 条 issue：本 phase 自己的在前，其余按 error、pending、
warning 排序。`pending` 就是 todo 块：阻塞 stamp，但不让 validate 失败。

**只改 wiki 的提交不算源码变化。** 单仓模式下 wiki 与代码在同一仓库，提交 wiki 会移动 HEAD。
判断基线是否"当前"时，用 `git diff <revision> HEAD -- :(exclude)<wiki>` 是否为空，
而不是比较 commit 是否相等；stamp 时把 `revision` 记为 HEAD。hub 模式下 source 不含 wiki，只比较相等。

### 7.3 validate 规则

| code | 级别 | 规则 | 不变量 |
|---|---|---|---|
| `frontmatter` | error | YAML 可解析且没有重复键；`type`、`title`、`description`、`scope`、`status`、`revision` 齐全 | — |
| `revision` | error | draft 页的 revision 等于 HEAD；stable 页的 revision 在 git 历史中存在 | I5 |
| `locator` | error | 语法合法；在页面 revision 上文件存在；行号在范围内；是文本且被 git 跟踪；不是 `.env` 或密钥类文件 | I1、I8 |
| `footnote-join` | error | 每个引用都有定义，每个定义都被引用；stable 页的 `sources` 与 footnote 一致 | I3 |
| `required-citation` | error | 术语、命令、规则、不变量、变更影响表的每行都有 footnote | I2 |
| `table-values` | error | 命令表的 Status、规则表的 Area 和 Enforced by 取值合法 | I2 |
| `coverage` | error | 每个扫描到的模块，其拥有的文件（嵌套模块的文件归嵌套模块）至少有一个落在某页 scope 内，或模块出现在 Not covered 表中且有 reason | I6 |
| `scope` | error | 每个 glob 至少匹配一个 tracked 文件 | I5 |
| `unreviewed-edit` | error | 标为 stable 的页面，`content_sha256`（正文加受保护的 frontmatter）与 `stamp.content_sha256` 不一致 → 应置为 draft | I4 |
| `section` | error | 缺少该类型的必需标题（§5.2，en 或 zh） | — |
| `link` | error | 页内链接指向存在的页面 | I9 |
| `secret` | error | 命中私钥头、云凭据、高熵 token 等模式 | I8 |
| `mermaid` | error | 支持的图类型、fence 闭合、没有悬空连接 | — |
| `todo` | pending | 页面仍有 `<!-- okf:todo -->` 块；阻塞 stamp，validate 仍以 0 退出 | — |
| `canon-missing` / `canon-table` / `canon-empty` | error / error / warning | 三页 canon 存在，且各自的必需表格存在；表格为空时提示 | I2 |
| `not-covered` | error | Not covered 行的路径匹配不到 tracked 文件，或没有理由 | I6 |
| `index` | error | 没有 draft 页时，`index.md` 与渲染结果不一致 | I9 |
| `alias` | warning | 在代码 span 之外使用了 Glossary 的 `Avoid` 别名 | I7 |
| `uncited-why` | warning | 因果句（because / so that / 为了 / 因为…）没有 footnote | — |
| `parrot` | warning | 表格单元格大多只是代码标识符，却没有解释或引用；或者页面超过 40 KB | — |

### 7.4 stamp 的写入

- 对每个 draft 页：
  - `sources` 取自 footnote（`id` 为 label，`resource` 为 locator）；
  - `generated: {by, at}`；
  - 已批准时追加 `verified: {by: <reviewer actor>, at}`；
  - `stamp: {content_sha256, reviewed_by}`（`reviewed_by` 为批准者，`--unreviewed` 时为 null，计入 hash）；
  - `status: stable`；
  - `revision` 不变（它已经等于 HEAD）。
- 重新生成 `index.md`，删除 `_review.json`。
- 幂等：没有 draft 页时，stamp 不产生任何变化。

### 7.5 impact 算法

对每个页面 P：

1. 取 `F = git diff --name-status -M P.revision..HEAD` 中落在 `scope(P) ∪ cited(P)` 的变化（hub 模式下对每个 source
   分别执行）。diff 不带 pathspec、按 revision 缓存，因为 git 先按 pathspec 过滤再做改名检测，
   被改名移出 scope 的引用文件否则会被误报为删除。
2. 对 F 中每个被引用的文件：
   - 被引行原样留在原位、只是文件其他部分变了 → `cited-context`；
   - 被引范围的内容在新版本中能唯一精确匹配（跟随改名） → `cited-moved`，并给出建议的新 locator；
   - 否则 → `cited-changed` 或 `cited-deleted`。
3. 其余 scope 内的文件报告 `scope-added`、`scope-modified` 或 `scope-deleted`。
4. revision 已不存在（例如 rebase 之后）→ `revision-missing`；链接的 Schema/Table 页重新 capture 后 hash
   变化或被删除 → `catalog-changed` / `catalog-deleted`。

模块层面：扫描到的模块集合与各页 scope 对比，得出未映射的新模块和已删除的 Not covered 路径。

`--files` 模式下，按 scope（`read`）、引用（`update`）和变更影响行（`change_impact`：被引 locator 或
Change 单元格点名该路径）反查页面，不需要 diff，对每个路径输出 `{read, update, change_impact, canon, note}`。

整个算法只用 git 和 frontmatter，不引入任何额外的状态文件。

### 7.6 语言

- `lang` 决定 `okf new` 使用的模板和 index 的分组标题。
- canon 表头的 en/zh 同义词由 kernel 内置。
- 标识符、路径、命令保持原文。

### 7.7 安全

- scan 和 validate 只读取 git 跟踪的文件。
- `.env*` 以及私钥、证书类扩展名的文件永远不能被引用。
- 命令只在 Research 阶段由 Agent 运行，并且只运行 scan 发现的项目自有命令。

### 7.8 扩展：OpenGauss

- **`okf db capture --url-env VAR --schema S --table … [--into reference/<db>]`**
  - 在只读、可重复读的事务中抓取表结构；
  - 直接在 wiki 下渲染 `Schema` / `Table` 页面，frontmatter 带 `catalog_sha256` 和 `generated`；
  - 不保留 JSON 中间文件。
- **作者页面** 用普通链接引用 Table 页，不使用 footnote locator。
- **重新 capture 时：** 如果某张表的 hash 变化，所有链接到该 Table 页的作者页面都会被置为 draft，
  并插入 todo 块（逻辑与 update 相同）。
- 数据库不参与核心不变量 I1–I9 的定义。

---

## 8. Agent 分工

- **Coordinator：** 负责 status 循环、三页 canon、术语合并、Not covered 决策。
- **Scout（Discover，可选，2–4 个）：** 按区域调研，为本区域执行 `okf new` 并写简报；canon 候选通过 handoff 返回。
- **Writer（Write，每页一个，可并行）：** 只写自己的页面。
- **Reviewer（每轮一个新的，独立）：** 只读页面、源码和上一轮的 review report；只写 `_review.json`；
  不改页面，也不运行 stamp。
- **并发上限** 由 host 决定，SKILL.md 不做配额记账。
- **同一文件同一时间只有一个写者。** 这是唯一的并发规则。

---

## 9. SKILL.md

以 [`skills/repo-wiki/SKILL.md`](../../skills/repo-wiki/SKILL.md) 为准，本文不再保留副本，避免两处漂移。

---

## 10. references 与 assets

| 文件 | 内容 | 预计行数 |
|---|---|---|
| `references/discovery.md` | 6 类知识的发现信号、判定标准，以及简报的写法（见下） | ~120 |
| `references/pages.md` | 页面类型、章节菜单、写与不写、footnote 与 locator 规则、canon 表格式、好例和坏例各一 | ~180 |
| `references/review.md` | 审查清单、issue kinds、抽样要求、路由测试、复审规则 | ~80 |
| `references/extensions.md` | 多仓 hub、OpenGauss capture | ~70 |
| `assets/templates/{en,zh}/{architecture,glossary,conventions,module,workflow}.md` | `okf new` 使用的桩模板，用注释列出可选章节 | 每个 ~20 |

`discovery.md` 的核心信号：

- **术语：**
  - 已有的 CONTEXT、GLOSSARY 或术语表文件（最先看）；
  - 文档中的定义句和加粗词；
  - enum、状态常量、状态机的状态名；
  - 消息、协议、事件名；
  - 核心配置键；
  - 作为领域名词的包名和模块名；
  - 跨模块出现的缩写；
  - 描述行为的测试名。
  - 判定：通用技术词只在含义被本仓库特化时才收；同一概念有多个叫法时选定一个 canonical 名。
- **规范：**
  - lint、format、type 配置；
  - CI 步骤；
  - CONTRIBUTING；
  - 提交信息格式（git log）、分支命名、PR 模板 → Area `vcs`；
  - 重复出现的代码模式（≥ 2 处）：错误类型层级、日志封装、配置加载、依赖注入、测试夹具；
  - 目录与命名的一致性；
  - scan 给出的 co-change 对 → 变更影响表，不是规则。
- **不变量与风险：**
  - assert、guard 和校验；
  - 带消息的异常；
  - 事务、锁、幂等键；
  - DB 约束；
  - 状态转移的限制；
  - 测试名中的 must/never；
  - TODO/FIXME/HACK/NOTE 注释；
  - 回滚与重试逻辑。
- **架构与 workflow：**
  - 从入口点顺着调用跨越一次模块边界；
  - import 的方向；
  - 模块的公共面；
  - 后台任务和调度器。

---

## 11. 现有设计的去留

| 现有 | 处理 | 理由 |
|---|---|---|
| `.okf-wiki/` 运行时目录、`workspace.json`、Run ID、Run Policy、生命周期（10 个 phase）、`run start/abandon/block/resume` | **删除** | 工作状态就是 draft 页面；Git 负责事务 |
| Pin worktree、`evidence outline/search/read`、读取预算 | **删除** | 作者直接读工作区（要求干净且 HEAD 等于 draft 的 revision）；validate 按 commit 读 blob 保证 I1 |
| Index 文件、scan 缓存、progress 文件 | **删除** | 都能从 HEAD 重算，或者已由页面简报承载 |
| Plan Intent / Ledger / Narrative、`plan inspect/compile/schema/template`、12 种 record | **删除** | 页面集合与 frontmatter 就是页面地图 |
| Source Area 全量分区、Domain/Concept owner、Model Basis、Table Group、Participant 角色、Evidence Seeds | **删除** | 这些是覆盖闭合，不是价值闭合。改为 I6 的模块级覆盖 |
| Composition、requirements packet、Reference Map、merge probe、Task Routing 双向探针 | **合并**进 Structure | 路由质量由 review 的路由测试和评测负责 |
| Plan review、Composition review、`previous_review` 协议、保留 reviewer handle | **删除** | 只保留一种 bundle review；每轮新 reviewer，读取上一轮的 `_review.json` |
| Page packet、evidence cache、`ev-*` ID、256 KiB / 1 MiB 预算、evidence request 回路 | **删除** | writer 在自己的 scope 内直接调研并写 footnote |
| kernel 代写 footnote 定义 | **反转** | writer 写 footnote，kernel 派生 `sources` 并做 join 检查（I3） |
| Page ID 延迟绑定、`[label][page-id]` | **删除** | 路径在 Structure 阶段确定，使用普通 OKF 链接 |
| 10 种页面类型、`{{replace}}` 必填模板、`%% okf-id`、图下结论必须引用 | **删除/合并** | 改为 5 种作者页面类型、章节菜单、基本的 mermaid 检查 |
| Generation 目录、current/previous pointer、rollback、prune、export、manifest、`log.md`、目录 index | **删除** | Git 负责历史与回滚；映射在页面 frontmatter 中 |
| 子 agent 配额（活跃数、每 run 总数、progress 计数） | **删除** | 由 host 负责；只保留"一个文件一个写者" |
| propose 阶段（AGENTS block、context-draft、ADR 草稿） | **替换** | 术语进入 Glossary 主流程；AGENTS 指针由 `okf pointer` 确定性生成；ADR 草稿删除 |
| Files Source | **延后** | 当前的正确性模型只基于 git 跟踪的文件 |
| OpenGauss capture 与 Schema/Table 生成 | **保留为扩展**，去掉 catalog 缓存 | 线上数据库结构无法靠 grep 重建，但不影响核心契约 |
| Hub workspace、多 source locator | **保留并简化** | hub 自身是一个 git 仓，source 是被忽略的子目录；locator 的第一段就是 source 名 |
| Grep Test | **强化** | 适用于所有作者内容 |
| 独立 review、trust 分级 | **保留并如实表达** | 没有独立 reviewer 时标为 unverified，不阻塞 |

---

## 12. 评测

| 层 | 内容 | 判定方式 |
|---|---|---|
| T0 单测 | locator、footnote、表格解析、各项 validate 规则、status 推导、impact diff、stamp 幂等 | pytest |
| T1 确定性 e2e（`run_cli_e2e.py`） | fixture 仓库跑完 init → new → scan → 写页 → validate → review → stamp；接着改代码（改名、改不变量、移动行、删模块、draft 期间 HEAD 移动），检查 impact、update 与 status 的输出与预期一致 | 脚本断言 |
| T2 路由召回（`eval_routing.py`） | 取知识层提交之后的 N 个真实 commit，把 commit message 当作任务，Agent 只看 index 挑 3 页，检查 commit 触及的文件是否落在这 3 页的 scope 内 | 确定性判分 |
| T2 引用支撑率（`eval_citations.py`） | 抽样 footnote，把 claim 和被引行交给盲评 judge | LLM judge + 人工抽检校准 |
| T2 术语与规范（`eval_canon.py`） | 每个 fixture 有人工整理的术语和规范清单，计算召回；verified 命令实际运行；抽查规则是否有依据 | 半自动 |
| T2 更新召回（`eval_update.py`） | 在 fixture 中植入语义变更，检查它们是否都进入 impact 报告 | 确定性判分 |
| T3 效用 A/B（可选、高成本） | 同一批任务分别在有、无 AGENTS 指针加知识层的条件下运行，比较成功率、token 和耗时 | 任务测试 |

Kill Bill 的 fixture（`evals/setup_java_ws.py`）保留，用作 hub 场景；另加一个中等规模的 Python 或 TS 单仓 fixture。

---

## 13. 实现计划

新 kernel 约 3k 行，旧 kernel 约 11.7k 行。每一步都有独立可测的完成定义。下面每步后标注状态。

1. **文档先行。** — **已完成。**
   - 采纳 ADR 0027，在 ADR 0001–0026 头部标注状态；
   - 按 §15 重写 `CONTEXT.md`；
   - 更新 `AGENTS.md` 的 Layout、Development rules、Verify 三节。
   - 做法：旧 ADR 正文保留为历史，只在头部标注 superseded；旧 Plan 契约文档
     `docs/design/plan-contract.md` 已删除；描述旧 pipeline 的研究笔记在标题下加了历史说明。
2. **基础模块，从旧代码拷贝后裁剪。** — **已完成。**
   - `_files.py`、`_frontmatter.py` 原样保留；
   - `_markdown.py`：补上代码 span 内 footnote 误匹配的修复，以及表格解析和 todo 块识别；
   - `_git.py`：全部 git 调用集中于此，`cat-file --batch`（`BlobReader`，另有流水线化的
     `read_many`）、diff、log、干净检查与 shallow 检测；
   - `_config.py`：定位 wiki 根、处理 hub source（在 source 内运行时指回 hub 根），
     scope glob 编译为正则并按字面前缀二分过滤。
   - 完成定义：T0 中的解析和 git 测试通过（`test_markdown`、`test_git`、`test_config`）。
3. **`_scan.py`。** — **已完成。**
   - 入口点、测试模式和语言表取自旧 `_index.py`；
   - 新增 manifest 模块发现（含 Maven 聚合父模块剔除、单构建仓的根 manifest 归属）、命令和 CI
     抽取（含可复用 workflow）、配置检测、术语候选（enum 类型带成员、各类公平配额、剔除
     license 头词）、co-change（剔除 manifest 版本号联动）；所有代码和文档 blob 只读一遍。
   - 完成定义：在 fixture 与 Kill Bill 四仓 hub、spring-framework（1.1 万文件）上输出稳定，
     stdout 有界（`test_scan`）。
4. **`_page.py`（含 `okf new` 与模板）与 `_validate.py`。** — **已完成。**
   - 实现 §7.3 的全部规则；覆盖按"文件归属最深模块"判定。`Facts` 在一次命令内缓存 HEAD、
     文件清单、模块、glob 匹配、revision 检查与 diff，git 调用次数不随页面数增长。
   - 完成定义：每条规则都有正例和反例测试（`test_page`、`test_validate`）。
5. **`_status.py`、`_review.py`、`_stamp.py`。** — **已完成。**
   - 实现 §7.2 和 §7.4，包括 index（含 Source map）的渲染。
   - 完成定义：T1 前半段通过（`test_lifecycle`、`run_cli_e2e.py`）。
6. **`_impact.py` 与 `okf update`。** — **已完成。**
   - 每个 (source, revision) 只做一次全树 diff，再按 scope 与引用过滤，因此被改名移出 scope 的
     引用文件报告为 `cited-moved` 并给出新路径。
   - 完成定义：T1 后半段（植入变更、HEAD 移动）通过；`eval_update.py` 全部场景召回与精度为 1。
7. **`okf.py` CLI、`okf pointer`、`okf verify`。** — **已完成。**
   - 完成定义：CLI 契约测试通过（`test_lifecycle::test_cli_round_trip`）。
8. **扩展。** — **已完成。**
   - `_db.py` 的抓取部分原样保留；
   - `_dbpages.py` 从旧 `_reference.py` 抽出表格和物理 ER 渲染代码，直接写 Schema/Table 页面。
   - 完成定义：数据库测试迁移后通过（`test_db`、`test_dbpages`）。
9. **Skill 文件。** — **已完成。**
   - SKILL.md（§9）、4 个 reference（discovery、pages、review、extensions）、en/zh 模板；
   - 旧 references、`assets/plan-intent.json` 与旧模板已删除。
10. **评测。** — **进行中。**
    - 重写 `run_cli_e2e.py`（T1）——已完成；
    - T2 由四个独立脚本取代旧的 `grade_run.py` 与 `semantic_eval.py`（二者已删除）：
      - `eval_update.py`：更新召回，植入语义变更后检查 impact/update 报告（确定性判分）；
      - `eval_routing.py`：路由召回，只看 index 为真实 commit 任务选页；
      - `eval_citations.py`：引用支撑率，盲评 judge 抽样与校准；
      - `eval_canon.py`：术语与规范召回，对照人工整理的 gold 文件。
11. **删除旧 kernel 模块与测试。** — **已完成。**
    - `_plan*`、`_state`、`_publish`、`_models`、`_reference`、`_index`、`_workspace` 及其测试
      已删除，不保留兼容层。

---

## 14. 延后或拒绝的方案（防过度设计清单）

| 方案 | 结论 | 理由 |
|---|---|---|
| 运行时目录（`.okf-wiki/`、`.git/<tool>`、系统缓存） | 拒绝 | 见 §4.1–4.2：没有不可再生的内容；沙箱写入受限；ripgrep 默认跳过隐藏目录 |
| 知识图谱 / 依赖图驱动 impact（RepoDoc 方式） | 延后 | scope glob 加 git diff 已经满足 I5，不会漏报；只有当 T2 显示误报成本过高时才考虑 |
| 自动重定位 locator 并跳过 review | 拒绝 | 被引范围之外的上下文可能已变。impact 只给出建议 locator，是否采用由 writer 决定 |
| embedding 检索 | 拒绝 | index、description、Source map 加 grep 已足够；embedding 会引入过期索引问题 |
| 置信度或评分字段 | 拒绝 | OKF 明确只记录信号，不记录评分 |
| 为每页存 excerpt 或 evidence cache | 拒绝 | locator 加 revision 已可复现；reviewer 直接读源码 |
| 多阶段 review（plan / composition / page 各审一次） | 拒绝 | 只审最终页面这一种对象；至多 3 轮修复，每轮换新 reviewer |
| issue 台账（稳定 ID、open/resolved 状态） | 拒绝 | 新 reviewer 每轮重新判定；文件只保存当前一轮 |
| 页面 ID 与路径分离 | 拒绝 | 路径在 Structure 阶段确定；OKF 的 Concept ID 就是路径 |
| 自动写 AGENTS.md 或 CONTEXT.md | 拒绝 | 需要人工同意；证据显示冗余的上下文文件有害 |
| `log.md`、目录 index | 拒绝 | 分别由 git log 和根 index 替代 |
| 按日期判断过期（`stale_after`） | 延后 | git diff 更精确；只有面向离线 consumer 时才补 |
| Files Source、commit message 引用、issue/PR 引用 | 延后 | 当前的正确性模型只基于 git 跟踪的文件 |
| 语言感知的符号解析、LSP | 延后 | scan 只需提供候选；判断由 Agent 做 |

---

## 15. 新词汇（取代现有 CONTEXT.md）

- **Knowledge Layer**：wiki 目录下的 OKF bundle，与代码一起提交；`repo-wiki.yaml` 标出它的根目录。
- **Hub**：只装知识层的 git 仓，多仓 source 作为被忽略的子目录挂在其下。
- **Source**：被扫描的 git 仓。单仓时就是本仓库；hub 时是一个子目录。
- **Page**：一个 OKF concept 文档。type 为 Architecture、Glossary、Conventions、Module、Workflow 之一。
- **Canon**：Glossary、Conventions、Architecture 三页。它们先于其他页面写成，是全局命名和规范的依据。
- **Scope**：页面负责的源码 glob。
- **Locator**：`path#Lx-Ly`，相对仓库或 hub 根目录的路径。
- **Citation**：定义以 locator 开头的 footnote。
- **Revision**：页面的源码基线。draft 页表示写作所依据的版本，stable 页表示核实时的版本。
- **Review report**：`_review.json`，一轮 review 的 verdict 与 issues；下一轮新 reviewer 把它当输入读，issue 没有 ID 和状态。
- **Todo block**：`<!-- okf:todo … -->`，承载简报或待协调的变更；存在时不能 stamp。
- **Draft / Stable**：未经 review 和已盖章的页面状态，沿用 OKF 的 `status`。
- **Stale**：页面 revision 之后，其 scope 或引用的文件发生了变化。
- **Stamp**：kernel 在 review 批准后写入 provenance、trust 和 index 的动作。
- **Grep Test**：一分钟内可以重新发现的内容不写。
