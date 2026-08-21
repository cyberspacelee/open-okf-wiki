---
type: Data Model
scope: concept
diagram:
  - erDiagram
  - flowchart
optional: true
instructions: >-
  仅当 Concept 持有持久化数据时生成。Schema 与 ER 图的证据优先级：
  优先用 Catalog 工具（db_tables / db_describe）取真实表定义；未配置 Catalog 时
  用迁移脚本（Flyway/Liquibase 的 db/migration、schema.sql）；最后才从
  ORM 注解 / mapper XML 逆向。ER 图的实体、列、外键须与所选证据一致，不要虚构。
  「事务与锁」写事务边界（如 @Transactional 的传播与回滚）、乐观/悲观锁、
  分布式事务或 outbox；源码无此类证据时写明"无显式事务控制"并引用读写入口。
  所有权、读写路径、一致性、迁移和敏感数据处理都要有证据支撑。
---

# {{title}}

{{description}}

## 所有权与 Schema

## 读写路径

## 事务与锁

## 约束与一致性

## 迁移与敏感数据

## 图

```mermaid
erDiagram
  {{diagram}}
```
