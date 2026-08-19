# Durable Board and Postgres Catalog

日期：2026-08-19

## 范围

对照三份一手材料，决定 Wiki Run 的任务状态和表结构证据放在哪里：

- Anthropic [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Amp [Todos are done](https://ampcode.com/news/todos-are-done)、[How I use Amp](https://ampcode.com/notes/how-i-use-amp)

## 结论

1. **目标与剩余工作必须在会话外。** Anthropic 把长程任务拆成 compaction、structured note-taking、sub-agent。Claude Code 的 TodoWrite 是会话内清单；compaction 之后不能当真相。长程 harness 用 `claude-progress.txt` 这类文件，新窗口先读进度再动手。Wiki Run 会 compaction，也会跨进程 resume，所以 Board 是 host 文件，不是 tool-result details。
2. **Amp 删掉 in-thread todo 不适用于本仓库。** 他们面对的是单线程、新模型自己能盯进度。Wiki 的 Lead 会被摘要，还会 pause/resume。Pi 官方 `todo.ts` 把状态放进 session entry 是为了 branch 一致，compaction 之后模型看不见那些 details。
3. **表结构按需取，不预载。** Anthropic 的 JIT retrieval 和 Amp 用 `psql`/`\\d` 现场看 schema 是同一条：名字可以先列，列/键/注释只在当前页面需要时再取。本仓库只支持 Postgres，连接串和 schema 写在 Workspace 上；表名模糊匹配，省略则允许该 schema 下全部表，但 prompt 里不倾倒 DDL。
