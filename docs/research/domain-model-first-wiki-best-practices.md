# Domain/Concept-first Repo Wiki：数据模型证据与完整实现建议

日期：2026-09-01  
范围：面向大型、业务逻辑混乱的代码库；数据库能力只支持 OpenGauss；不考虑历史兼容；本文是实现设计输入，不是运行契约。

## 结论

Repo Wiki 不应在“DB-first”和“code-first”之间二选一。正确的稳定边界是：

```text
Domain / Concept 是知识组织主轴
  ├─ 配置且覆盖该 Concept 的 OpenGauss catalog：物理数据模型的主证据
  └─ 未配置或未覆盖：从迁移、ORM、SQL 和持久化代码恢复逻辑数据模型

代码始终负责：行为、状态变化、所有权、调用链和运行时场景
数据库负责：实际存在的表、列、类型、默认值、约束、索引和注释
```

页面数量不能再由 source 数量或固定配额决定，而应由 Domain、Concept、独立生命周期、数据模型和维护入口决定。对 30--40 万行仓库，少量 umbrella 页面通常意味着 coverage model 缺失，不是“足够精简”。

完整实现应建立三个确定性闭包：

1. **Source coverage**：每个受管源码区域都能定位到一个系统/building block/domain，或有明确排除理由。
2. **Concept coverage**：每个已识别的重要 Concept 都有定义、owner、行为入口和数据模型依据。
3. **Table coverage**：每张已捕获 OpenGauss 表都被归类为领域实体、值/关联、读模型/副本、工作表、基础设施、排除或 unresolved；`unresolved` 阻止发布。

