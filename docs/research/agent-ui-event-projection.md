# Agent UI：事件投影 vs「直接用」runtime（业界对照）

研究日期：2026-07-23

## 结论

1. **生产级 Agent Web UI 几乎都做「事件流 → 视图模型」投影**，而不是在浏览器里持有 `AgentSession` / graph runtime。
2. **「直接用 Pi」指服务端直接 `createAgentSession` / `prompt` / `subscribe`**；浏览器侧「直接用」应理解为 **消费 Pi 事件协议**（`message_update`、`thinking_delta`、`tool_execution_*`），不是 import 进程内对象。
3. 本仓 ADR 0030 的 *Pi session + projected events* 与 AG-UI、AI SDK UIMessage stream、LangGraph `useStream`、pi-web 同构；投影是 **适配层**，不是第二套 agent。
4. 会话页「无 thinking / 无 message」类故障，应优先查 **协议字段是否投影完整**（`errorMessage`、`thinking_*`）与 **provider 失败是否被静默**，而不是删除投影层。

## 问题陈述

Operator UI（`packages/web` Agent Workspace）通过 SSE 消费 Pi + product 事件，用 `applyPiEvent` / `applyProductEvent` 得到 `AgentMessage[]` 再渲染。常见疑问：

- 为何不「直接用 Pi 能力」？
- 投影是否多余、是否导致响应丢失？

## 业界模式（主源）

### AG-UI + CopilotKit

