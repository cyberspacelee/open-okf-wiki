# Claude Code、Codex、Pi 与 Gemini CLI 的 CWD / Workspace 路径约定研究

日期：2026-08-25

## 范围与证据边界

本文对比 Claude Code、Codex、Pi coding agent 与 Gemini CLI 如何处理：

1. session 的 `cwd` 与 project/workspace root；
2. 文件工具的绝对/相对路径输入；
3. `grep`、`find`、`ls` 等工具的输出路径；
4. 子代理的 cwd 继承和隔离；
5. Windows、符号链接 / junction 对 Workspace 的影响。

只使用一手资料：Anthropic 官方文档、OpenAI 官方文档、`earendil-works/pi` 与 `google-gemini/gemini-cli` 官方源码，以及 Node.js 官方文档。Pi 结论固定到本仓库使用的 `@earendil-works/pi-coding-agent 0.82.1` 对应提交 `b4f293684bba718d59cc1157679bcf6157b3a7f5`。Claude Code 的公开仓库没有 CLI 核心源码，因此其内部路径解析算法只能依据官方行为文档，不能声称已从源码验证。[Claude Code 官方仓库](https://github.com/anthropics/claude-code) [许可证](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)

证据分为两类：

- **实现 / 契约事实**：官方文档或固定版本源码直接规定。
- **工程推断**：把这些事实映射到本项目的多 Source Workspace 后得出的设计结论。

## 结论

1. **成熟 coding agent 会显式确定 session cwd，而不是让各工具猜。** Claude Code、Codex 和 Gemini CLI 都从一个真实工作目录启动，再显式增加额外授权目录；Pi 把显式 `cwd` 注入 session、resource loader 和每个内置工具。[Claude working directories](https://code.claude.com/docs/en/permissions#working-directories) [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) [Gemini CLI directories](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md#directory-or-dir) [Pi SDK](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/sdk.md#L116-L149)
2. **文件工具应有一个明确、单义的路径坐标系。** Claude Code 的 `Read` / `Edit` / `Write.file_path` 契约是宿主绝对路径；Pi 接受宿主绝对路径或相对 session cwd 的路径。没有一个产品把单前导 `/repo/...` 定义为“当前 Workspace 根路径”。[Claude tool schemas](https://code.claude.com/docs/en/hooks) [Pi read schema](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/read.ts#L20-L24)
3. **Pi 原生工具输出不是统一 Workspace-relative。** `grep` 和 `find` 返回相对“本次搜索目录”的路径，`ls` 只返回 entry basename；这在普通单仓库交互中简洁，但在多 Source Workspace 中不能稳定作为下一次 `read` 的输入。[Pi grep](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/grep.ts#L178-L198) [Pi find](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/find.ts#L182-L188) [Pi ls](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/ls.ts#L149-L170)
4. **子代理 cwd 应在创建时显式决定，不应依赖共享 `chdir()`。** Claude 普通 subagent 从主会话当时的 cwd 启动，之后其 `cd` 不跨 shell tool call 持久化；Pi 官方 subagent 示例把 `cwd ?? defaultCwd` 直接传给子进程的 `spawn`。[Claude subagent](https://code.claude.com/docs/en/sub-agents) [Pi subagent](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/index.ts#L267-L339)
5. **对本项目，不需要虚拟 Workspace。** 真实 Workspace root 就应是 Lead 和所有 worker session 的 cwd；Source junction / symlink 是该 cwd 下的真实目录。模型可见的唯一输入 / 输出格式应为 POSIX Workspace-cwd-relative、无前导斜杠，例如 `repo-name/src/main.ts`；宿主绝对路径只存在于工具执行内部。`/repo-name/...` 应直接拒绝并提示 canonical 路径。

## 1. Claude Code

### 1.1 Project root、cwd 与额外目录

**事实：** Claude Code 默认访问启动目录中的文件。`--add-dir`、`/add-dir` 和 `permissions.additionalDirectories` 可以扩展可访问目录；要改变 session 的主 cwd，应使用 `/cd`。额外目录首先是访问授权，不等同于迁移主 cwd。[Working directories](https://code.claude.com/docs/en/permissions#working-directories)

**事实：** Claude Code 对 hook 暴露两个不同锚点：`${CLAUDE_PROJECT_DIR}` 保持 session 启动时的 project root；hook JSON 中的 `cwd` 会随进入 worktree 或执行 `cd` 改变。[Worktree hooks](https://code.claude.com/docs/en/worktrees#worktrees-and-hooks)

**事实：** Bash 每次调用是独立进程。主会话内 `cd` 的结果可延续到后续 Bash 调用，但只允许停留在 project 或已加入的 additional directory；越界会 reset。subagent 不延续 `cd`。[Bash tool behavior](https://code.claude.com/docs/en/tools-reference#bash-tool-behavior)

**工程推断：** agent harness 至少需要两个不同字段：

- `projectRoot`：稳定的信任、配置、session 和仓库身份锚点；
- `cwd`：当前执行位置，可能随 session 或隔离环境变化。

它们可以初始相同，但不应复用一个变量表达两个概念。

### 1.2 文件工具路径

**事实：** Claude Code 官方 tool input schema 将 `Write.file_path`、`Edit.file_path` 和 `Read.file_path` 都定义为绝对路径；`Glob.path` 可省略并默认当前 cwd，`Grep.path` 是可选文件或目录。[Tool input schemas](https://code.claude.com/docs/en/hooks#pretooluse-input)

**事实：** Windows 上 hook 收到的 `file_path` 是形如 `C:\project\src\index.ts` 的宿主绝对路径；官方建议 hook 在比较前先统一分隔符。[Hook Windows paths](https://code.claude.com/docs/en/hooks#write-edit-tool-input)

**事实：** Claude permission rule 的路径语法是另一个 DSL：`//path` 才从文件系统根开始，`/path` 相对 settings source，`path` / `./path` 相对当前目录。这个语义只属于权限规则，不能套到文件工具的 `file_path`。[Read and Edit rules](https://code.claude.com/docs/en/permissions#read-and-edit)

**工程推断：** Claude 的绝对路径契约适合“模型直接看到真实单机文件系统”的产品，但不适合本项目直接照搬，因为：

- Windows drive、UNC、Linux mount path 不具备跨平台稳定性；
- host absolute path 会泄露实现细节，且可被模型复用到 handoff / required-read / citation；
- 多 Source Workspace 中需要稳定区分 `repo-a/...` 与 `repo-b/...`，而不是依赖某台机器的挂载位置。

### 1.3 子代理和隔离

**事实：** 普通 subagent 从主会话创建它时的当前 cwd 启动；subagent 内 `cd` 不跨 Bash / PowerShell tool call 持久化，也不影响主会话 cwd。[Subagent working directory](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields)

**事实：** `isolation: worktree` 时，subagent 的 shell 在专属 worktree 中执行；Claude Code 还会拒绝 cwd 解析到主 checkout 或无法证明留在 worktree 的命令。[Worktree isolation](https://code.claude.com/docs/en/worktrees#how-claude-code-enforces-isolation)

**工程推断：** 并行 agent 不应共享可变 cwd。每个 worker 在创建时得到不可变的 filesystem view / cwd；需要隔离写入时用 worktree 或独立 Candidate root，而不是让多个 worker 调用全局 `process.chdir()`。

## 2. Codex

### 2.1 启动 cwd 与额外目录

**事实：** Codex CLI 用 `--cd` / `-C` 在请求开始前设置工作目录，用 `--add-dir` 增加工作区之外的可写目录；两者是不同概念。官方安全建议也优先使用额外目录授权，而不是放宽整个 sandbox。[Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

**事实：** Codex 从 project root 向当前 cwd 逐层发现 `AGENTS.md`，因此 cwd 同时影响工具相对路径和项目指令作用域。[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

### 2.2 子代理继承运行环境

**事实：** Codex subagent 继承父会话当前生效的 sandbox 与运行时覆盖；subagent 配置没有另设一套虚拟路径根。需要不同目录时，应由 orchestrator 在创建会话或执行命令时明确指定真实 cwd / 授权目录。[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

**工程推断：** Codex 的做法同样把“工作目录”和“额外授权目录”分开，没有给 `/repo-name/...` 增加 Workspace-relative 特殊语义。本项目应让所有阶段共享稳定的真实 Workspace cwd，并把阶段可见性留给工具 guard。

## 3. Pi coding agent 0.82.1

### 3.1 Session cwd 是显式依赖

**事实：** `createAgentSession()` 的 cwd 优先级是 `options.cwd`、`sessionManager.getCwd()`、`process.cwd()`，随后通过 `resolvePath` 变成宿主绝对路径。该 cwd 同时用于 settings、session、resource loader 和 AgentSession。[SDK implementation](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/sdk.ts#L169-L183) [AgentSession construction](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/sdk.ts#L376-L389)

**事实：** Pi SDK 文档明确说明：`cwd` 控制 project extensions、skills、prompts、`AGENTS.md`、session directory naming，也影响 tool path resolution；传 custom resource loader 后，资源发现可以解耦，但 session naming 和工具路径仍受 cwd 影响。[SDK directories](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/sdk.md#L330-L365)

**事实：** Pi 会把当前 cwd 明文加入 system prompt；自定义 cwd 会在构造 built-in tools 时传入各 tool factory。[System prompt](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/system-prompt.ts#L144-L160) [Tool factories](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/index.ts#L96-L132)

### 3.2 输入路径按宿主 OS 解析

**事实：** Pi 的 `read`、`write`、`edit` schema 都允许 relative or absolute path；`grep`、`find`、`ls` 的 path 可省略，省略时默认 `.`。[Read](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/read.ts#L20-L24) [Write](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/write.ts#L14-L17) [Edit](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/edit.ts#L44-L53) [Search schemas](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/grep.ts#L24-L36)

**事实：** 所有这些工具最终调用同一个 `resolveToCwd(filePath, cwd)`；它进一步调用 native `node:path.isAbsolute` / `resolve`：绝对输入忽略 cwd，相对输入拼到 cwd。[Pi path resolver](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/path-utils.ts#L44-L50) [Pi generic resolver](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/utils/paths.ts#L81-L85)

**事实：** Node 的默认 `path` 行为随宿主 OS 变化；Windows 上使用 Windows path 语义。`path.isAbsolute()` 只是句法判断，官方明确说它不能用于防 path traversal；`path.resolve()` 从右到左处理，遇到绝对段后会丢弃左侧 cwd。[Node path: Windows vs POSIX](https://nodejs.org/api/path.html#windows-vs-posix) [Node `path.isAbsolute`](https://nodejs.org/api/path.html#pathisabsolutepath) [Node `path.resolve`](https://nodejs.org/api/path.html#pathresolvepaths)

**工程推断：** `/repo-name/` 不是 Pi 定义的虚拟 Workspace 路径。它进入 native resolver 后，在 POSIX 是 filesystem-root absolute path；在 Windows 是当前 drive 根路径语义，而不是 `C:\workspace\repo-name`。因此把它直接传给 Pi，再在外层校验“必须位于 Workspace root”，会稳定失败；junction / symlink 的真实目标尚未参与校验，问题已经发生在词法解析阶段。

### 3.3 输出路径的坐标系并不统一

**事实：** `grep` 先把搜索 path 解析为绝对 `searchPath`，但结果文件名用 `path.relative(searchPath, filePath)`，即相对搜索根输出；搜索单文件时只输出 basename。[Grep output](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/grep.ts#L178-L198)

**事实：** `find` 的 description 明示“relative to the search directory”，实现也把结果相对 `searchPath` 后转为 `/` 分隔。[Find contract](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/find.ts#L109-L119) [Find output](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/find.ts#L182-L188)

**事实：** `ls` 输出当前目录下的 bare entry name，只给目录追加 `/`，不会带搜索 root 或 session cwd。[Ls output](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/ls.ts#L149-L180)

**事实：** `write` / `edit` 内部使用解析后的宿主 absolute path 执行 I/O，但成功消息回显模型原始传入的 `path`；错误路径有些分支回显解析后的绝对路径。因此原生 Pi 没有“输出都 canonical relative”或“输出都 absolute”的统一保证。[Write](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/write.ts#L194-L224) [Edit](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/edit.ts#L308-L360) [Ls errors](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/tools/ls.ts#L122-L145)

**工程推断：** 如果 wrapper 只改输入映射、不重写输出，模型会拿到三种互不兼容的路径：搜索根相对、原始输入、宿主绝对。`grep repo-name` 返回 `src/main.ts` 后，下一次 `read src/main.ts` 会从 Workspace cwd 解析而不是从 `repo-name` 解析；这不是 prompt 能可靠补救的协议缺口。

### 3.4 Pi 官方 subagent 示例

**事实：** Pi core 不内置统一 subagent cwd policy；官方 extension 示例为每个 task 暴露可选 `cwd`，创建 child `pi --mode json` 时显式使用 `cwd ?? defaultCwd`。[Subagent schema](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/index.ts#L431-L458) [Child spawn](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/index.ts#L267-L339)

**事实：** 父 extension 在 chain / parallel 模式传入 `ctx.cwd` 作为 default cwd，并允许 task 自己覆盖。[Chain](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/index.ts#L530-L563) [Parallel](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/examples/extensions/subagent/index.ts#L624-L641)

**工程推断：** 本项目不应让模型自由选择 worker 的宿主 cwd。orchestrator 应始终传真实 Workspace root，再根据 task role 和 Source ownership 限制工具可访问的真实目录；模型只交换 canonical Workspace-relative path。

## 4. Gemini CLI（补充交叉验证）

**事实：** Gemini CLI 的 `/directory add` 接受相对当前 cwd 或宿主绝对路径的真实目录；文件注入也只在当前 cwd 与显式 Workspace directories 中查找，不定义单前导 `/name` 为 Workspace-relative alias。[Directory command](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md#directory-or-dir) [File injection](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/custom-commands.md#4-injecting-file-content-with)

**工程推断：** Gemini 再次印证了共同模式：真实 cwd 加显式附加目录，而不是一套模型专用的虚拟根路径。

## 5. 对比表

| 维度 | Claude Code | Codex | Pi 0.82.1 | Gemini CLI | 对本项目的含义 |
| --- | --- | --- | --- | --- | --- |
| 主 cwd | 启动目录；session 可 `/cd` | 启动目录；可用 `--cd` | 显式 `options.cwd`，否则逐级回退 | 启动 cwd | run 显式固定为真实 Workspace root |
| 额外目录 | `--add-dir` / 配置授权 | `--add-dir` 授权 | 调用方自定义 tools / loader | `/directory add` | 授权与 cwd 分开建模 |
| 文件输入 | 工具契约使用宿主绝对路径 | 位于 cwd / 授权目录内 | 宿主绝对或 cwd-relative | cwd / Workspace directories | 本项目对模型统一为 Workspace-relative |
| Search 输出 | 未公开完整格式保证 | 未公开完整格式保证 | grep/find 相对搜索 root，ls 为 basename | 不作为本项目 Pi wrapper 的契约 | wrapper 输出完整 Workspace-relative path |
| 子代理 cwd | 创建时继承；自身 `cd` 不持久化 | 继承当前运行环境 | 示例显式传 `cwd` | 无关本项目 runtime | 所有阶段使用同一稳定 cwd，权限由 guard 区分 |
| Windows | 工具使用宿主绝对路径 | 服从宿主 filesystem / sandbox | native `node:path` 语义 | 接受宿主真实路径 | `/repo/...` 不能先交 native resolver |

## 6. 修复前根因与实施状态

1. **cwd 已经正确统一。** Lead 在 `producer.ts`、所有 worker 在 `subagent.ts` 都把 `plan.workspaceRoot` / `guard.workspaceRoot` 传给 `runWikiSession()`；后者又把同一值传给 Pi resource loader、session manager 和 `createAgentSession()`。不需要改变 session 拓扑。
2. **Source 已经是真实 cwd 子目录。** `workspace.ts` 在 `<workspaceRoot>/<source-name>` 创建 POSIX directory symlink 或 Windows junction。模型使用 `repo-name/...` 时，Pi 从 Workspace cwd 可以直接访问 Source 内容。
3. **原输入归一化顺序是根因。** `resolveToolPath()` 曾先执行 native `path.resolve(workspaceRoot, input)`；所以 `/repo-name/...` 会先成为宿主 absolute path，再被 Workspace containment 拒绝。现已改为先验证 canonical POSIX Workspace-relative 语法，再映射为 native path。
4. **原输出会换坐标系。** Pi 的 grep/find/ls 结果不是 Workspace-relative，曾造成 `grep repo-name` 后 `read src/file` 失败。wrapper 现已把 search/list 结果重写为可直接交给 read 的完整 Workspace-relative path。
5. **原 read guard 过宽。** worker 曾共享所有 pinned Sources、Candidate 和 handoffs。现由 runtime guard 执行阶段矩阵；synthesize 保留全部 pinned Sources，其他阶段按任务收紧。
6. **`wiki/...` 是唯一必要的逻辑映射。** 它把发布路径映射到 unpublished Candidate，服务于原子发布；这是工具层的目标重写，不是虚拟 Workspace，也不应扩展成通用 mount framework。

## 7. 推荐给本项目的路径契约

以下是工程推断，不是 Claude 或 Pi 的现成 API。

### 7.1 模型可见格式

只输出一种 canonical Workspace-relative path：

```text
repo-name/src/main.ts
wiki/domain/page.md
.okf-wiki/run/handoffs/survey-abcd.md
```

规则：

- POSIX `/` 分隔；
- 相对 Workspace root；
- 无前导 `/`、无 drive、无 UNC、无嵌入的 `.` / `..` 段；精确的 `.` 仅表示 Workspace root；
- 保留 manifest 中声明的 Source 大小写；
- directory root 使用 `repo-name`、`wiki`，不靠尾部 `/` 区分身份。

`/repo-name/...` 应在 tool 输入边界拒绝并返回 `Use Workspace-relative path: repo-name/...`；不能交给 `node:path.resolve`，也不应长期维护第二种等价输入。所有 tool output、错误、activity、required-read、handoff 和 citation 一律使用 canonical Workspace-relative path。

### 7.2 内部解析顺序

```text
model Workspace-relative path
  -> parse canonical POSIX relative path
  -> select allowed mount by role/task
  -> lexical containment inside that logical mount
  -> map logical mount to its declared native Source/Candidate/Handoff root
  -> join native mount root + relative suffix
  -> realpath native mount root and nearest existing target ancestor
  -> physical containment inside that authorized mount root
  -> execute Pi operation
  -> map every returned path back to canonical Workspace-relative path
```

安全判断必须同时保留 logical lexical containment 与 mount-relative physical containment。Node 官方明确说 `path.isAbsolute` 不是 traversal 防护；而只做 lexical containment 又无法识别 symlink / junction 逃逸。[Node `path.isAbsolute`](https://nodejs.org/api/path.html#pathisabsolutepath)

Windows junction 的关键是 **authorized mount root**：`<workspace>\repo-name` 可以是指向其他磁盘位置的 junction。`realpath(<workspace>\repo-name)` 逃出物理 Workspace root 是正常挂载结果，不应拒绝；应把该 realpath 记为 `repo-name` 的授权 Source 根，再检查 `repo-name/...` 的目标 realpath 是否仍在这个 Source 根内。Source 内部若再有 junction 指向未授权位置，则应拒绝。POSIX symlink mount 使用同一规则。

### 7.3 Search / list 的关键要求

- `grep path=repo-name` 命中必须输出 `repo-name/src/main.ts:42:...`，不能输出 `src/main.ts:42:...`。
- `find path=repo-name/src pattern=*.ts` 必须输出 `repo-name/src/main.ts`。
- `ls path=repo-name/src` 必须输出 `repo-name/src/main.ts`、`repo-name/src/lib`。
- 空 path 只有在 worker 视图存在唯一无歧义 read root 时才允许；多 Source worker 必须显式传 path。
- tool schema description、prompt、status formatter 与 runtime validation 必须来自同一规则，不能 schema 说默认 `.`、wrapper 又拒绝。

### 7.4 各阶段 cwd / 可见性

Lead、survey、synthesize、writer、review 都使用同一个真实 Workspace root 作为不可变 session cwd。允许读取哪些 Source、Candidate 和 handoff 由 task role 决定；cwd 只是 shell/process 执行位置，不应被当作授权边界。prompt 只告诉 agent 可用的 canonical roots，真正 read/write 权限由 resolver enforce。

| 阶段 | Sources | Candidate（模型路径 `wiki/...`） | Required handoffs |
| --- | --- | --- | --- |
| Lead | 不可读 | 只读 | 只读当前 Run 的 host-owned handoffs |
| survey | 仅 assigned Source | 不可读 | 无 |
| synthesize | 全部 pinned Sources | 不可读 | 只读全部 survey handoffs |
| writer | owner Source；`wiki-root` 可读全部 | 读；仅 assigned target 可写 | 只读任务 manifest 声明项 |
| review | 全部 pinned Sources | 只读 frozen Candidate | 只读任务 manifest 声明项 |

这同时吸收两边的优点：采用 Claude 的 project-root / cwd 分离、显式 subagent inheritance 和隔离思想；采用 Pi 的显式 cwd 注入和统一 tool factory seam；避开 Claude 的 host absolute path 泄露与 Pi 的 search-root-relative 输出。

## 8. 验证清单

实现至少应有以下跨平台 contract tests：

1. POSIX、Windows drive、UNC absolute path 不会被误认成 Workspace-relative path。
2. `/repo-name/a.ts` 被拒绝并提示 `repo-name/a.ts`；所有成功调用只接受 / 返回后一种格式。
3. Windows junction 与 POSIX symlink 指向允许 Source 时可读，指向 view 外时拒绝。
4. `read`、`grep`、`find`、`ls`、`write`、`edit` 的输出和错误都不包含 host absolute path。
5. search 在任意子目录执行，返回结果都可原样交给 `read`。
6. 每种 worker role 的 Source / Candidate / handoff visibility 有一张可执行矩阵。
7. 子代理并行运行时 cwd 不互相影响，父 session cwd 不被 worker 改变。
