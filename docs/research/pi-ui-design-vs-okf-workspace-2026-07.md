# Pi 设计理念 vs OKF Agent Workspace（对照定位）

**日期：** 2026-07-23  
**范围：** 只读分析，不改产品代码  
**Pi 源码：** `refs/pi` → 本地树 `earendil-works/pi`（`@earendil-works/pi-coding-agent` / `pi-agent-core` / `pi-tui`）  
**触发：** 实机 Wiki 生成中，点击 subagent 只见「思考中…」，正文 / tool / message 不渲染  

---

## 1. Pi 在解决什么问题

Pi 的产品中心是 **一个可嵌入的 Agent 运行时 + 一种会话真源 + 多种壳（TUI / JSON / RPC / SDK）**。

| 层 | 包 | 职责 |
|----|-----|------|
| LLM + content blocks | `pi-ai` | `text` / `thinking` / `toolCall` / images |
| Agent loop + events | `pi-agent-core` | `message_*` / `tool_execution_*` / turn lifecycle |
| Session + tools + skills | `pi-coding-agent` | `AgentSession`、`SessionManager` JSONL 树、extensions |
| 终端 UI | `pi-tui` + interactive-mode | 事件 → 组件树，原地更新 |

**一句话：**  
**Runtime 持有 session；壳只订阅事件并渲染；会话真源是 JSONL 树，不是 UI 状态机。**

官方 SDK 文档写得很直白（`coding-agent/docs/sdk.md`）：

```ts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("...");
```

集成方可以只消费 delta；**官方 TUI 实际更偏「整消息快照」**（见下）。

---

## 2. Pi 的核心设计原则（从源码读出）

### P1 — 一个会话 = 一条事件流 = 一个 chat 容器

`interactive-mode.ts` 持有：

- `chatContainer`：主时间线组件列表  
- `streamingComponent: AssistantMessageComponent | undefined`：**当前这一条** assistant 流  
- `pendingTools: Map<toolCallId, ToolExecutionComponent>`：本轮 tool 组件  

没有「主会话 + 一堆平行 chat bubble 共享同一 scroller」的第二套 timeline。

### P2 — 流式更新用 **完整 partial message**，不是只拼 delta

`message_update` 处理（精简）：

```ts
case "message_update":
  if (this.streamingComponent && event.message.role === "assistant") {
    this.streamingMessage = event.message;
    this.streamingComponent.updateContent(this.streamingMessage); // ← 整包 message
    // toolCall 块出现时挂 ToolExecutionComponent
  }
```

`AssistantMessageComponent.updateContent(message)` 会 **清空并按 `message.content[]` 重画** text / thinking。

含义：

- 协议里同时有 `assistantMessageEvent`（delta）和 `message`（累计快照）  
- **权威 UI 状态 = 最新 `event.message`**  
- delta 是传输优化；UI 以快照为准更不容易丢字段 / 乱序  

本仓 `applyPiEvent` 主路径是 **delta 累加**，快照路径仅在 `!ame` 时启用——与 Pi TUI 默认策略不一致。

### P3 — tool 是 **独立组件**，挂在时间线旁，不塞进 markdown 气泡

- `message_update` 里发现 `content.type === "toolCall"` → 创建/更新 `ToolExecutionComponent`  
- `tool_execution_start/update/end` 再驱动执行态与 result  
- tool 有自己的 expand / 专用 renderer（bash `$`、read 路径…）  

不是「assistant bubble 里塞一段 pre」。

### P4 — 一轮 assistant 的生命周期指针清晰

| 事件 | TUI 行为 |
|------|----------|
| `message_start` (assistant) | `new AssistantMessageComponent`，设为 `streamingComponent` |
| `message_update` | **原地** `updateContent(full message)` |
| `message_end` | 最终 `updateContent`，`streamingComponent = undefined` |
| `agent_end` | 清残留 streaming 组件与 pendingTools |

不会用 product 层的「running 空壳」顶替 assistant 组件。

### P5 — Session 真源是 JSONL 树；UI 可冷启动重建

- 路径与树：`docs/sessions.md`、`docs/session-format.md`  
- `SessionManager`：`id` / `parentId` 树，可 `/tree` `/fork`  
- 冷加载 = 读 JSONL 投影消息列表，**不是**依赖 in-memory SSE ring buffer  

### P6 — Subagent 在 Pi 里是 **扩展级 tool 形态**，不是第二套平行 chat

官方示例：`packages/coding-agent/examples/extensions/subagent/`

设计要点：