- **协议**：Agent 向客户端流式发送类型化事件（text message、tool call、state snapshot/delta、run lifecycle 等）。
- **客户端**：subscribe 后投影为 `messages` / shared state / tool UI；CopilotKit 是主要消费端。
- **意图**：解 M×N（多 agent 框架 × 多 UI）。
- 主源：[AG-UI events](https://docs.ag-ui.com/concepts/events)、[AG-UI introduction](https://docs.ag-ui.com/introduction)、[CopilotKit AG-UI](https://www.copilotkit.ai/ag-ui)。

### Vercel AI SDK `useChat` + UIMessage parts

- **协议**：UI Message Stream（`text-delta`、reasoning、tool parts 等）。
- **客户端**：`useChat` 将 chunk **组装** 为 `UIMessage[]`，UI 按 `parts` 渲染。
- 即使封装成 hook，内部仍是 **stream reduce → transcript**。
- 主源：[useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)、[stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)。
- 本仓历史：ADR 0025/0027 曾用此栈；ADR 0030 退役 AI SDK 作 runtime 依赖，但 **「流 → 时间线」** 形态保留。

### LangGraph frontend `useStream`

- 多 stream mode（`messages` / `tools` / `values`）。
- Hook 暴露已组装的 `messages`、`toolCalls`（running → finished）；UI 映射这些状态，不跑 graph。
- 主源：[LangChain frontend overview](https://docs.langchain.com/oss/python/langchain/frontend/overview)、tool-calling UI 文档。

### Pi coding agent + pi-web

- **Runtime**：`AgentSession`、JSONL session tree、tools、skills（Node/SDK 或 RPC）。
- **事件**：`message_start` / `message_update` / `message_end`，`assistantMessageEvent` 含 `text_delta`、`thinking_delta`、`toolcall_*` 等。
- **Web**：pi-web 等 UI 订阅事件/RPC，渲染 chat/tools/thinking；会话真源仍是 session 文件，不是浏览器内 agent。
- 主源：Pi RPC / coding-agent 文档（`message_update` + `assistantMessageEvent`）、[pi.dev](https://pi.dev/)、社区 pi-web 消费模式。

### 通用架构叙事

行业文章常把两条线并称，实际生产多为 **hybrid**：

| 名称 | 含义 |
|------|------|
| Stream events projection | 有序事件为交互真源；`state = project(state, event)` |
| Client agent session | UI 暴露 session facade（messages、send、status）；**内部仍是投影** |

主源示例：[AG-UI / agent frontend 讨论](https://blog.logrocket.com/build-real-ai-with-ag-ui/)、Workflow/session modeling 类文档。

## 为何不能「浏览器直接 AgentSession」

| 原因 | 说明 |
|------|------|
| 信任边界 | API key、workspace cwd、tool allowlist、Source Ignores 属 Run Boundary；不可下发浏览器（对照 ADR 0002、0019）。 |
| 进程模型 | Agent 是长跑进程；UI 是多标签、重连、刷新的投影面。 |
| 展示语义 | 乐观 user、tool 嵌套、thinking 折叠、error 可见——协议消息列表 ≠ transcript 卡片。 |
| 产品事件 | plan/publish gate、run_link、progress 不是 Pi 原生，必须并入 operator 时间线。 |
| 可替换性 | 投影只依赖事件 shape；换 harness（Mastra→Pi）不必重写全部 UI 状态机。 |

## 与本仓对照

| 业界 | 本仓 |
|------|------|
| Server 持有 agent session | `packages/server` → `ensureLiveHandle` / `session.prompt` |
| 事件总线 SSE/WS | `/agent/sessions/:id/events` + in-memory bus |
| Pure projector | `packages/web/.../project-agent-events.ts` |
| 冷加载 history | `packages/agent/.../session-history.ts`（Pi JSONL） |
| 产品 inject | `run_phase` / `gate` / `run_link` / `progress` / `agent_span` / `defects` |
| 真源 | Pi JSONL under `.okf-wiki/pi-sessions/`（ADR 0030）；**无**第二套 UIMessage DB |
| UI kit | shadcn MessageScroller / Message / Bubble（视图），非 pi-web 宿主 |

决策记录：[ADR 0030](../adr/0030-pi-agent-harness-for-semantic-workflow.md)（*Pi session + projected events*）、[operator-event-contract](../design/operator-event-contract.md)。

## 故障对照（经验）

| 症状 | 常见根因 | 本仓处理方向 |
|------|----------|--------------|
| 发消息「没反应」 | Provider 失败在 `stopReason`/`errorMessage`，未 throw | 投影 + HTTP `status: failed` + ErrorBanner |
| 无 thinking | 只处理 `text_delta` | 投影 `thinking_*` + content `type: "thinking"` |
| Wiki 有反馈、chat 像死 | 产品 SSE 与 Pi 文本通道不对称 | 预期差异；chat 失败须显式错误，勿静默 |
| 刷新后失败回合消失 | history 丢弃空 content | history 保留 error/thinking-only |

## 推荐演进（保留投影，加深「用 Pi」）

1. **共享 pure projector**  
   将 `applyPiEvent` 与 history 规则收敛到单一包（如 `@okf-wiki/pi-transcript`），server 诊断与 web 共用，避免双份语义漂移。

2. **Session facade**  
   对外保持 `messages / status / send / abort`（类 `useChat` / `useStream`）；对内 SSE reduce。开发者体感是 session，不是手写每种 `kind`。

3. **Contract 一等公民**  
   SSE payload 显式类型化 `thinking`、`errorMessage`、product kinds，减少 `Record<string, unknown>`。

4. **不要**  
   - 浏览器内 `AgentSession`  
   - 第二套消息持久化与 Pi JSONL 并行  
   - Session 合成假 tool trail（ADR 已禁）

## 一句话

**Pi 能力在服务端直接使用；Web 的投影是业界标准的事件→视图适配。删投影不会更「用 Pi」，只会让 operator UI 更脆。**

## 参考链接

- [AG-UI events](https://docs.ag-ui.com/concepts/events)
- [AG-UI introduction](https://docs.ag-ui.com/introduction)
- [CopilotKit AG-UI](https://www.copilotkit.ai/ag-ui)
- [AI SDK useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)
- [AI SDK stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [LangChain agent frontend](https://docs.langchain.com/oss/python/langchain/frontend/overview)
- [pi.dev](https://pi.dev/)
- 本仓 [ADR 0030](../adr/0030-pi-agent-harness-for-semantic-workflow.md)
