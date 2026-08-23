---
id: configuration
type: Configuration
scope: repo
filename: config.md
cardinality: one
required: false
applies_when: 配置来源或运行时设置会实质改变行为、依赖、安全性或诊断结果。
purpose: 解释影响行为的配置、优先级、约束和诊断，不罗列无关设置。
---

## 来源与优先级

说明配置来源、加载与覆盖顺序、环境选择、重载行为和密钥注入边界。

## 影响行为的设置

只记录会改变控制流、集成、限制、安全性或常见排障结果的设置，并在有证据时写明默认值。

## 约束与诊断

说明校验、冲突组合、失败信号，以及确认生效值及其来源的最小检查。
