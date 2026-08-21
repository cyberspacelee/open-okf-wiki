---
type: API Contract
scope: repo
optional: true
instructions: >-
  仅当本仓对外暴露可调用接口（REST/RPC/GraphQL/OpenAPI）时生成。
  按消费者视角列出接口：路径或方法名、请求/响应要点、鉴权要求、幂等性、错误语义。
  每个接口都要有 Controller/Handler/proto/OpenAPI 的源码证据；不要从调用方猜测。
  接口很多时按资源或能力分组，逐条列出；不要只写"参见代码"。
  「兼容与演进」写版本策略、废弃标记和已知的破坏性变更证据；没有则写明。
  隐式单仓写在 Wiki 根；显式多仓写在 <scopeId>/。
---

# {{title}}

{{description}}

## 鉴权与通用约定

## 接口清单

## 错误语义

## 兼容与演进
