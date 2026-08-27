# Index / Triage / Evidence Cache 最终方案

日期：2026-08-28
状态：已按 greenfield 契约实现；不提供旧 artifact 或 task shape 兼容

详细可行性和 2026 primary-source 依据见
[`index-triage-evidence-pack-2026-assessment.md`](index-triage-evidence-pack-2026-assessment.md)。

## 结论

原方案方向可行，但阻塞开发的根因确实在方案本身：它把“批量执行”建模成
Target，又把可重建的 locator excerpt 建模成 worker 规范产物，破坏了既有的
完成、digest、复用、review reopen 和 publication 假设。

最终方案保留 Index、Triage、evidence-first 下游和独立 Review，删除两项错误
抽象：persisted batch Target 与 worker-authored evidence pack。

## 最终流水线

```text
Pin / Catalog
  -> Source Index（CLI，每 source）
  -> Triage Target（每 source）
  -> exact coverage gate
  -> Survey Target（每 standard/deep scope）
  -> locator gate + derived Evidence Cache
  -> Connect Targets（多 source 才有）
  -> Plan shards -> Compose Gate
  -> Write Target（每 page）
  -> independent Review -> Publish
```

不变量：

1. 一个 Target 只有一个 canonical artifact。
2. inventory 只进入 Coverage Ledger，不产生 Finding 或 Survey。
3. Evidence Cache 由 kernel 从 Pin + locator 派生，可删除、可重建，不进入
   Target identity。
4. Review 不信任生产缓存，始终重新打开 Pin。
5. batch 只允许是同一 worker session 顺序处理相近 Target 的执行优化，不进入
   state、artifact 或 gate。

## Source Index

`run start` 为每个 Git/files Pin 写
`drafts/index/<source>.json`。v1 只保留能服务路由的确定性信号：

- 目录层级的 file / line / byte counts；
- extension distribution 与 test adjacency；
- manifest / entrypoint 候选；
- generated markers；
- 每目录最多三个 representative files；
- schema version、truncated 标记和 64 KiB 硬预算。

不包含 churn、authors、gzip ratio、name homogeneity、tree-sitter 或 embedding。
这些信号没有 eval 证明增益前不进入内核。

## Per-Source Triage

任务和产物是一一对应的：

```text
triage:api   -> drafts/triage/api.json
triage:web   -> drafts/triage/web.json
```

```json
{
  "source": "api",
  "scopes": [
    {
      "paths": ["src/core"],
      "tier": "deep",
      "orientation": "request lifecycle and retry",
      "themes": ["lifecycle", "retry"]
    },
    {
      "paths": ["src/dto"],
      "tier": "inventory",
      "reason": "passive DTO shapes",
      "samples": ["api/src/dto/UserDTO.java#L1-L40"]
    }
  ]
}
```

Gate 保证：

- workspace config 是唯一 exclude 来源；模型不能返回 exclude；
- 每个 eligible file 恰好被一个 scope 覆盖；
- `survey.split` 必须成为独立且未被 exclude 的 scope；
- 普通 inventory 必须有 reason 和至多三个可解析 sample locator；
- 全 generated scope 可免 sample；
- entrypoint、manifest、auth、security、migration、API/public contract 路径不能
  仅凭结构降级为 inventory；
- 不确定时使用 standard。

## Survey 与 Evidence Cache

每个 standard/deep scope 编译为独立 Survey Target。worker 只写 Survey JSON，
gate 校验 finding、locator、range 和 byte budget。通过后 kernel 写：

```text
drafts/evidence/<survey-target>.json
```

缓存包含 schema version、Target、Source、Pin digest、window policy，以及每个
Finding locator 的带行号窗口和 digest。connect/plan/write dispatch 会从已完成
Survey 重建缓存，因此缓存篡改不会污染下游；Survey artifact digest 也不依赖
缓存。

## Plan 与 Write

Plan 继续按 source/workspace 分片，Compose Gate 继续负责全局 Finding 和
Connection 的唯一覆盖、required routing pages、owner 与 portable path。

Compose 后每个 PagePlanEntry 生成一个平铺 spec 的 Write Target：

```text
write:overview.md          -> candidate/overview.md
write:api/architecture.md  -> candidate/api/architecture.md
```

不存在 `task.spec.pages`、batch manifest 或多页面 digest。相近页面可以复用同一
worker session，但每个 packet 仍独立 start、write、complete、retry 和 reopen。

## 评估与上线门槛

确定性测试覆盖：逐 source Index/Triage、exact cover、forced split、inventory
safety、Evidence Cache 物化与篡改重建、一页一 Target、refresh、增量复用、
review reopen、publication/export/rollback。CLI e2e 另外断言 cache 与 write
grain。

Live grader 检查最终输出之外的内部不变量：Index 数量和预算、Triage 数量、
Pin-bound cache、Write Target 与 manifest page 一一映射。成本改进应通过相同
fixture 的 A/B eval 决定；在数据出现前不增加新的索引信号、分类器或持久化
调度模型。