1. **子 agent = 独立 `pi --mode json -p --no-session` 进程**（隔离上下文）  
2. **父会话只看到一个 tool 调用**（subagent tool）  
3. 流式：子进程 JSONL 事件 → 解析 `message_end` / tool 结果 → **`onUpdate(partial tool result)`**  
4. UI：`renderCall` / `renderResult`  
   - **默认折叠**：状态图标 + agent 名 + **最近 5–10 条** tool/text + usage  
   - **展开 (Ctrl+O)**：完整 task、全部 tool args、最终 Markdown  
5. 并行：多 task 同时 ⏳/✓/✗，不是每个 leaf 往父 scroller 灌 full transcript  
6. 父模型只拿 **截断后的 final output**（parallel 50KB cap），细节留在 tool details  

**理念一句话：**  
**Subagent 的 UX 单元是「可展开的 tool 结果卡」，不是「父对话里的第二个 assistant 角色」。**

### P7 — 对外集成面优先 JSON / RPC / 直嵌 SDK

| 模式 | 用途 |
|------|------|
| `pi --mode json` | 事件 JSONL → 自定义 UI / 子 agent 宿主 |
| `pi --mode rpc` | stdin 命令 + stdout 事件（注意勿用 Node readline 拆行） |
| SDK `createAgentSession` | Node 内嵌，**不要**再包一层假协议 |

Pi **没有**把「product run_phase / agent_span」做成一等公民——那是宿主产品的事。Pi 只保证 **AgentSession 事件** 自洽。

---

## 3. 本仓当前架构（对照）

```
Operator Session (Pi AgentSession, chat)
        │
        ├─ SSE source:"pi"  ──► applyPiEvent ──► messages[] ──► Transcript
        │
        └─ start_wiki_run
               │
               ├─ product agent_span / run_phase ──► Work chip + workStreams 空壳
               │
               └─ runChildSession × N (独立 createWikiSession)
                      │
                      onPiEvent ──► child_pi ──► emitPi(+okfAgent)
                                       │
                                       ▼
                              applyChildStreamEvent ──► workStreams[agentId]
                                       │
                                       ▼
                              AgentFocusDrawer (点击后才看)
```

叠加层：

1. 产品事件（phase / span / gate）  
2. 主会话 Pi 事件  
3. 子会话 Pi 事件（打标后并进同一 SSE）  
4. 冷加载：Pi JSONL（仅 operator）+ `operator-work.json`（span 摘要）+ ring buffer  

**这已经是 3–4 条「准真源」**，而 Pi 官方路径通常只有 **1 条 session 事件流 + 1 份 JSONL**。

---

## 4. 症状对照：为何点击只见「思考中…」

UI 空态（`AgentFocusDrawer`）：

```ts
streaming && !content && !thinking && tools.length === 0
  → 显示 i18n `thinkingStreaming`（「思考中…」）+ spinner
```

因此实机含义几乎总是：

> `workStreams[focusAgentId]` **存在** 且 `status === "streaming"`，但 **content / thinking / tools 全空**。

这与下列设计缝隙高度吻合：

| # | 机制 | 后果 |
|---|------|------|
| 1 | `agent_span` running 先写 `workStreams[id] = { status:streaming, content:"" }` | 一点击就有「运行中壳」，与 Pi「先有 message_start 组件再填 message」相反 |
| 2 | 真流依赖 `child_pi` → `applyChildStreamEvent` 二次投影 | 任一层丢事件 / kind 不匹配 / agentId 不一致 → 壳永不填 |
| 3 | 投影偏 **delta 累加**，弱用 `event.message` 快照 | 与 Pi TUI 相反；部分 provider 路径更容易「有事件无可见文本」 |
| 4 | 子会话 JSONL **不**并入 operator session 冷加载 | 刷新后只能靠 span detail；live 失败时 drawer 更空 |
| 5 | 打开 drawer 时 `focusedStream = workStreams[exactId]` | id 与 spanId / receiptNodeId 稍有不一致 → 永远空壳 |
| 6 | Subagent 未做成 **父会话 tool 卡** | 父 timeline 与 Work drawer 割裂，状态机双写 |

这不是「少写一行 CSS」，而是 **Pi 会话模型与产品多路 fan-in 投影不一致**。

---

## 5. 设计混乱点（诚实清单）

1. **会话边界模糊**  
   Pi：一个 `AgentSession` 一条流。  
   我们：operator session + N 个 produce child session，事件汇入同一 SSE，再靠 `okfAgent` 拆开。

2. **UI 状态机双写**  
   `agent_span` 写 status 壳；`child_pi` 写 body；两者无单一 reduce 入口。

3. **Subagent UX 偏离 Pi 官方范式**  
   官方：tool 卡折叠 + 展开详情 + partial tool result 流。  
   我们：chip 列表 + 侧栏「假装另一个 chat」+ 独立 `workStreams`。

