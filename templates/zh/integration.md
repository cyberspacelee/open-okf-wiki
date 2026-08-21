---
type: Integration
scope: domain
optional: true
diagram: flowchart
instructions: >-
  仅当这个 Domain 有异步或跨系统集成的源码证据时生成：MQ 生产/消费
  （topic、consumer group、重试与死信）、定时任务（调度器、cron、幂等性）、
  外部系统调用（客户端、超时与降级）、事件契约（payload 结构与版本）。
  这是清单性知识：flows.md 讲一个场景怎么流动，本页讲这个 Domain
  生产和消费哪些集成点。每个集成点引用声明处源码；图画集成拓扑
  （本 Domain 与 topic/任务/外部系统的连接），节点用源码标识符。
---

# {{title}}

{{description}}

## 消息生产与消费

## 定时任务

## 外部调用

## 事件契约

## 图

```mermaid
flowchart TD
  {{diagram}}
```
