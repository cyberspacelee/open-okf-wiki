# OKF Knowledge Bundle Producer 开发工具指导

核验日期：2026-07-11。仅使用项目官方文档、官方仓库和包元数据。

## 结论

- **MVP 不做前端。** 现有范围已经由 `build`、`status`、`check`、`review --approve/--reject` 完成 Review Mode；用 Markdown/JSON review report 展示 Coverage、Claim/Concept 变更和 Verification Findings 即可。Web UI 只在多人并发审核、权限流或 CLI 审核耗时成为实测瓶颈后再加。
- **开发期允许检索 PydanticAI Web 文档。** Web 检索只用于工程人员查官方资料，不等于给 Producer Agent 开放 Web Enrichment；后者仍不在 MVP 范围。
- **基线：Python 3.14 + uv + Ruff；ty 只作辅助信号。** `uv.lock`、测试、Ruff lint 和 Ruff format 可作为 CI hard gate；ty 0.0.x 暂不作为 required gate。

## PydanticAI 2.8：如何查文档和源码

1. 用 [Pydantic AI 官方文档](https://pydantic.dev/docs/ai/overview/)做概念发现和站内搜索；旧域名 `ai.pydantic.dev` 当前会转到统一的 Pydantic 文档站。在线站点会继续更新，不能单独证明 2.8 行为。
2. Agent 可读入口是官方 [`llms.txt`](https://pydantic.dev/docs/ai/llms.txt)和 [`llms-full.txt`](https://pydantic.dev/docs/ai/llms-full.txt)，但它们同样代表 rolling/latest。
3. 实现或评审 2.8 API 时，以官方仓库的 [`v2.8.0` tag](https://github.com/pydantic/pydantic-ai/tree/v2.8.0)为准：优先读该 tag 下的 [`docs/`](https://github.com/pydantic/pydantic-ai/tree/v2.8.0/docs)，有歧义再定位同一 tag 的[实现](https://github.com/pydantic/pydantic-ai/tree/v2.8.0/pydantic_ai_slim/pydantic_ai)与测试。
4. 升级前读 [`v2.8.0` version policy](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/version-policy.md)、[release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.8.0)和变更说明。V2 承诺 minor release 不故意引入 breaking change，但新增 message/event variant、可选字段和 OTel attributes 变化不算 breaking；beta 模块也不稳定。
5. 依赖声明限制在 2.8 系列并提交 lock，例如 `pydantic-ai==2.8.*`；实际安装版本由 `uv.lock` 固定。当前官方 [PyPI metadata](https://pypi.org/pypi/pydantic-ai/json) 为 2.8.0、Python `>=3.10`、`Production/Stable`。
6. 开发记录应链接到 tag 固定的文档/源码，不链接 `main` 来证明版本行为。对企业 OpenAI-compatible Gateway，还要用项目测试验证所需 tool calling、structured output 和并发能力，不能从“compatible”名称推断完整兼容。

推荐查阅顺序：

```text
官方在线文档搜索 → v2.8.0 docs → v2.8.0 source/tests → release/version policy
```

## uv 与 Python 3.14 工作流

截至核验日，Python 最新 3.14 bugfix release 是 **3.14.6**（[Python release API](https://www.python.org/api/v2/downloads/release/?is_published=true&pre_release=false)）；uv 是 **0.11.28**、PyPI `Production/Stable`（[metadata](https://pypi.org/pypi/uv/json)）。

项目只需这条工作流：

```bash
uv python install 3.14
uv python pin 3.14
uv lock --check
uv sync --locked
uv run --locked pytest
```

- 在 `pyproject.toml` 声明 `requires-python = ">=3.14,<3.15"`，提交 `.python-version`、`pyproject.toml` 和 `uv.lock`。
- `uv.lock` 是跨平台 universal lockfile，应进版本控制；见 [project layout / lockfile](https://docs.astral.sh/uv/concepts/projects/layout/#the-lockfile)。
- 开发者变更依赖后运行 `uv lock`/`uv sync`；CI 用 `uv sync --locked`，锁过期就失败，而不是静默重算。语义见 [locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/)。
- 需要逐补丁完全一致时把 `.python-version` 改为 `3.14.6`；通常固定 3.14 minor、由 CI 安装最新补丁更省维护。Python 安装与 pin 见 [uv Python versions](https://docs.astral.sh/uv/concepts/python-versions/)。
- 不另写 `requirements.txt` 或手工 virtualenv 流程；uv project 已覆盖它们。

## Ruff lint / format

Ruff 当前为 **0.15.21**、PyPI `Production/Stable`（[metadata](https://pypi.org/pypi/ruff/json)）。把 Ruff 固定为 project dev dependency，并在 `pyproject.toml` 集中配置；官方入口见 [linter](https://docs.astral.sh/ruff/linter/)和 [formatter](https://docs.astral.sh/ruff/formatter/)。

本地修复：

```bash
uv run ruff check --fix .
uv run ruff format .
```

CI hard gate：

```bash
uv run --locked ruff check .
uv run --locked ruff format --check .
```

先使用 Ruff 默认规则和少量明确需要的规则；不要在 MVP 建立庞大 lint policy。Ruff 不能代替 pytest、Pydantic trust-boundary validation 或安全测试。

## ty 0.0.x

ty 当前为 **0.0.58**，PyPI classifier 是 `Beta`（[metadata](https://pypi.org/pypi/ty/json)）。官方 [version policy](https://github.com/astral-sh/ty#version-policy)说明 0.0.x 没有稳定 API，任意 release 都可能有 breaking changes。

因此 MVP 建议：

```bash
uv run ty check
```

- 精确 pin 版本；本地运行或放在 non-required CI job 中收集问题。
- **暂不作为 CI hard gate**：工具升级本身可能制造与产品无关的阻塞，且项目正确性主要由 Production Run seam tests、Pydantic runtime validation 和 Ruff 保证。
- 只有当前版本在全仓 clean、误报可接受、团队明确承诺逐版本审查升级后，才可把该精确版本临时设为 required；ty 发布稳定版本后再重新评估默认 hard gate。

## MVP 前端判定

不新增前端 ticket。CLI review 必须能输出人可读报告，并提供 machine-readable status/check 结果；批准/拒绝继续走现有确定性状态机。增加 Web UI 的触发条件是：多人审核与权限、远程服务化、审核队列/协作，或 benchmark 证明 CLI review 明显降低审核质量。PydanticAI 自带/兼容的聊天 UI 也不能替代对 Accepted Knowledge Model、Coverage 和 Findings 的权威审核界面。
