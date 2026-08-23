---
id: integration
type: Integration
scope: domain
filename: integration.md
cardinality: one
required: false
applies_when: Domain 生产或消费异步工作，或跨越进程、仓库、供应商或部署边界。
purpose: 盘点 Domain 的集成点以及约束它们的契约、交付行为和恢复语义。
diagram:
  section: 图
  kinds: [flowchart]
---

## 集成点

盘点生产或消费的调用、事件、任务、文件、生成物或共享 Schema，并说明方向、所有者和声明位置。

## 契约与交付

按适用情况说明载荷或调用契约、版本、顺序、交付保证、幂等、调度、超时和兼容性。

## 失败与恢复

说明每个关键集成的可观察失败、重试、死信、降级、补偿、重放及运维或开发验证方式。

## 图

用有向边和源码标识符展示 Domain 及其集成端点。