4. **冷/热路径不对称**  
   热：delta 投影；冷：history JSONL（无 child）+ operator-work 摘要。  
   Pi：冷热都围绕同一 session 消息列表（TUI 从 session 重建组件）。

5. **「思考中」文案被复用为空流占位**  
   用户以为在 thinking；实际是 **零内容 streaming 壳**。

6. **与 ADR 0026 字面一致、实现漂移**  
   ADR 要求 subagent「嵌套卡 / 面板，点开看 trail」——方向对。  
   实现却拆成 product span + 旁路 Pi 投影 + drawer，中间没有 Pi 式的 **单一 streaming pointer**。

---

## 6. Pi 会怎么做（若从零嵌 wiki produce）

在 **不牺牲 Run Boundary** 的前提下，更贴近 Pi 的形态是：

### 方案 A — 宿主编排 + 子 agent 以 tool 结果呈现（最像官方 subagent 扩展）

- Produce 仍可 `createWikiSession` 跑 planner/leaf  
- 但 **对 operator 可见的单元** = 父会话（或 shell）上的 **结构化 tool / product 卡**：  
  - 折叠：role · status · 最近工具名 · 一行摘要  
  - 展开：该 child 的 message 列表（从 child 事件 **完整 message 快照** 维护）  
- 父 scroller **从不**出现 leaf 的 peer assistant 气泡  
- 流式：更新 **那张卡的 partial**，而不是另一个全局 `workStreams` 字典 + 侧栏猜 id  

### 方案 B — 单一 produce session（更激进）

- 整个 wiki run 在一个 AgentSession 内用 tools 完成（delegate 也是 tool）  
- 与 Pi TUI 完全同构；产品 phase/gate 仍可 inject  
- 改造成本大，但状态机最干净  

### 方案 C — 维持多 child session，但投影契约对齐 Pi TUI

若短期不改架构，至少：

1. **禁止**用空 `agent_span` 创建「streaming 无 body」壳作为 drawer 主状态  
2. Drawer 状态机：`idle | waiting_events | streaming(message snapshot) | settled(detail)`  
3. 每个 child 维护 `streamingMessage: AssistantMessage | null`（同 Pi），`message_update` → **整包替换**  
4. tools 用 `Map<toolCallId, ToolState>`，不要只塞进字符串  
5. agentId 解析：单一 canonical id 表（spanId → agentId）  
6. 空态文案：**「等待子 agent 事件…」**，不要叫「思考中」  

---

## 7. 建议的学习顺序（继续深读 Pi）

本地源码：`refs/pi`（链到 `okf-wiki/refs/pi-mono`，remote: `earendil-works/pi`）。

| 优先级 | 路径 | 学什么 |
|--------|------|--------|
| 1 | `coding-agent/src/modes/interactive/interactive-mode.ts` ~2809–2960 | 事件 → 组件指针 |
| 2 | `.../components/assistant-message.ts` | 快照重绘 thinking/text |
| 3 | `.../components/tool-execution.ts` | tool 卡 expand / 专用渲染 |
| 4 | `coding-agent/examples/extensions/subagent/` | **子 agent 产品形态金标准** |
| 5 | `coding-agent/docs/json.md` + `rpc.md` + `sdk.md` | 对外协议 |
| 6 | `coding-agent/docs/session-format.md` | 冷加载真源 |
| 7 | `agent/src/types.ts` + `agent-loop.ts` | `AgentEvent` / `message_update` 形状 |

说明：当前 monorepo **不含** 独立 `pi-web-ui` 包；Web 集成应学 **JSON/RPC/SDK + TUI 事件映射**，社区 pi-web 是第三方壳，理念仍是「订阅事件，不持有 runtime」。

---

## 8. 结论（给后续改造用）

1. **Pi 的哲学是：少协议、单 session 流、UI 用 message 快照原地更新、subagent 是可折叠 tool 体验。**  
2. **本仓把 produce 树硬塞进「第二套 workStreams + product span 壳」**，与 Pi 的 streaming pointer 模型冲突，直接导致「运行中空壳 = 永远思考中」。  
3. 修 bug 前应先 **定会话/投影契约**（上节 A/B/C），否则会在 drawer / chip / span / child_pi 之间继续补丁。  
4. 短期若只修体验：优先 **对齐 P2（message 快照）+ P6（tool 卡形态）+ 消灭空 streaming 壳**；中期评估是否收敛到官方 subagent 扩展的「父 tool + 子 json 模式」。  

**本文不包含代码改动。**  
**后续决策已落地：** [ADR 0031](../adr/0031-unidirectional-framework-first-operator-surface.md) + 更新后的 [operator-event-contract](../design/operator-event-contract.md)（单向依赖、框架优先、inject 白名单、subagent 父可见单元）。实现按 0031 §Implementation guidance 推进。
