# Wiki 生成优化方案：Agent Swarm 经济学 × Pi × OKF

**Date:** 2026-07-23  
**Status:** research synthesis (not an ADR)  
**Sources:** Cursor [Agent Swarms & Model Economics](https://cursor.com/blog/agent-swarm-model-economics) (zh-Hant: [同文](https://cursor.com/zh-Hant/blog/agent-swarm-model-economics)); Google OKF SPEC (`refs/knowledge-catalog/okf/SPEC.md`); local ADRs 0010/0014/0028/0030; live code under `packages/agent`, `packages/core`, `packages/skill`.

---

## 1. 问题诊断（为何「功能不正常」）

基础设施（freeze / run workdir / Pi session / shell gates / mechanical validate / atomic publish / fixture smoke）大体可用。**语义生成层（Layer B Produce）仍是薄 Host 脚本**，与 Skill / ADR 契约严重脱节。

### 1.1 P0 — 直接导致 live 跑不通或结果不可用

| # | 现象 | 证据 |
|---|------|------|
| 1 | Live root_write **用户 prompt 是 stub**：只要求写 `wiki/index.md` 一页 | `produce/live-pi.ts` `defaultLivePrompt` |
| 2 | System prompt 提 Spec/`overview.md`，但 **未覆盖 user prompt** | `produce/orchestrate.ts` 调 `produceWithPi` 只传 `systemPrompt` |
| 3 | 默认 Spec 关键页是 `overview.md`，live 却偏向 `index.md` → hard-validate 易 `missing critical page` | `contract/run.ts` vs live prompt |
| 4 | **无 repair loop**（`maxRepairRounds` 存在，`repairRounds` 永不递增） | `orchestrate.ts` |
| 5 | Reviewer 异常 **fail-open**（当 clean 处理） | `orchestrate.ts` catch → `clean: true` |
| 6 | CLI live **无 `resolveModel`** → 硬失败 | `cli/main.ts` + `wiki-run.ts` |

### 1.2 P1 — 架构承诺未兑现

| # | 承诺 | 现实 |
|---|------|------|
| 1 | Domain → Leaf 监督树 | 仅 Domain fan-out；`leafStarts` 恒 0 |
| 2 | Analysis Receipt + 归约 | Domain 摘要丢弃，不进 root_write |
| 3 | Living Spec / LLM plan | 永远 `defaultWikiRunSpec`（一域一页） |
| 4 | Effective Source Ignores | freeze 有 map，Pi tools **未注入** |
| 5 | `roleModels` 混合经济学 | 适配器几乎全走 `writer` |
| 6 | `plan_progress` 事件 | Produce 发了，Session 映射丢了；且写完一律标 `done` |

### 1.3 一句话

> **Freeze/publish 在；语义 wiki 生成是薄管线。** Fixture 测试绿不代表 live 生成正常。

---

## 2. Cursor Agent Swarm 可借鉴点

### 2.1 应抄

1. **树形 Planner / Worker**，非扁平 swarm：规划者拆解与拥有设计，执行者窄任务、隔离上下文。
2. **混合模型经济学**：frontier 做 plan/replan/硬判断；cheap 做高 token 量 leaf（Cursor 约 **8×** 成本差、质量相近）。
3. **Stigmergy**：用共享环境产物协调（Field Guide、design docs、receipts），而非 agent 互聊。
4. **Stacked review lenses**：多视角审查 ROI 高（比再生成一轮便宜）。
5. **Spec 是稀缺资源**：意图描述质量决定树质量。

### 2.2 不要抄

| Coding swarm 模式 | Wiki 为何不适合 |
|-------------------|-----------------|
| 多 writer 并发改同一树 | 叙事一致性、链接与 citation 完整性被 thrash 毁掉 |
| 千级 commit/s 自定义 VCS | Staging FS + 原子 publish 足够 |
| 「故意弄坏 + 编译器传播」 | 无 compiler；中间坏 wiki 会污染 writer/reviewer |
| 「先脏后绿」 | 已发布知识错误预算更低 → **fail-closed grounding** |
| 更多 agent = 更好 | 无更好 Spec/receipt 只会增加矛盾 |

**Wiki 口号：**

> **并行化证据，集中化叙事，Host 强制真值门。**

---

## 3. Google OKF v0.1 与当前产出

### 3.1 硬符合性（SPEC §9）

1. 每个 **非 reserved** `.md` 有可解析 YAML frontmatter  
2. frontmatter 含非空 **`type`**  
3. reserved：`index.md`（列表）、`log.md`（历史）若存在须符合 §6/§7  

### 3.2 与 open-okf-wiki 的关键错位

| 项 | OKF | 本产品现状 |
|----|-----|------------|
| 必填 frontmatter | **`type`** | 只强制 **`title`** |
| `index.md` | 列表、无 concept FM | 当叙事入口 + 有 title + 要 citation |
| Citations | 可选 `# Citations` | 硬性 inline `[Source](repo:…#L…)` |
| `log.md` | 可选 | 无 |

产品比 OKF **更严**于 source grounding（ADR 0008），但 **硬不符合** OKF 主要因：缺 `type`、误用 reserved `index.md`。

### 3.3 最小 OKF 对齐（保留 Source Citations）

1. 叙事页：`overview.md` 等 concept，带 `type` + `title`  
2. `index.md`：纯列表（可无 FM，或仅 `okf_version`）；**豁免** citation  
3. `validate-wiki.ts`：区分 reserved vs concept  
4. 可选：post-write 确定性 regenerate 各层 `index.md`（对齐 Google `index.py`）

---

## 4. Pi 拓展 / Subagent / Dynamic Workflow

### 4.1 本仓库用法（ADR 0030）

- **Pi** 拥有 session / tool loop / compaction  
- **Product** 拥有 WikiRunShell + Run Boundary  
- `noExtensions` / `noContextFiles`：不加载源码树扩展（安全）  
- Subagent = **进程内 child `AgentSession`**，不是 `pi` CLI 社区 subagent 包  

### 4.2 历史 DynamicWorkflow（ADR 0010）

- 原 Harness 单层 leaf 协调；Mastra 路径已退役  
- 今日正确形态：**Host 有界 MapReduce**（Domain→Leaf），不是模型写脚本的嵌套 workflow  

### 4.3 不要引入的依赖

- `@tintinweb/pi-subagents` / `pi-dynamic-workflows` 作为产品 runtime：难强制 path policy、可能带 bash  
- 源码树 Pi extensions：不可信  

---

## 5. 目标拓扑（综合方案）

```text
Layer A — WikiRunShell（确定性）
  plan-gate → produce → hard-validate → publish-gate

Layer B — Produce（概率语义）
  Planner (frontier) → WikiRunSpec
    ├─ Domain researchers (mid/cheap)
    │    └─ Leaf researchers (cheap) → AnalysisReceipts
    ├─ Root writer (strong) ← Spec + receipts 归约
    ├─ Review council (decorrelated lenses)
    └─ Repair rounds (≤ maxRepairRounds) → evaluateWikiPublishable
```

| 角色 | 工具 | 模型层 | 产出 |
|------|------|--------|------|
| Planner | RO | Frontier | Spec（domains/pages/questions/acceptance） |
| Domain | RO | Mid/worker | Domain receipt + child refs |
| Leaf | RO | Cheap | Leaf receipt（证据 + 路径） |
| Writer | RW wiki/analysis | Strong | Staging pages |
| Reviewer | RO | 与 writer 去相关 | DefectReport |

**Stigmergy 工件：**

- `analysis/spec.json` — 活 Spec  
- `analysis/receipts/**` — 不可变证据  
- `analysis/defects.json` — Host 合并审查  
- 可选 `analysis/field-guide.md` — 行预算内惯例（citation 格式、坑、已覆盖范围）  

---

## 6. 分阶段落地（按 ROI）

### Phase 0 — 止血（1–2 PR，P0）

1. **替换 live root_write user prompt**：读 `skill/SKILL.md` + branch refs + templates；写 **Spec 全部 critical pages**；`wikiLanguage`；正确 citation 形态。  
2. **Repair loop**：council 后 blocking → 最多 `maxRepairRounds` 次 targeted rewrite → 再 council → fail-closed。  
3. **Fail-closed review/research**：child/reviewer error → blocking defect 或 run fail，永不伪 clean。  
4. **CLI `resolveModel`**：与 server 共用 Settings 工厂。  
5. **plan_progress 诚实**：仅当文件存在才标 done；Session 映射该事件。

### Phase 1 — 证据管线（核心优化）

1. Host `publish_receipt` customTool（校验 `AnalysisReceiptSchema`，原子写）。  
2. Domain 结果 **必须**落盘；root_write prompt 注入 receipt 路径。  
3. freeze 的 **Effective Source Ignores** 注入所有 Pi sessions。  
4. `roleModels` 端到端：planner / worker / writer / reviewers 分模型。

### Phase 2 — 真监督树 + OKF 对齐

1. Domain 下 Leaf fan-out（`maxLeafFanOut`，共享 concurrency）。  
2. 可选模型可调 `delegate_leaf`（内部仍调 host `runChildSession` + 预算）。  
3. LLM plan 阶段（plan-gate 前）或诚实标注「generic default Spec」。  
4. OKF：`type` + reserved `index.md` 列表化 + validate 双模式。  
5. 可选确定性 index regenerate。

### Phase 3 — 经济学与可观测

1. 按角色记 token/$（优化 **$/publishable wiki**）。  
2. Multi-lens review prompts（grounding / coverage / consistency）。  
3. Field Guide 注入 + 行预算。  
4. Live 集成测试：faux model 断言 critical pages + citations + repair。

---

## 7. 成功指标

| 指标 | 目标 |
|------|------|
| Live CLI/Session 无 fixture 可完成 publishable | 必达 |
| Critical Spec pages 存在 + 可解析 citation | 必达 |
| Blocking defect 经 repair 仍存在 → fail，不伪绿 | 必达 |
| 大仓 Root peak context | 相对单 agent 明显下降 |
| 混合 roleModels 相对全 frontier | 成本显著下降、质量不崩 |
| 非 reserved 页含 `type`；`index.md` 为列表 | OKF §9 硬符合 |
| Leaf/receipt 路径有测试覆盖 | 防回归 |

---

## 8. 明确不做

- 把 HITL/publish 塞进 model DynamicWorkflow  
- 多 writer 并行写同一 Staging 树  
- 启用源码树 Pi extensions  
- 用社区 pi-subagent 包替代 host 预算控制  
- 为 OKF 放弃 `repo:` Source Citations  
- 全量 Accepted Knowledge Model / claim ledger（ADR 0008 仍 defer）

---

## 9. 建议的第一个 PR 序列

1. Live write prompt + Spec critical pages + wikiLanguage  
2. Repair + fail-closed reviewer  
3. Receipt persist + writer 消费  
4. Source ignores + roleModels wiring  
5. CLI resolveModel + plan_progress honesty  
6. OKF `type` + index 列表语义 + validate 豁免  
7. Leaf fan-out + cost telemetry  

---

## Source map

| 主题 | 来源 |
|------|------|
| Swarm 架构 / 经济学 / 失败模式 | https://cursor.com/blog/agent-swarm-model-economics |
| OKF 硬规则 | `refs/knowledge-catalog/okf/SPEC.md` §3–§9 |
| 产品拓扑 | ADR 0028, 0030；`CONTEXT.md` |
| Produce 实现缺口 | `packages/agent/src/produce/*`, `wiki-run.ts` |
| 校验契约 | `packages/core/src/validate-wiki.ts`, `citations.ts` |
| Skill 方法 | `packages/skill/SKILL.md` |
| Receipt 契约 | `packages/contract/src/receipt.ts`, `core/analysis-scratch.ts` |
| 文件交接研究 | `docs/research/file-communication-agent-handoff.md` |
