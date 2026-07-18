# TUI：当前项目与 DeepAgents/OpenWiki 的对照

研究日期：2026-07-16

## 结论

有可参考的 TUI；产品路径现已用 **Textual** 全屏 Operator Session 实现（对齐 Textual 官方 `mother.py` 聊天布局 + pydantic-ai `event_stream_handler` 流式事件），而不是自研布局协议。

`refs/openwiki` 的终端界面是 OpenWiki 自己的 React/Ink 应用，不是 DeepAgents 提供的通用 TUI。非交互路径仍是 `wiki-run` JSON CLI；交互路径为 `okf-wiki` / `okf-wiki tui`（实现模块 `okf_wiki.session.app`）。

## 参考实现是什么

OpenWiki 的包直接依赖 `deepagents`、`ink`、`react` 和 `marked`（`refs/openwiki/package.json:L43-L58`）。其入口导入 Ink 的 `render`、`useInput` 和 `useApp`（`refs/openwiki/src/cli.tsx:L1-L4`），TTY 下渲染交互 App，非 TTY 或 `--print` 时走非交互路径（`refs/openwiki/src/commands.ts:L542-L557`、`refs/openwiki/src/cli.tsx:L3450-L3464`）。

Agent 层把 LangGraph/DeepAgents 的事件流转成 UI 事件：调用 `streamEvents`，解析文本和工具开始/结束事件，再交给 UI 的 `onEvent` 回调（`refs/openwiki/src/agent/index.ts:L203-L232`、`refs/openwiki/src/cli.tsx:L1148-L1204`）。输入组件处理上下键、回车、取消、模型/provider 选择和多轮 follow-up（`refs/openwiki/src/cli.tsx:L1566-L1620`）。

DeepAgents 本身定位是 agent harness/runtime；其官方 README 将终端 coding agent 作为独立产品入口，并没有把 OpenWiki 的 Ink App 作为 DeepAgents 核心 UI（[DeepAgents README](https://github.com/langchain-ai/deepagents/blob/main/README.md#L47-L75)）。

## 当前 Python 依赖已经有什么

项目锁定的 `pydantic-ai==2.10.0` 已带 CLI extra。其 `pai` CLI 使用 `prompt_toolkit` 的 `PromptSession`、文件历史和 `rich` 的 `Console`/`Live`/`Markdown`（[Pydantic AI CLI source](https://github.com/pydantic/pydantic-ai/blob/v2.10.0/pydantic_ai_slim/pydantic_ai/_cli/__init__.py#L25-L44)）。本地命令可验证：

```text
uv run --locked pai --help
```

它是通用 Agent 聊天 CLI，不会自动获得 OKF Wiki 的 Repository Snapshot、CodeMode mounts、Wiki validation 或 atomic publication，因此不能直接替代 `WikiRunApplication`。

## 对本项目的推荐（已落地修订）

采用成熟 Python 库，不自研 TUI 框架：

1. **Textual** 全屏 App（官方 `mother.py`：`VerticalScroll` + 底部 `Input` + `Markdown` / `Markdown.get_stream` 流式渲染）。
2. **pydantic-ai** `event_stream_handler` / stream events 驱动模型文本与 tool 标签；Host `WikiRunEvent` 仍投影为 L1 cards。
3. 保留 `WikiRunApplication.run(request) -> WikiRunResult` 和 JSON `wiki-run`；CI / pipe / cron 不变。
4. 不显示 thinking / CoT；tool 只显示名称。
5. 参考实现（不 vendoring）：[Textual mother.py](https://github.com/Textualize/textual/blob/main/examples/mother.py)、[Elia](https://github.com/darrenburns/elia)（Textual 聊天架构参考）。

不要让通用 `pai` CLI 直接加载临时 Wiki Agent（会绕过快照/校验/发布边界）。不要复制 OpenWiki 整套 Ink App。

## 与现有一次性 `run()` 的关系

当前 `wiki_run.py` 在一次 `Agent.run()` 中等待最终结果（[host/lifecycle.py](../../src/okf_wiki/host/lifecycle.py#L536-L560)）。因此“加 TUI”不只是换输出格式：若要显示模型/工具/递归状态，需要在不破坏 output validator、usage limits、wall-clock deadline 和 publication 流程的前提下增加事件观察 seam。最小安全顺序是先抽出内部事件回调，再接 TUI；不要把 UI 状态机塞回语义 workflow 或 Host 的发布逻辑。

## 资料

- [OpenWiki README](https://github.com/langchain-ai/openwiki/blob/ddd1f609b23d83b96a800ea0f4d47e7d28a78c7d/README.md#L62-L77)
- [OpenWiki package.json](https://github.com/langchain-ai/openwiki/blob/ddd1f609b23d83b96a800ea0f4d7e7d28a78c7d/package.json#L43-L58)
- [OpenWiki CLI source](https://github.com/langchain-ai/openwiki/blob/ddd1f609b23d83b96a800ea0f4d47e7d28a78c7d/src/cli.tsx#L1-L4)
- [Pydantic AI CLI documentation](https://ai.pydantic.dev/cli/)
- [Pydantic AI streamed output documentation](https://ai.pydantic.dev/output/#streamed-results)