这与 arc42 的两条建议一致：静态 Building Block View 应允许定位所有系统源码，而 Domain Data Model 至少应被文档化；它并不要求每个文件或每张表各写一篇解释性文章。[arc42 Building Block 完整性](https://docs.arc42.org/tips/5-18/)、[arc42 Crosscutting Concepts](https://docs.arc42.org/section-8/)

## 1. 两种运行模式，而不是数据库 provider 抽象

公开能力只支持 OpenGauss，因此实现不需要 `DatabaseProvider`、方言注册表或 PostgreSQL provider。协议/驱动层即使复用 PostgreSQL wire protocol，也不应宣称支持 PostgreSQL。

连接成功后应调用 `opengauss_version()` 做产品握手；无法证明服务端是 OpenGauss 就拒绝 capture。另记录 `working_version_num()`、`gs_deployment()` 和 `current_database()`，以便解释兼容级别与集中式/分布式能力差异。OpenGauss 官方将这些函数定义为服务端版本、兼容版本号、部署模式和当前数据库信息。[OpenGauss system information functions](https://docs.opengauss.org/en/docs/latest/sql_reference/system_information_functions.html)

### 1.1 OpenGauss-backed mode

适用于已配置 OpenGauss 且相关 schema/table 被选中的 Concept：

- catalog 是表、列、类型、nullability、默认值、PK/UK/FK/CHECK、索引、表/列注释和表类型的主证据；
- ORM entity 是数据库结构的 code projection，可补充对象命名、聚合导航和逻辑关系，但不能覆盖 catalog 事实；
- 代码负责识别谁写、谁读、何时改变状态、事务边界和业务条件；
- catalog 找不到的关系只能标记为逻辑推断，不能进入“数据库声明关系”。

OpenGauss 官方说明 `PG_*` 是从 PG 继承的 catalog/view，`GS_*` 是 OpenGauss 新增 catalog/view；因此实现应以 **OpenGauss 当前版本文档和运行时探测**为准，而不是把 PostgreSQL catalog 结构当作产品契约。[OpenGauss system catalog 分类](https://docs.opengauss.org/en/docs/latest-lite/database_reference/querying_a_system_catalog.html)

### 1.2 Code-derived mode

适用于没有配置 OpenGauss，或某个 Concept 不在已选择数据库范围内：

- 优先读取仓库内 migration/DDL，因为它最接近部署意图；
- 再读取 ORM 映射，包括显式映射、默认映射、继承/嵌入、复合键、关联表和外部 XML/config override；
- 再读取 mapper/repository 中的静态 SQL 和 join/update 路径；
- 最后才用字段名、类型名和注释做启发式推断；
- 输出名称必须是“逻辑数据模型”或“代码恢复模型”，不得写成实际数据库 schema。

以 Jakarta Persistence 为例，官方规范说明实体可映射主表和多个 secondary table，基本字段、嵌入对象和不同关联会映射为不同列/关联表；XML mapping 还能覆盖 annotation。因此只扫描 `@Entity` 字段不是完整恢复算法。[Jakarta Persistence Entity](https://jakarta.ee/specifications/persistence/4.0/apidocs/jakarta.persistence/jakarta/persistence/entity)、[Jakarta Persistence 3.2 mapping metadata](https://jakarta.ee/specifications/persistence/3.2/jakarta-persistence-spec-3.2.html)

### 1.3 局部选择，不做 workspace 级降级

数据库模式应按 Concept/table scope 决定：workspace 配置了 OpenGauss，不代表每个 Domain 都被 catalog 覆盖。建议每个持久化 Concept 在 Plan 中固定：

```yaml
model_basis:
  mode: opengauss | code
  resources:
    - catalog:<source>/<schema>/<table>
    - source/<path>#Lx-Ly
  coverage: complete | partial
  gaps: []
```

规则如下：

- OpenGauss 配置/连接/捕获失败：数据库 source 失败，不静默切换为 code-derived。
- catalog 成功但 Concept 不在所选表范围：允许 `mode: code, coverage: partial`，必须留下 coverage gap。
- 同一 Concept 同时存在 catalog 与代码映射：物理事实取 catalog，行为和逻辑导航取代码；冲突进入 review，不自动择一。
- 非持久化 Concept：不要求 data-model page 或表关联。

## 2. 物理模型捕获：OpenGauss 的完整证据面

### 2.1 在一致快照内捕获

一次 catalog capture 应在 `REPEATABLE READ, READ ONLY` 事务内完成。OpenGauss 官方说明 READ COMMITTED 的连续查询可能看到不同快照，而 REPEATABLE READ 在事务内持续读取事务开始时的快照；这对多条 catalog 查询的一致性是必要条件。[OpenGauss transactions](https://docs.opengauss.org/en/docs/latest/sql_reference/managing_transactions.html)

capture 同时记录：

- `opengauss_version()`、`working_version_num()`、`gs_deployment()`、`version()`、`current_database()`；
- source logical id、schema allowlist、capture timestamp；
- extractor contract version；
- 不含凭据的连接身份摘要；
- 规范化 catalog payload 的 SHA-256。

这些都是 OpenGauss 官方系统信息函数。[OpenGauss system information functions](https://docs.opengauss.org/en/docs/latest/sql_reference/system_information_functions.html)

### 2.2 必须捕获的对象

| 对象 | OpenGauss 主来源 | 必须保留的语义 |
|---|---|---|
| schema | `PG_NAMESPACE` | schema OID/name；所有 join 用 OID 或 schema-qualified identity |
| relation | `PG_CLASS` | schema/name、`relkind`、`relpersistence`、partition/storage relevant flags |
| column | `PG_ATTRIBUTE` + `PG_ATTRDEF` | ordinal、name、rendered type、nullability、default/generated expression、dropped flag |
| constraint | `PG_CONSTRAINT` | type、name、validated/informational flags、完整 `conkey`/`confkey` 数组、actions、definition |
| index | `PG_INDEX` + index `PG_CLASS`，可辅以 `PG_INDEXES` | ordered key/include columns、unique/primary/valid/usable、expression、partial predicate、canonical definition |
| comment | `PG_DESCRIPTION` 或 `obj_description`/`col_description` | table 和 column comment，允许为空 |
| view | `PG_CLASS` + `pg_get_viewdef` | 视图种类与规范化 definition |
| dependency | `PG_DEPEND`（按需） | view/sequence/constraint 等数据库对象依赖，不等价于业务关系 |
| partition | `PG_PARTITION` | partition strategy、key、boundary、parent/child identity |
| distribution | `PGXC_CLASS`（分布式部署） | distribution type/key、node group；集群复制不等于业务副本 |

这些字段分别由 OpenGauss 官方 catalog 定义支持：[PG_NAMESPACE](https://docs.opengauss.org/en/docs/latest/database_reference/pg_namespace.html)、[PG_CLASS](https://docs.opengauss.org/en/docs/latest/database_reference/pg_class.html)、[PG_ATTRIBUTE](https://docs.opengauss.org/en/docs/latest/database_reference/pg_attribute.html)、[PG_ATTRDEF](https://docs.opengauss.org/en/docs/3.1.0/docs/Developerguide/pg_attrdef.html)、[PG_CONSTRAINT](https://docs.opengauss.org/en/docs/latest/database_reference/pg_constraint.html)、[PG_INDEX](https://docs.opengauss.org/en/docs/latest/database_reference/pg_index.html)、[PG_INDEXES](https://docs.opengauss.org/en/docs/latest/database_reference/pg_indexes.html)、[PG_DESCRIPTION](https://docs.opengauss.org/en/docs/3.0.0/docs/Developerguide/pg_description.html)、[PG_DEPEND](https://docs.opengauss.org/en/docs/7.0.0-RC3/database_reference/pg_depend.html)、[PG_PARTITION](https://docs.opengauss.org/en/docs/latest/database_reference/pg_partition.html)、[PGXC_CLASS](https://docs.opengauss.org/en/docs/latest/database_reference/pgxc_class.html)。

### 2.3 约束和索引不能扁平化

`PG_CONSTRAINT.conname` 官方明确“不一定唯一”，所以关联条件至少必须使用 constraint OID，或 `(connamespace, conrelid, conname)`；仅按名字 join 会跨 schema/表串联。

`conkey` 与 `confkey` 是有序列号数组。复合 FK 必须保存为一个 constraint：

```json
{
  "kind": "foreign_key",
  "columns": ["tenant_id", "customer_id"],
  "referenced_table": "sales.customer",
  "referenced_columns": ["tenant_id", "id"]
}
```

不能拆成两个单列 FK；拆分会丢失配对和整体基数语义。CHECK 应保存 `pg_get_constraintdef()` 的 server-rendered definition；OpenGauss 明确警告 `consrc` 不会跟随被引用对象重命名而更新。[PG_CONSTRAINT](https://docs.opengauss.org/en/docs/latest/database_reference/pg_constraint.html)

索引也不能只保存名字。`PG_INDEX` 明确区分 unique、primary、valid、usable、expression index 和 partial predicate；这些都影响数据模型和维护入口。[PG_INDEX](https://docs.opengauss.org/en/docs/latest/database_reference/pg_index.html)

OpenGauss 支持普通行存表 FK 和复合 FK，但具体限制受表类型和服务端版本影响，例如官方约束文档指出列存表不支持表级 FK。extractor 应保存服务端真实返回值和状态，不能因某个 schema 没有 FK 就断言“抓取失败”，也不能按 PostgreSQL 的能力矩阵补造关系。[OpenGauss constraints](https://docs.opengauss.org/en/docs/latest-lite/sql_reference/constraints.html)、[OpenGauss ALTER TABLE](https://docs.opengauss.org/en/docs/latest/sql_reference/alter_table.html)

### 2.4 临时表、视图和命名后缀

`*_tmp`、`*_ti`、`*_log` 等只能作为分类 seed，不能直接决定 disposition。物理临时性由 `PG_CLASS.relpersistence` 提供，relation 类型由 `relkind` 提供；业务工作表、导入 staging table 或只读副本仍需结合读写代码和注释判断。[PG_CLASS](https://docs.opengauss.org/en/docs/latest/database_reference/pg_class.html)

同名跨 schema 表也只能先生成 `possible_counterpart` 候选。要声明“副本”“只读”或同步方向，必须再找到同步 SQL、ETL/MQ consumer、写路径缺失加权限证据或明确文档；同名本身不够。`PGXC_CLASS` 的 replication 只描述 OpenGauss 集群分布策略，不能证明两个业务 schema 间存在只读副本关系。[PGXC_CLASS](https://docs.opengauss.org/en/docs/latest/database_reference/pgxc_class.html)

### 2.5 PostgreSQL 文档只作补充

OpenGauss 官方说明部分 information schema/catalog 继承自 PG/PGXC，但 OpenGauss 自己增加了字段和语义，例如 `PG_CONSTRAINT.consoft/conopt`、`PG_INDEX.indisusable`。因此 PostgreSQL 官方文档只能用于解释共同字段，不能决定 OpenGauss 支持矩阵或查询列集合。[OpenGauss Information Schema](https://docs.opengauss.org/en/docs/7.0.0-RC3/sql_reference/information_schema.html)

可用于交叉理解的 PostgreSQL 一手资料包括：[PostgreSQL `pg_constraint`](https://www.postgresql.org/docs/current/catalog-pg-constraint.html)、[PostgreSQL `pg_index`](https://www.postgresql.org/docs/current/catalog-pg-index.html)、[PostgreSQL comment functions](https://www.postgresql.org/docs/current/functions-info.html)。实现测试和运行时探测仍以目标 OpenGauss 版本为准。

## 3. 证据分层与无 FK 关系

### 3.1 四级关系证据

| 等级 | 类型 | 允许的证据 | Wiki 表述 |
|---|---|---|---|
| P1 | `declared` | OpenGauss 有效、启用的 PK/UK/FK/CHECK/index | “数据库声明” |
| P2 | `mapped` | ORM mapping、migration DDL 中的关系；与 catalog 不冲突 | “代码/DDL 映射” |
| P3 | `observed` | 静态 SQL join、repository lookup、写入赋值；至少一个精确 locator | “代码使用表明” |
| P4 | `heuristic` | 命名、类型、注释、同名表等线索 | “候选关系”，不得进正式 ER 边 |

针对 OpenGauss 3.0，只有 `convalidated=true` 且 `consoft=false` 的约束可升级为普通 P1，其余约束保留原始状态并在物理模型中显式标识。[PG_CONSTRAINT](https://docs.opengauss.org/en/docs/3.0.0/docs/Developerguide/pg_constraint.html)

关系冲突时不做静默覆盖：例如 ORM 声明 `ManyToOne`，catalog 无 FK，不代表数据库有 FK；catalog 有复合 FK，而 ORM 只映射一列，则页面应同时陈述物理关系和 code projection gap。

### 3.2 Mermaid 的限制决定了标注方式

Mermaid ER 的实线/虚线表示 identifying/non-identifying，端点表示 cardinality；它们不是“已声明/推断”或“高/低置信度”。[Mermaid ER relationship syntax](https://mermaid.js.org/syntax/entityRelationshipDiagram.html)

因此：

- 不得用实线表示 catalog、虚线表示 inferred；那会篡改 Mermaid 的既定语义。
- 物理 ER 只画 P1 关系，label 加 constraint name 或 `[FK]`。
- P2/P3 关系放在单独“逻辑关系”图或证据表中，label 加 `[ORM]`/`[DDL]`/`[SQL]` 和 locator。
- P4 只进入 gap/candidate 表，不画关系线。
- 证据不足以确定 cardinality 时，不画 ER 边；Mermaid 允许只声明孤立 entity。不要为了语法必填而猜基数。

对已声明 FK，cardinality 也应由事实推导：引用侧是否 optional 取决于 FK 列 nullability 与 match semantics；被引用侧是否最多一个取决于引用列是否有 unique constraint；不能从 Java collection 类型或列名直接投射成物理基数。

## 4. Domain/Concept 覆盖模型

### 4.1 先建 ledger，再决定页面

Planner 的输入应包含确定性 source/build outline、OpenGauss schema summary（如有）以及代码检索工具；输出不是简单 page list，而是 coverage ledger：

```yaml
domains:
  - id: accounting
    name: 核算
    owners: [accounting-service]
    concepts: [accounting-document, accounting-event, accounting-period]

concepts:
  - id: accounting-document
    domain: accounting
    kind: entity
    model_basis: opengauss
    tables: [test.test_accounting_document_t]
    code_seeds: [source/.../AccountingDocument.java]
    behaviors: [create, post, reverse]
    lifecycle: accounting-document-lifecycle
    confidence: confirmed

table_dispositions:
  - table: test.test_accounting_document_tmp
    disposition: working
    domain: accounting
    evidence: [catalog:..., source/...#Lx-Ly]
```

Domain 不是表前缀、目录、service 或 schema 的别名。表前缀、package、owner、共同事务/状态机、读写关系是候选信号；最终 Domain/Concept 边界必须由多类证据共同支持。C4 也明确区分业务 capability/组织 grouping 与 software system/container/component，避免把任意目录结构直接提升为架构层级。[C4 software system](https://c4model.com/abstractions/software-system)、[C4 abstractions](https://c4model.com/abstractions)

### 4.2 发布 gate

完整实现至少执行这些可判定规则：

- 所有非 generated/vendor 的 source cluster 都有 disposition；测试代码附着到被验证的 building block/domain，或标为独立 test-support，不能无声丢弃。
- 所有 catalog relation 都有 table disposition；`unresolved` 数必须为 0。
- 每个重要持久化 Concept 有 `model_basis`、至少一个结构证据和至少一个行为/owner 证据。
- `model_basis=opengauss` 的结构 claim 必须引用 catalog resource；不能只引用 JPA。
- `model_basis=code` 必须引用 migration/ORM/SQL/persistence code，且页面显式标成逻辑模型。
- 每个 Domain 有 overview；拥有多个独立 Concept、生命周期或 failure/change surface 时必须拆 leaf pages，不能全塞 umbrella page。
- overview/parent page 只能综合已完成 child coverage，不能替代 child。
- 每个 page id/path 在 Composition 中显式确定；不允许隐式 prefix stripping。

页面数量是上述闭包的结果，而不是目标。它应随独立知识单元增长，并通过重复/重叠 review 防止机械膨胀。

### 4.3 信息架构

建议导航按读者任务分层，而不是按 artifact pipeline：

```text
system/
  overview.md                 # 系统边界、owner、外部依赖
domains/
  <domain>/
    overview.md               # Domain 词汇、Concept map、入口
    concepts/<concept>.md     # 语义、不变量、owner、行为
    data-model.md             # Concept 与表、物理/逻辑关系
    lifecycles/<name>.md
    procedures/<task>.md
reference/
  opengauss/<schema>/
    overview.md               # table disposition、统计、gap
    tables/<table>.md         # 确定性 reference
architecture/
  context.md
  runtime/<scenario>.md
  observed-patterns.md
glossary.md
```

这并不要求每个目录都有页面；只有 ledger 中存在对应内容才生成。Diátaxis 建议将 reference（准确、完整、少解释的事实）与 explanation/how-to 分开，且 reference 的结构尽量反映被描述对象本身。因此自动表页放 `reference/`，领域解释放 `domains/`，生命周期/维护步骤各自承担单一任务。[Diátaxis quick start](https://diataxis.fr/start-here/)、[Diátaxis map](https://diataxis.fr/map/)

arc42 建议静态 Building Block View 用层级 zoom 表示，Runtime View 只选有架构意义的代表性场景；这支持“完整覆盖地图 + 按价值写深页”，而不是“每文件一页”或“每个系统仅三页”。[arc42 Building Block View](https://docs.arc42.org/section-5/)、[arc42 Runtime View](https://docs.arc42.org/section-6/)

## 5. 自动生成与 LLM 综合的边界

### 5.1 确定性脚本负责

- OpenGauss capture、规范化、分片、hash 和 source identity；
- schema overview 中的对象计数与 disposition 汇总；
- 所有已选 relation 的 Table reference：列、类型、nullability、default、comment、constraints、indexes；工作表/基础设施表仍有 reference，但不提升为 Domain Concept；
- 物理 ER 的 entity/attribute/declared constraint skeleton；
- source/build outline、locator 验证、链接/nav/manifest；
- coverage ledger 的集合闭包与 gate；
- dependency hash、staleness、候选/发布目录和可恢复性。

这些内容是 reference，重复调用 LLM 只会增加成本、遗漏和不可复现性。

### 5.2 Agent/LLM 负责

- 从代码、表注释和读写路径识别 Domain/Concept；
- 判断表 disposition，但必须给证据和 confidence；
- 将物理表映射到业务 Concept，解释 code projection 差异；
- 恢复无数据库时的逻辑模型；
- 提炼状态机、不变量、owner、事务/异步边界和关键运行场景；
- 对 P2/P3 逻辑关系作有标记的综合；
- 拆分足够深入的页面，并消除重复。

### 5.3 Review 分两层

1. **Kernel review**：schema、ID、locator、hash、链接、coverage 闭包、ER 关系等级、禁止 self-link、无 unresolved。
2. **Independent semantic review**：重新打开代表性 catalog/code evidence，检查 Concept 遗漏、umbrella page、物理/逻辑混淆、字段抄录、无证据语义和跨页重复。

C4 官方建议图必须有明确 type、scope、legend，每个 element 有名称/职责，每条关系有方向一致的 label；这些检查可直接进入 diagram reviewer。[C4 diagram checklist](https://c4model.com/diagrams/checklist)、[C4 notation](https://c4model.com/diagrams/notation)

Architecture 页面不能把从代码观察到的模式写成“决策”。arc42 将 decision 定义为基于准则选择 alternative，并要求 rationale；没有 ADR/设计记录时只能写 `observed-patterns`，不能伪造 context、选择理由或 rejected alternatives。[arc42 Architecture Decisions](https://docs.arc42.org/section-9/)

## 6. Provenance 与 staleness

### 6.1 逐资源 provenance

每个页面保存结构化依赖，而不是只在正文留 locator：

```json
{
  "page": "domains/accounting/data-model.md",
  "derived_from": [
    {"kind": "git_blob", "resource": "source/.../Foo.java", "hash": "..."},
    {"kind": "catalog_table", "resource": "catalog:acct/test/foo_t", "hash": "..."},
    {"kind": "page", "resource": "reference/opengauss/test/tables/foo_t.md", "hash": "..."}
  ],
  "generator_contract": "...",
  "template_hash": "..."
}
```

这对应 W3C PROV 的最小模型：source/output 是 Entity，capture/generation 是 Activity，输出通过 `wasDerivedFrom`/`used` 连接输入；不必真的引入 RDF 库，只需保留同等可追溯语义。[W3C PROV-O](https://www.w3.org/TR/prov-o/)

### 6.2 规范化哈希

对每个 catalog table 生成稳定 JSON 后再 SHA-256：

- key 顺序固定、数组按语义排序；column/复合 key 数组保留数据库顺序；
- 排除 capture timestamp、OID 等不稳定且不影响页面语义的值；
- 保留 schema/name/kind/persistence、columns、constraints、indexes、comments、partition/distribution semantics 和 server-rendered expressions；
- table hash 聚合成 schema hash，schema hash 聚合成 catalog source hash；
- page manifest 引用实际使用的 table hash，不能只引用整个 schema hash。

Git 官方 `hash-object` 说明 object ID 由内容计算，可作为 Git source 的内容身份依据。[Git `hash-object`](https://git-scm.com/docs/git-hash-object)

OpenGauss `PG_OBJECT` 的 `mtime/changecsn` 可用于快速判断“可能变化”，但官方说明 initdb 对象不记录、升级前对象的创建信息可能为空，而且 `GRANT/REVOKE` 也会改变 mtime；因此它不能作为页面新鲜度真相。最终仍比较规范化 catalog 内容哈希。[OpenGauss PG_OBJECT](https://docs.opengauss.org/en/docs/latest/database_reference/pg_object.html)

### 6.3 失效规则

页面在任一条件成立时 stale：

- 直接引用的 Git blob 或 catalog table hash 改变；
- Concept/table disposition 或 Domain membership 改变；
- child page hash 改变，且 parent 声明依赖该 child；
- generator contract、模板或 renderer hash 改变；
- source 被删除、重命名或 coverage 从 complete 变 partial；
- OpenGauss capture 的 server major compatibility fingerprint 改变，导致 extractor contract 需重新验证。

仅重写 stale page 及其传递依赖者；但每次 run 仍重新执行全局 coverage gate，防止新增文件/表没有任何旧页面依赖而漏检。

## 7. 验收与评测

不要只检查 Markdown 格式和引用存在性。至少增加一个大型、多服务、混乱代码 + OpenGauss schema 的 live eval，以及一个同仓库无数据库配置的 paired eval。

### 7.1 功能验收

- OpenGauss mode 完成产品握手，并捕获所有选中 relation、列、复合约束、索引、注释、分区和适用的分布语义；全部查询在一次一致快照内完成。
- 无 OpenGauss mode 能从 migration、ORM override、复合键、关联表和 raw SQL 恢复有 provenance 的逻辑模型。
- 同一仓库两种 mode 的 Domain/Concept 主体应大体稳定；物理细节和 confidence 可以不同。
- catalog 与 ORM 冲突被报告，不被覆盖。
- 无 FK 时 P2/P3/P4 标记正确，P4 不进入正式 ER。
- 每张 catalog 表和每个 source cluster disposition 完整，无 unresolved。
- DataModel 不 self-link，所有 selected table 指向确定性 Table reference。
- 修改一个表、一个 ORM mapping、一个 lifecycle branch 后，只使正确页面及 parents stale。

### 7.2 质量指标

建议记录而非硬编码单一“页数”阈值：

- domain recall、important concept recall；
- table disposition coverage、source cluster coverage；
- 持久化 Concept 的 model evidence coverage；
- declared/inferred relation precision；
- 人工发现的 missing lifecycle/owner/change surface；
- umbrella page 数、重复 claim 数、自链接/死链接数；
- 每页 claim 的可复核率；
- stale precision/recall；
- 总 token、耗时和失败恢复成本。

对 30--40 万行真实仓库，验收方应给出独立的 Domain/Concept gold set 或抽样审查集。页数只作为异常信号：结果仍只有每 source 几页时，reviewer 必须证明 coverage ledger 已闭合，而不是以“thin”为理由直接通过。

## 8. 推荐实现顺序（完整目标）

这是依赖顺序，不是删减功能的 MVP：

1. 先修改 ADR、CONTEXT、runtime contract，明确 Domain/Concept-first、两种 model basis、OpenGauss-only 和三类 coverage closure。
2. 一次性完成 OpenGauss capture contract：一致快照、关系/列/default/comment、完整 constraint/index、规范化 hash、server fingerprint 和测试。
3. 扩展 Plan/Composition artifacts：Domain、Concept、model basis、table disposition、source cluster disposition、page DAG 和显式 id/path。
4. 实现确定性 Schema Overview、Table reference、物理 ER skeleton、nav 与 catalog provenance。
5. 实现 code-derived model 调查契约，覆盖 migration、ORM defaults/overrides、SQL 和关系 confidence。
6. 重写 page/composition/review 规则，使 Domain leaf 深度、physical/logical 分离、observed pattern 命名和 parent synthesis 可验证。
7. 实现逐资源 staleness 与传递失效，同时保留每次 run 的全局 coverage gate。
8. 补齐 deterministic e2e、OpenGauss integration fixture、paired live eval、grader 和人工 gold-set 流程。
9. 最后删除旧 Thin Wiki/Grep Test 中与新 contract 冲突的规则和 artifact 字段；不保留双 schema、迁移器或 compatibility branch。

## 9. 不应实现的替代方案

- 不按 source 固定页数；它会把知识边界重新绑回仓库布局。
- 不按表名前缀机械生成 Domain；前缀只是候选信号。
- 不让 LLM 重写完整列清单；Table reference 应确定性生成。
- 不在没有 FK 时把 `*_id` 直接画成物理关系。
- 不用 Mermaid 线型表示 confidence；线型已有 identifying 语义。
- 不因 workspace 有一个 OpenGauss source 就禁止其他 Concept 使用 code-derived mode。
- 不在 OpenGauss capture 失败时静默降级。
- 不增加通用数据库 provider/方言层；当前产品只支持 OpenGauss。
- 不以 `PG_OBJECT.mtime` 或一个 schema 总 hash 代替逐表内容 provenance。
- 不把代码观察伪装成 ADR；没有决策证据就写 observed pattern。

## 来源索引

### OpenGauss

- [System catalogs and views](https://docs.opengauss.org/en/docs/latest-lite/database_reference/querying_a_system_catalog.html)
- [Information Schema](https://docs.opengauss.org/en/docs/7.0.0-RC3/sql_reference/information_schema.html)
- [PG_NAMESPACE](https://docs.opengauss.org/en/docs/latest/database_reference/pg_namespace.html)
- [PG_CLASS](https://docs.opengauss.org/en/docs/latest/database_reference/pg_class.html)
- [PG_ATTRIBUTE](https://docs.opengauss.org/en/docs/latest/database_reference/pg_attribute.html)
- [PG_ATTRDEF](https://docs.opengauss.org/en/docs/3.1.0/docs/Developerguide/pg_attrdef.html)
- [PG_CONSTRAINT](https://docs.opengauss.org/en/docs/latest/database_reference/pg_constraint.html)
- [PG_INDEX](https://docs.opengauss.org/en/docs/latest/database_reference/pg_index.html)
- [PG_INDEXES](https://docs.opengauss.org/en/docs/latest/database_reference/pg_indexes.html)
- [PG_DESCRIPTION](https://docs.opengauss.org/en/docs/3.0.0/docs/Developerguide/pg_description.html)
- [PG_DEPEND](https://docs.opengauss.org/en/docs/7.0.0-RC3/database_reference/pg_depend.html)
- [PG_PARTITION](https://docs.opengauss.org/en/docs/latest/database_reference/pg_partition.html)
- [PGXC_CLASS](https://docs.opengauss.org/en/docs/latest/database_reference/pgxc_class.html)
- [PG_OBJECT](https://docs.opengauss.org/en/docs/latest/database_reference/pg_object.html)
- [Managing Transactions](https://docs.opengauss.org/en/docs/latest/sql_reference/managing_transactions.html)
- [Constraints](https://docs.opengauss.org/en/docs/latest-lite/sql_reference/constraints.html)
- [System Information Functions](https://docs.opengauss.org/en/docs/latest/sql_reference/system_information_functions.html)

### 文档与建模

- [Mermaid ER diagrams](https://mermaid.js.org/syntax/entityRelationshipDiagram.html)
- [Diátaxis](https://diataxis.fr/start-here/)
- [arc42 Building Block View](https://docs.arc42.org/section-5/)
- [arc42 Runtime View](https://docs.arc42.org/section-6/)
- [arc42 Crosscutting Concepts](https://docs.arc42.org/section-8/)
- [arc42 Architecture Decisions](https://docs.arc42.org/section-9/)
- [C4 model abstractions](https://c4model.com/abstractions)
- [C4 diagram checklist](https://c4model.com/diagrams/checklist)
- [W3C PROV-O](https://www.w3.org/TR/prov-o/)
- [Jakarta Persistence specification](https://jakarta.ee/specifications/persistence/3.2/jakarta-persistence-spec-3.2.html)
- [Git hash-object](https://git-scm.com/docs/git-hash-object)
