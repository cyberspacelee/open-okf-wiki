# TUI：当前项目与 DeepAgents/OpenWiki 的对照

研究日期：2026-07-16

## 结论

有可参考的 TUI，但当前项目没有实现它。

`refs/openwiki` 的终端界面是 OpenWiki 自己的 React/Ink 应用，不是 DeepAgents 提供的通用 TUI。当前 OKF Wiki 仍是 CLI-only：`argparse` 接收参数，运行结束后输出一个 JSON 对象；README 也明确说明没有 web frontend 或 Console process（[README](../../README.md#L22-L30)、[cli.py](../../src/okf_wiki/cli.py#L16-L18)、[cli.py](../../src/okf_wiki/cli.py#L184-L189)）。

## 参考实现是什么

OpenWiki 的包直接依赖 `deepagents`、`ink`、`react` 和 `marked`（[package.json](../../refs/openwiki/package.json#L43-L58)）。其入口导入 Ink 的 `render`、`useInput` 和 `useApp`（[cli.tsx](../../refs/openwiki/src/cli.tsx#L1-L4)），TTY 下渲染交互 App，非 TTY 或 `--print` 时走非交互路径（[commands.ts](../../refs/openwiki/src/commands.ts#L542-L557)、[cli.tsx](../../refs/openwiki/src/cli.tsx#L3450-L3464)）。

Agent 层把 LangGraph/DeepAgents 的事件流转成 UI 事件：调用 `streamEvents`，解析文本和工具开始/结束事件，再交给 UI 的 `onEvent` 回调（[agent/index.ts](../../refs/openwiki/src/agent/index.ts#L203-L232)、[cli.tsx](../../refs/openwiki/src/cli.tsx#L1148-L1204)）。输入组件处理上下键、回车、取消、模型/provider 选择和多轮 follow-up（[cli.tsx](../../refs/openwiki/src/cli.tsx#L1566-L1620)）。

DeepAgents 本身定位是 agent harness/runtime；其官方 README 将终端 coding agent 作为独立产品入口，并没有把 OpenWiki 的 Ink App 作为 DeepAgents 核心 UI（[DeepAgents README](https://github.com/langchain-ai/deepagents/blob/main/README.md#L47-L75)）。

## 当前 Python 依赖已经有什么

项目锁定的 `pydantic-ai==2.10.0` 已带 CLI extra。其 `pai` CLI 使用 `prompt_toolkit` 的 `PromptSession`、文件历史和 `rich` 的 `Console`/`Live`/`Markdown`（[Pydantic AI CLI source](https://github.com/pydantic/pydantic-ai/blob/v2.10.0/pydantic_ai_slim/pydantic_ai/_cli/__init__.py#L25-L44)）。本地命令可验证：

```text
uv run --locked pai --help
```

它是通用 Agent 聊天 CLI，不会自动获得 OKF Wiki 的 Repository Snapshot、CodeMode mounts、Wiki validation 或 atomic publication，因此不能直接替代 `WikiRunApplication`。

## 对本项目的推荐

首版采用 Python 原生、行式交互 TUI，而不是引入 Node/Ink 或 Textual：

1. 保留 `WikiRunApplication.run(request) -> WikiRunResult` 和现有 JSON CLI；CI、pipe、cron 继续使用非交互路径。
2. 增加一个薄的 `okf-wiki tui` presentation adapter，复用 `prompt_toolkit + Rich`，只负责输入、状态、Markdown 和事件显示。
3. 将内部 Agent 执行抽出可选 event sink；Pydantic AI 的 `Agent.iter()` 能异步遍历模型请求、工具执行和最终结果节点，适合在不改变终端结果契约的情况下驱动 UI（[Agent.iter API](https://github.com/pydantic/pydantic-ai/blob/v2.10.0/pydantic_ai_slim/pydantic_ai/agent/__init__.py#L943-L975)）。
4. UI 显示 Run Plan、Root/Domain/Leaf 状态、当前工具、receipt 路径、retry/backoff 和最终 publication；不显示或持久化模型隐式 chain-of-thought。
5. 递归 child 的细粒度状态来自 Host-owned event log/receipt，而不是尝试从 `run_code` 文本或目录扫描推断完成；这与现有文件通信 ADR 一致。
6. 没有 TTY 时自动回退到 JSON/错误提示，保持 OpenWiki 已采用的 CI 行为。

不要让通用 `pai` CLI 直接加载一个临时 Wiki Agent：那会绕过当前项目的快照冻结、只读 mount、输出验证和原子发布边界。也不要复制 OpenWiki 的整套 Ink App；对本项目而言，先做一个薄的状态/输入适配器即可，只有实际需要全屏布局、滚动 pane 或并行树视图时才引入更重的 TUI 框架。

## 与现有一次性 `run()` 的关系

当前 `wiki_run.py` 在一次 `Agent.run()` 中等待最终结果（[wiki_run.py](../../src/okf_wiki/wiki_run.py#L447-L505)）。因此“加 TUI”不只是换输出格式：若要显示模型/工具/递归状态，需要在不破坏 output validator、usage limits、wall-clock deadline 和 publication 流程的前提下增加事件观察 seam。最小安全顺序是先抽出内部事件回调，再接 TUI；不要把 UI 状态机塞回语义 workflow 或 Host 的发布逻辑。

## 资料

- [OpenWiki README](https://github.com/langchain-ai/openwiki/blob/ddd1f609b23d83b96a800ea0f4d47e7d28a78c7d/README.md#L62-L77)
- [OpenWiki package.json](https://github.com/langchain-ai/openwiki/blob/ddd1f609b23d83b96a800ea0f4d7e7d28a78c7d/package.json#L43-L58)
- [OpenWiki CLI source](https://github.com/langchain-ai/openwiki/blob/ddd1f609b23d83b96a800ea0f4d47e7d28a78c7d/src/cli.tsx#L1-L4)
- [Pydantic AI CLI documentation](https://ai.pydantic.dev/cli/)
- [Pydantic AI streamed output documentation](https://ai.pydantic.dev/output/#streamed-results)
