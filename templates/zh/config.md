---
type: Configuration
scope: repo
optional: true
instructions: >-
  仅当配置文件、配置中心接入或 feature flag 提供源码证据时生成。
  覆盖：配置来源与优先级（application.yml 多 profile、环境变量、Nacos/Apollo 等
  配置中心 key）、影响行为的关键配置项及其默认值、环境差异、feature flag 及其
  生效路径。每项配置引用声明处或读取处的源码；不要罗列全部配置，只写
  改错会出事故或排障时必查的项。密钥类配置只写来源与注入方式，不写值。
  隐式单仓写在 Wiki 根；显式多仓写在 <scopeId>/。
---

# {{title}}

{{description}}

## 配置来源与优先级

## 关键配置项

## 环境差异

## Feature Flag
