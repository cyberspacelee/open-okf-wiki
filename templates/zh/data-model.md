---
id: data-model
type: Data Model
scope: concept
filename: data.md
cardinality: one
required: false
applies_when: Concept 持有持久化数据、耐久 Schema，或影响维护和排障的一致性规则。
purpose: 从最强可用证据解释数据所有权、Schema、生命周期、强制一致性和安全演进。
diagram:
  section: 图
  kinds: [erDiagram, flowchart]
---

## 所有权与 Schema

说明权威所有者、存储、实体、标识符、关系和敏感字段。优先使用 Catalog 或 Schema 定义，不从映射猜测。

## 读写生命周期

追踪创建、读取、更新、删除或保留、事务边界及执行这些动作的代码路径。

## 约束与一致性

记录强制键、校验、并发控制、幂等、一致性模型和可观察违规行为，不假定特定数据库或 ORM。

## 演进

说明有源码依据的迁移、兼容、回填、发布和 Schema 或表示变更验证路径。

## 图

只用源码标识符展示有证据的实体、关系、存储或数据移动。
