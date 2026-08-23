---
id: domain
type: Domain
scope: domain
identity: domain
filename: domain.md
cardinality: one
required: true
purpose: 集中描述一个 Domain 的跨 Concept 职责、协作规则、不变量和变更影响。
---

## 职责与边界

说明 Domain 负责和不负责什么、公开入口，以及职责在何处移交给其他 Domain 或外部系统。

## Concept 协作

解释有源码证据的 Concept 间调用、数据流、顺序和所有权移交。链接 Concept 页面，不罗列或复述其内容。

## 不变量与约束

只记录由实现强制的规则，不写愿望或调用建议。存在多条规则时使用 `不变量 | 强制位置 | 违规信号 | 验证方式`。

## 变更影响与验证

指出受影响的 Concept、契约、消费者和失败路径，并给出证明变更正确的最小源码依据检查。
