# OKF Wiki

OKF Wiki 是一个 OKF Knowledge Bundle Producer：它从一个或多个 Git 仓库的固定提交中生成可审计的 Knowledge Bundle。它只读取源仓库，支持 Java 与 Markdown，记录 Coverage Obligation、证据、Run Event 和审核结果，并在人工批准后原子发布。

## 环境准备

需要：

- Python 3.14
- [uv](https://docs.astral.sh/uv/)
- Git

安装锁定版本的依赖：

```bash
uv sync --locked
uv run --locked okf-wiki --help
```

所有运行状态都保存在当前工作目录的 `.okf-wiki/` 中。`build`、`status`、`explore`、`check`、`review`、`cancel` 和 `recover` 应在同一工作目录执行。

## 配置项目

创建 `project.toml`。单仓库配置示例：

```toml
project_id = "example"
repository = "../example-service"
revision = "0123456789abcdef0123456789abcdef01234567"
publish_dir = "published"
```

`revision` 必须是源仓库中存在的精确 Git 提交。相对的 `repository` 和 `publish_dir` 路径以配置文件所在目录为基准。

需要组合多个仓库时，使用 `sources`：

```toml
project_id = "example"
publish_dir = "published"

[[sources]]
id = "implementation"
role = "implementation"
repository = "../example-service"
revision = "0123456789abcdef0123456789abcdef01234567"

[[sources]]
id = "requirements"
role = "requirements"
repository = "../example-requirements"
revision = "89abcdef0123456789abcdef0123456789abcdef"
```

每个 `sources.id` 必须唯一。可用下面的命令取得当前提交：

```bash
git -C ../example-service rev-parse HEAD
```

### 覆盖策略

默认策略将发现的 Major 和 Supporting Coverage Obligation 标记为 `covered`，但会排除 `generated/**`、`vendor/**`、`**/generated/**`、`**/generated-sources/**` 和 `**/vendor/**` 下的 Java 文件。如果希望交给语义分析 Agent 处理，可显式设为 `open`：

```toml
[profile.dispositions.major]
disposition = "open"

[profile.dispositions.supporting]
disposition = "open"
```

也可以排除或推迟覆盖义务，但必须给出原因；`deferred` 仅适用于 Supporting：

```toml
[profile.dispositions.supporting]
disposition = "deferred"
reason = "本次发布暂不处理补充材料。"
```

## 运行流程

先创建 Production Run：

```bash
uv run --locked okf-wiki build project.toml
```

命令输出 JSON，其中包含 `run_id` 和当前 `state`。如果存在 `open` 覆盖义务，`build` 会以非零状态退出，但 Run 已经创建，状态为 `exploring`；这是需要继续执行语义分析的正常信号。

复制输出中的 `run_id`，后续命令以 `RUN_ID` 代指它：

```bash
uv run --locked okf-wiki status RUN_ID
```

如果状态为 `exploring`，先配置兼容 OpenAI API 的企业网关：

```bash
export OKF_GATEWAY_BASE_URL="https://gateway.example.com/v1"
export OKF_GATEWAY_API_KEY="..."
export OKF_GATEWAY_MODEL="..."

uv run --locked okf-wiki explore RUN_ID
```

可选网关参数：

```bash
export OKF_GATEWAY_ID="enterprise"
export OKF_GATEWAY_CONCURRENCY="4"
export OKF_GATEWAY_HEADERS='{"X-Tenant":"example"}'
```

Run 到达 `review_required` 后，先检查再审核：

```bash
uv run --locked okf-wiki check RUN_ID
uv run --locked okf-wiki review RUN_ID --approve
```

批准后知识包发布到 `publish_dir`。发布目录是指向不可变版本目录的符号链接，后续使用新 revision 再次 `build` 即可生成增量刷新 Run。

如需拒绝本次审核并重新分析：

```bash
uv run --locked okf-wiki review RUN_ID --reject
```

拒绝会把已处理的覆盖义务重新打开，并将 Run 返回 `exploring`。

## 检查与恢复

`check` 既可以检查 Run，也可以直接检查已发布的知识包目录：

```bash
uv run --locked okf-wiki check RUN_ID
uv run --locked okf-wiki check published
```

取消非终态 Run，或恢复中断中的任务和发布流程：

```bash
uv run --locked okf-wiki cancel RUN_ID
uv run --locked okf-wiki recover RUN_ID
```

`failed` 和 `cancelled` 是终态，不能恢复。

## 评估与基准

运行 Agent 角色与轨迹评估：

```bash
uv run --locked okf-wiki eval path/to/agent-eval-manifest.json
```

运行仓库内置的版本化发布基准：

```bash
uv run --locked okf-wiki benchmark \
  src/okf_wiki/benchmark_corpus/v1/release-manifest.json
```

已提交的基准报告位于 `src/okf_wiki/benchmark_corpus/v1/release-report.json`。

## 开发验证

```bash
uv lock --check
uv sync --locked
uv run --locked pytest
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked ty check src tests
```

需要真实企业网关凭据的测试默认跳过；未配置凭据时，不代表已经验证了实时网关兼容性。
