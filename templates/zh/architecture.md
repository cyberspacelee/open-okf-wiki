---
type: Architecture
altitudes: [wiki, repo]
diagram: flowchart
optional: false
instructions: >-
  Wiki 根页只写系统如何由各 Git Source 与外部系统组成：容器边界、依赖、失败域。
  隐式单仓时同一页继续写本仓内部容器。
  repos/<scopeId>/ 页只写该仓内部结构，链到 /architecture.md，不重复跨仓系统地图。
  「组件」节每个节点必须是源码标识符、一句话职责、入边和出边。
---

# {{title}}

{{description}}

## 组件

## 边界与依赖

## 扩展点与失败模式

## 图

```mermaid
flowchart TD
  {{diagram}}
```
