---
id: flow
type: Flow
scope: domain
filename: flow-{slug}.md
cardinality: many
required: false
applies_when: 存在一个有源码依据的独立跨 Concept 运行场景，具有明确触发、结果和值得单独检索的有序路径。
purpose: 解释一个端到端运行场景，包括分支、失败、副作用和可观察结果。
diagram:
  section: 图
  kinds: [sequenceDiagram, flowchart]
---

## 触发与结果

说明发起事件或调用、必要前置条件、预期结果和外部可观察的完成信号。

## 参与者与主路径

用源码标识符命名参与者，按顺序追踪成功路径上的调用、状态变化、数据移动和所有权移交。

## 分支、失败与副作用

覆盖关键分支、部分失败、重试或补偿、持久化或外部副作用，以及每种行为的强制位置。

## 验证

给出能区分成功与各类关键失败的聚焦测试、命令、日志、指标或状态观测。

## 图

用源码标识符和明确的分支或失败边展示有序场景。
