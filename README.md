# OKF Wiki

OKF Wiki 是一个 OKF Knowledge Bundle Producer：它把一个产品或项目的多个 Git 仓库固定到精确提交，生成可审计的 Knowledge Bundle。确定性控制平面负责 Source 范围、Coverage Obligation、证据验收、审核和发布；Agent 只能提出语义结果，不能直接改变权威知识。

## 安装与启动

仓库开发需要 Python 3.14、[uv](https://docs.astral.sh/uv/) 和 Git：

```bash
uv sync --locked
uv run --locked okf-wiki --help
```

初始化一个 Workspace 并启动本地 Console：

```bash
uv run --locked okf-wiki workspace init catalog --name "Catalog" --root ./catalog-wiki
uv run --locked okf-wiki workspace console ./catalog-wiki
```

Workspace Console 只绑定 loopback，由 Python 进程提供 API 和已构建的静态页面。安装后的日常使用不需要 Node、Bun、CDN 或单独的 JavaScript 服务。

## Workspace 配置范围

一个 Workspace 代表一个产品或项目，只生成一个 Knowledge Bundle；不同产品、受众或发布边界应使用不同 Workspace。Workspace 可以组合任意多个 `implementation`、`documentation`、`requirements` 和 `contract` Source。

- `workspace.toml` 是可共享的 Workspace Definition：产品身份、Sources、revision policy、Producer Profile 和发布意图。
- `.okf-wiki/settings.toml` 是本机设置：checkout 路径、Gateway Profile 选择、模型、预算和 UI 偏好。
- `.okf-wiki/runs.db` 和其他 `.okf-wiki/` 内容是本地运行状态，不是共享配置。

`workspace init` 创建最小配置。随后可在 Console 中编辑，也可直接编辑 `workspace.toml`：

```toml
schema_version = 1

[project]
id = "catalog"
name = "Catalog"

[publication]
path = "published"
bundle_name = "Catalog Knowledge"

[[sources]]
id = "code"
role = "implementation"
revision = "main"
revision_policy = "follow_branch"
remote = "git@github.com:example/catalog.git"

[[sources]]
id = "docs"
role = "documentation"
revision = "main"
revision_policy = "follow_branch"
remote = "git@github.com:example/catalog-docs.git"

[[sources]]
id = "requirements"
role = "requirements"
revision = "0123456789abcdef0123456789abcdef01234567"
revision_policy = "pinned_commit"
remote = "git@github.com:example/catalog-requirements.git"

[[sources]]
id = "contracts"
role = "contract"
revision = "89abcdef0123456789abcdef0123456789abcdef"
revision_policy = "pinned_commit"
remote = "git@github.com:example/catalog-contracts.git"
```

`follow_branch` 会在 Run 前解析分支，`pinned_commit` 必须使用完整 commit ID；无论采用哪种 policy，每个 Production Run 都只读取记录在 Run snapshot 中的精确提交。

## Source Checkout 与 Git 所有权

配置 Source 后，可让 Workspace clone，或绑定已有 checkout：

```bash
uv run --locked okf-wiki workspace clone-configured-source code ./catalog-wiki
uv run --locked okf-wiki workspace clone-configured-source docs ./catalog-wiki
uv run --locked okf-wiki workspace link-configured-source requirements ../catalog-requirements ./catalog-wiki
uv run --locked okf-wiki workspace sources ./catalog-wiki
```

Workspace 管理的 clone 位于 `<workspace>/sources/<source-id>/`；linked checkout 仍由原目录的用户拥有，Workspace 不移动、复制或删除它。clone 和 pull 使用用户已有的 Git 配置、SSH agent 和 credential helper，remote URL 不得内嵌凭据。

```bash
uv run --locked okf-wiki workspace pull-source code ./catalog-wiki
```

pull 遇到 tracked、untracked 或并发变化会失败关闭；工具不会替用户 stash、reset、clean 或覆盖工作树。修改 revision policy 时需使用 `workspace sources` 返回的最新 `configuration_digest`，防止覆盖并发配置更新。

## Gateway Profile 与凭据

Gateway Profile 是可复用的本机 LLM 连接，不属于 `workspace.toml`。它保存 endpoint、非秘密 header、能力测试结果和凭据引用；Workspace 只选择 Profile、模型、并发和预算。Profile registry 默认位于 `$XDG_CONFIG_HOME/okf-wiki`，未设置 XDG 时位于 `~/.config/okf-wiki`。

```bash
read -rsp "Gateway credential: " GATEWAY_CREDENTIAL
printf '\n'
printf '%s' "$GATEWAY_CREDENTIAL" | uv run --locked okf-wiki gateway save enterprise \
  --name "Enterprise Gateway" \
  --gateway-id corp-openai \
  --base-url https://gateway.example.com/v1 \
  --header X-Tenant=catalog \
  --credential-stdin
unset GATEWAY_CREDENTIAL

uv run --locked okf-wiki gateway test enterprise --model model-a
uv run --locked okf-wiki gateway select ./catalog-wiki enterprise --model model-a
```

凭据优先进入操作系统 credential store；不可用时才写入权限为 `0700/0600` 的本地 fallback。凭据和配置 header 值不会进入 Workspace Definition、Run snapshot、prompt、trace 或 Bundle，CLI/API 也只返回是否已配置及 header 名称。

执行 capability test、Production Run、Knowledge Query 或 Source Investigation 时，请求会发往 Profile 配置的 `base_url`，并携带该凭据和配置 header；这就是模型数据的外发边界。非 loopback endpoint 必须使用 HTTPS，capability test 拒绝 redirect，保存 Profile 前应确认 endpoint 属于可信 Gateway。Source Investigation 复用 Query Agent 的模型分配，不增加第二套连接配置。

## 权威知识与 provisional 调查

- Workspace Console 是确定性控制平面的适配器，不直接拥有状态，也不是 Markdown 编辑器。
- Production Run 从固定 Source Snapshots 生成候选知识；只有确定性验证和所需人工审核通过后，Accepted Knowledge Model 才能发布为 Bundle。
- Knowledge Query 只读取固定的 Accepted Knowledge Model，并返回 Claim 与 Evidence Reference；证据不足时明确返回 insufficient support。
- Source Investigation 是用户另行发起的只读调查，只能读取同一 Run 的固定 Source Snapshots。结果带精确 source、revision、path、span 和 digest，并始终标记为 provisional。
- Source Investigation 不能关闭 Coverage Obligation、改变审核、写入 Accepted Knowledge Model 或发布 Bundle。调查结论只有经过后续正常 Production Run、验证和审核，才可能成为权威知识。

## 不使用 Console 的 CLI 流程

CLI 与 HTTP adapter 都调用同一个 `WorkspaceApplication`。现有契约测试覆盖 settings、Sources、pull/revision/preflight、Run 创建与状态、review、cancel/recover 以及权威 domain error 的一致性。

完成前面的 Workspace、Source 和 Gateway 配置后，先运行 preflight，并从 JSON 输出复制两个 digest：

```bash
uv run --locked okf-wiki workspace preflight ./catalog-wiki
uv run --locked okf-wiki workspace start-run ./catalog-wiki \
  --configuration-digest CONFIGURATION_DIGEST \
  --source-set-digest SOURCE_SET_DIGEST
uv run --locked okf-wiki workspace run-status RUN_ID ./catalog-wiki
```

Run 到达 `review_required` 后，读取 review snapshot、证据和 staged Bundle，再以最新权威 digest 决策：

```bash
uv run --locked okf-wiki workspace review-snapshot RUN_ID ./catalog-wiki
uv run --locked okf-wiki workspace review-evidence RUN_ID EVIDENCE_ID ./catalog-wiki
uv run --locked okf-wiki workspace review-bundle RUN_ID concepts/example.md ./catalog-wiki
uv run --locked okf-wiki workspace review RUN_ID approve ./catalog-wiki \
  --expected-digest AUTHORITATIVE_DIGEST
```

也可使用 `reject` 退回语义分析。中断或取消命令为：

```bash
uv run --locked okf-wiki workspace recover-run RUN_ID ./catalog-wiki
uv run --locked okf-wiki workspace cancel-run RUN_ID ./catalog-wiki
uv run --locked okf-wiki check ./catalog-wiki/published
```

已发布 Bundle 是普通 Markdown，可直接从 publication path 阅读。当前 CLI 不提供 Knowledge Query 或 Source Investigation 子命令；这两项能力仅通过受 session token 保护的本地 Console HTTP API 使用，因此不能宣称它们已有 CLI/HTTP parity。

旧 `project.toml` 可一次性迁移，新的 Workspace 配置不再使用顶层 `repository`、`revision`、`publish_dir` 或 `models.api_key/base_url/headers`：

```bash
uv run --locked okf-wiki workspace migrate ./legacy/project.toml --root ./catalog-wiki
```

## 评估与基准

`wiki-eval` 默认只运行无凭据、确定性的 CI fixture，并始终返回 `pending_review`：

```bash
uv run --locked okf-wiki wiki-eval .scratch/wiki-eval-fixture
```

真实模型评估必须显式选择 repository manifest。仓库提供的 manifest 只用于源码 checkout：
它通过相对路径引用被 Git 忽略的 `refs/openwiki`、`refs/iwe` 和 `refs/open-knowledge`，因此运行前须确认
这三个 checkout 存在、干净且仍位于 manifest 固定的 commit；它不是安装包的默认 corpus。

```bash
uv run --locked okf-wiki wiki-eval .scratch/wiki-eval-live \
  --model openai:gpt-5-mini \
  --manifest src/okf_wiki/wiki_evaluation_repositories.json
```

未审核的 live 报告也只返回 `pending_review`。按报告中的 case/run 为每次成功输出填写 review JSON，
再用新的输出目录和 `--review` 重跑；每条 review 必须包含 factual grounding、citation quality、
unsupported statement count、useful coverage、page organization 和 reader usefulness。只有完整 live review
才能产生 `retain_single_agent` 或 `open_capability_ticket` 决策。

```json
{
  "schema_version": "wiki-evaluation-review-v1",
  "reviews": [
    {
      "case": "openwiki",
      "repeat": 1,
      "factual_grounding": 1.0,
      "citation_quality": 1.0,
      "unsupported_statement_count": 0,
      "useful_coverage": 0.9,
      "page_organization": 0.9,
      "reader_usefulness": 0.9
    }
  ]
}
```

运行 Agent 角色与轨迹评估：

```bash
uv run --locked okf-wiki eval path/to/agent-eval-manifest.json
```

运行仓库内置的版本化发布基准：

```bash
uv run --locked okf-wiki benchmark \
  src/okf_wiki/benchmark_corpus/v1/release-manifest.json
```

已提交的基准报告位于 `src/okf_wiki/benchmark_corpus/v1/release-report.json`。Query Agent 或 Source Investigation Agent 的具体 metric/trajectory 失败会成为 release report 的阻断项。

## 开发验证

```bash
uv lock --check
uv sync --locked
uv run --locked pytest
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked ty check src tests
```

需要真实企业 Gateway 凭据的测试默认跳过；未配置凭据时，不代表已经验证实时 Gateway 兼容性。
