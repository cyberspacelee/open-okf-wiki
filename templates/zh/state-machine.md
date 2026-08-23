---
id: state-machine
type: State Machine
scope: concept
filename: states.md
cardinality: one
required: false
applies_when: Concept 存在源码明确或分散实现的生命周期，且状态、转换或守卫对理解行为有意义。
purpose: 让 Concept 的允许、拒绝、终止和重试转换可直接检索。
diagram:
  section: 图
  kinds: [stateDiagram-v2]
---

## 状态

定义每个持久化或行为不同的状态及其含义，并标明初始、中间、终止或可恢复状态。

## 转换与守卫

对每个转换说明事件或调用、源码守卫、状态修改、副作用及守卫拒绝时的行为。

## 终止、失败与重试语义

说明终止行为、非法转换、重试资格、幂等、恢复及超时或过期语义。

## 图

用源码标识符和守卫名称展示状态及带标签的转换。
