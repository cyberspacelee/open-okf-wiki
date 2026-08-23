---
id: architecture
type: Architecture
altitudes: [wiki, repo]
identity: repo
filename: architecture.md
cardinality: one
required: true
purpose: 解释当前层级的结构组成、所有权接口、依赖方向及失败传播。
diagram:
  section: 图
  kinds: [flowchart]
---

## 组成模块

列出源码层模块或外部系统、各自职责及供其他模块使用的公开面。Wiki 层只写跨 Source 组成，仓库层只写该 Source 内部。

## 边界与依赖

说明所有权、允许的依赖方向、信任或进程边界，以及跨边界契约。链接另一层架构页，不重复内容。

## 失败与变更影响

追踪关键失败如何传播，并指出结构变更会影响的模块、契约和验证路径。

## 图

用源码标识符作为 Mermaid 节点，展示模块及其有向依赖。
