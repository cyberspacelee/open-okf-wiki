# PydanticAI v2.8.0 Worker API contract

核验日期：2026-07-11。

## 范围与版本基线

本文只把以下材料当作版本证据：

- PydanticAI 官方仓库固定 [`v2.8.0` tag](https://github.com/pydantic/pydantic-ai/tree/v2.8.0) 下的 docs、source 和 tests；
- 官方 [PyPI 2.8.0 metadata](https://pypi.org/pypi/pydantic-ai/2.8.0/json)：版本 `2.8.0`、Python `>=3.10`、`Development Status :: 5 - Production/Stable`。

rolling 文档只用于发现，不用于证明 2.8.0 行为。项目应声明 `pydantic-ai==2.8.*`，由 `uv.lock` 固定实际安装版本；若 lockfile 不是 `2.8.0`，应重新按对应 tag 核验本文。

## 结论

Production Worker 应显式注入企业 gateway model，不使用 `Agent("openai:...")`、`Agent("gateway/...")` 等 public-provider shorthand。最小可靠组合是：

```python
from openai import AsyncOpenAI
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

client = AsyncOpenAI(
    base_url=settings.gateway_base_url,
    api_key=settings.gateway_api_key,
    default_headers=settings.gateway_headers or None,
    timeout=settings.model_timeout_seconds,
    max_retries=2,
)
model = OpenAIChatModel(
    settings.gateway_model,
    provider=OpenAIProvider(openai_client=client),
)
```

`OpenAIChatModel` 是 v2.8.0 对 OpenAI-compatible Chat Completions endpoint 的实际 model class；官方文档明确把 compatible providers 放在 Chat Completions 路径下，而不是默认的 Responses API（[`docs/models/openai.md#L302-L344`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/openai.md#L302-L344)）。`OpenAIProvider` 接受既有 `AsyncOpenAI` client，且传入 client 后不能再同时传 `base_url`、`api_key` 或 `http_client`（[`providers/openai.py#L41-L88`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/providers/openai.py#L41-L88)）。

这里的 `OpenAIProvider` 是 wire adapter；实际请求目标来自 `AsyncOpenAI.base_url`。显式传 provider 可避开 `OpenAIChatModel` 默认的 public OpenAI provider（其构造器默认 `provider='openai'`，并在 string provider 时做推断：[`models/openai.py#L728-L769`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/models/openai.py#L728-L769)）。

固定 gateway headers 应放在 `AsyncOpenAI(default_headers=...)`；每次 model request 动态变化的 headers 可放在 `ModelSettings(extra_headers=...)`，v2.8.0 会把它们作为 OpenAI SDK 的 `extra_headers` 传下去（[`models/openai.py#L925-L967`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/models/openai.py#L925-L967)）。不要把 secret 写入 prompt、result metadata 或持久化 message history。

## Production Worker 最小 API

下面是可直接落地的 PydanticAI surface。`SnapshotReader` 代表项目已有的、由 control plane 构造的只读 snapshot reader；Worker 不自行打开任意路径。

```python
from dataclasses import dataclass

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelRetry, RunContext, Tool, UsageLimits


class EvidenceProposal(BaseModel):
    path: str
    revision: str
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    digest: str


class WorkerProposal(BaseModel):
    obligation_id: str
    claims: list[str]
    concepts: list[str]
    evidence: list[EvidenceProposal]


@dataclass(frozen=True)
class WorkerDeps:
    obligation_id: str
    allowed_paths: tuple[str, ...]
    snapshot: "SnapshotReader"


async def list_paths(ctx: RunContext[WorkerDeps], prefix: str = "") -> list[str]:
    """List assigned snapshot paths below an allowed prefix."""
    return await ctx.deps.snapshot.list_paths(prefix, allowed=ctx.deps.allowed_paths)


async def search_text(
    ctx: RunContext[WorkerDeps], query: str, paths: list[str] | None = None
) -> list[dict[str, object]]:
    """Search literal text inside the assigned snapshot."""
    if not query.strip():
        raise ModelRetry("query must not be empty")
    return await ctx.deps.snapshot.search_text(
        query, paths=paths, allowed=ctx.deps.allowed_paths
    )


async def read_text(
    ctx: RunContext[WorkerDeps], path: str, start_line: int, end_line: int
) -> str:
    """Read an inclusive line range from an assigned snapshot path."""
    if start_line < 1 or end_line < start_line:
        raise ModelRetry("use 1-based lines with end_line >= start_line")
    return await ctx.deps.snapshot.read_text(
        path, start_line, end_line, allowed=ctx.deps.allowed_paths
    )


worker = Agent[WorkerDeps, WorkerProposal](
    model=model,
    name="knowledge_worker",
    deps_type=WorkerDeps,
    output_type=WorkerProposal,
    instructions=(
        "Investigate only the assigned obligation and source snapshot. "
        "Every proposal must cite exact evidence returned by the tools."
    ),
    tools=[
        Tool(list_paths, max_retries=1, timeout=5),
        Tool(search_text, max_retries=2, timeout=15),
        Tool(read_text, max_retries=1, timeout=10),
    ],
    retries={"tools": 1, "output": 2},
    tool_timeout=15,
    max_concurrency=settings.worker_concurrency,
    metadata={"worker_contract": "pydanticai-v2.8"},
)


result = await worker.run(
    obligation.prompt,
    deps=WorkerDeps(
        obligation_id=obligation.id,
        allowed_paths=tuple(obligation.allowed_paths),
        snapshot=snapshot_reader,
    ),
    usage_limits=UsageLimits(
        request_limit=8,
        tool_calls_limit=20,
        output_tokens_limit=8_000,
        total_tokens_limit=60_000,
    ),
    metadata={"obligation_id": obligation.id, "snapshot_id": snapshot.id},
)
proposal: WorkerProposal = result.output
```

数字只是安全起点，最终值应来自 benchmark；接口选择本身是 v2.8.0 固定的。

### 授权边界

Production Worker **只允许**上面的 `list_paths`、`search_text`、`read_text` 三类只读工具：

- 不注册 Web/native search；
- 不注册 MCP toolset；
- 不注册 shell、subprocess、Python execution、filesystem write 或任意 network fetch；
- 不把 development 文档检索能力注入 Worker deps；
- 不允许 Worker close Obligation、写 Bundle、publish 或直接修改 authoritative state。

PydanticAI 只会把显式注册的 `tools`/`toolsets` 汇总给模型（[`docs/tools.md#L9-L15`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools.md#L9-L15)）；因此最小 allowlist 是本 Worker 的应用层 capability boundary。它不是 OS sandbox，snapshot reader 仍必须自行强制 path/revision/scope 校验。

## Typed output、deps、tools 和 retry

### Typed output

`Agent(..., output_type=WorkerProposal)` 保留 result 的静态类型，并用 Pydantic JSON Schema 和 validation 检查 model 返回。v2.8.0 默认通过 model tool calling 产生 structured output；不包含 `str` 时，模型必须返回结构化结果或调用 output function（[`docs/output.md#L1-L46`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/output.md#L1-L46)）。

对未知企业 gateway，第一版应保留默认 tool-output mode，不先要求 native `response_format=json_schema`。只有 gateway contract test 证明 native structured output 后，才考虑 `NativeOutput`；“OpenAI-compatible”不等于支持 OpenAI 全部 native structured-output behavior。

### Typed deps 和 RunContext

构造 Agent 时传 `deps_type=WorkerDeps`，运行时传 `deps=WorkerDeps(...)`；tool 的第一个参数写作 `RunContext[WorkerDeps]`，依赖从 `ctx.deps` 读取。官方示例与语义见 [`docs/dependencies.md#L7-L54`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/dependencies.md#L7-L54) 和 [`docs/dependencies.md#L162-L226`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/dependencies.md#L162-L226)。

有 context 的 function tool 可用 `@agent.tool` 或 `Tool(function)`；无 context 的可用 `@agent.tool_plain`。`tools=[function, Tool(...)]` 也受支持（[`docs/tools.md#L25-L68`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools.md#L25-L68)、[`docs/tools.md#L196-L248`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools.md#L196-L248)）。这里用显式 `Tool`，因为 Worker 需要逐工具 timeout/retry。

### `Tool`、`ModelRetry`、timeouts 和 retries

`Tool` 的 v2.8.0 构造参数包括 `max_retries`、`sequential`、`metadata`、`timeout` 等（[`tools.py#L448-L492`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/tools.py#L448-L492)）。

- Pydantic 参数 validation 失败时，框架生成 `RetryPromptPart`；tool 主动 `raise ModelRetry(...)` 时也会把反馈发回模型。
- retry 优先级是 per-tool `Tool(max_retries=N)` / decorator `retries=N`，再是 toolset，最后是 `Agent(retries={"tools": N})`。
- tool retry 是**逐工具计数**，不是全 run 共用一个 retry counter；耗尽后抛 `UnexpectedModelBehavior`。
- `Agent(retries={"output": N})` 控制 output validation retry；`retries=N` 同时设置 tools/output，显式 dict 更清楚。

这些行为见 [`docs/tools-advanced.md#L469-L489`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools-advanced.md#L469-L489) 和 Agent 构造器说明（[`agent/__init__.py#L323-L375`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/agent/__init__.py#L323-L375)）。

`tool_timeout` 是 Agent 默认值，individual `Tool(timeout=...)` 优先。超时会变成 retry prompt 并消耗该工具 retry budget（[`docs/tools-advanced.md#L491-L521`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools-advanced.md#L491-L521)）。这不是整个 run 的 wall-clock deadline；control plane 仍应在 Worker task 外包一层总 deadline/cancellation。

HTTP/network retry 与 `ModelRetry` 不同。前者处理 429/502/503/504、connection timeout 等 transport failure；官方 custom HTTP transport 示例见 [`docs/retries.md#L1-L63`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/retries.md#L1-L63)。如果直接用 `AsyncOpenAI(max_retries=2)`，保持次数较小并由 gateway contract test 覆盖；不要把 transport retry 当作 model self-correction retry。

OpenAI SDK 的 HTTP status/connection exceptions 在 model adapter 中分别映射为 `ModelHTTPError` / `ModelAPIError`（[`models/openai.py#L189-L198`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/models/openai.py#L189-L198)）。

## UsageLimits、tool limits 和并行

`UsageLimits` 可直接从 `pydantic_ai` import。v2.8.0 字段是：

```python
UsageLimits(
    request_limit=8,
    tool_calls_limit=20,
    input_tokens_limit=50_000,
    output_tokens_limit=8_000,
    total_tokens_limit=60_000,
    count_tokens_before_request=False,
)
```

源码定义与默认值见 [`usage.py#L258-L291`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/usage.py#L258-L291)。注意：

- `request_limit` 在下一次 model request 前检查，是防止 agent/tool loop 失控的首要 hard limit。
- `tool_calls_limit` 在执行一批 tool calls 前检查；若一批 parallel calls 会越界，这一批一个也不执行（[`docs/agent.md#L658-L683`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/agent.md#L658-L683)）。
- `RunUsage.tool_calls` 是成功执行的 function tool calls；validation/retry 仍需用 `request_limit` 约束。
- Chat Completions 不在 `count_tokens_before_request=True` 的支持列表中；v2.8.0 只列 Anthropic、Google、Bedrock Converse、OpenAI Responses。因此本 Worker 的 token limits 对 custom Chat gateway 通常依赖 response usage，属于 response 后检查。

模型一次返回多个 tool calls 时，PydanticAI 默认用 `asyncio.create_task` 并发执行。单个工具可设 `sequential=True` 作为 barrier；整个 run 可用 `with agent.parallel_tool_call_execution_mode('sequential')`，或 `ModelSettings(parallel_tool_calls=False)`（[`docs/tools-advanced.md#L564-L612`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/tools-advanced.md#L564-L612)）。只读 `list/search/read` 可以并发；若 snapshot reader 本身不是 concurrency-safe，先设置 sequential，而不是加新的 orchestration abstraction。

多 Worker/Agent 并行直接用 Python：

```python
import asyncio

results = await asyncio.gather(
    *(worker.run(item.prompt, deps=item.deps, usage_limits=item.limits) for item in batch)
)
```

`Agent(max_concurrency=N)` 限制同一 Agent 的 concurrent runs；达到上限会等待，设置 `ConcurrencyLimit(max_running=N, max_queued=M)` 后 queue 满会抛 `ConcurrencyLimitExceeded`（[`docs/agent.md#L797-L832`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/agent.md#L797-L832)）。这只限制 Agent runs，不限制一次 response 内部的 parallel tool calls，也不是整个进程/集群的全局 gateway quota。

如果 Agent 在 tool 内委托另一个 Agent，调用 delegate 时传 `usage=ctx.usage`，才能把两者 usage 汇总并共同受 limit 约束（[`docs/multi-agent-applications.md#L13-L65`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/multi-agent-applications.md#L13-L65)）。Issue 04 的 Worker 不需要这种递归 delegation；control plane programmatically 并行多个独立 Worker 更简单、权限边界也更清楚。

## Run result、messages、events 和 metadata

### `AgentRunResult`

在 v2.8.0，以下都是可用的 public fields/properties/methods：

```python
proposal = result.output
run_usage = result.usage
all_messages = result.all_messages()
new_messages = result.new_messages()
all_messages_json = result.all_messages_json()
new_messages_json = result.new_messages_json()
last_response = result.response
finished_at = result.timestamp
run_metadata = result.metadata
run_id = result.run_id
conversation_id = result.conversation_id
```

注意 `usage` 是 property，不是 `result.usage()`。`AgentRunResult` 的定义、message APIs、`response`、`usage`、`metadata`、IDs 见 [`run.py#L473-L614`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/run.py#L473-L614)。`all_messages()` 包含传入的旧 history，`new_messages()` 只包含本次 run；官方说明见 [`docs/message-history.md#L1-L17`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/message-history.md#L1-L17)。

`RunUsage` 可读取：`requests`、`tool_calls`、`input_tokens`、`output_tokens`、`total_tokens`、cache/audio token fields 和 `details`；定义见 [`usage.py#L182-L225`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/usage.py#L182-L225)。

### Message/tool trajectory

遍历 `result.new_messages()`，按 `ModelRequest` / `ModelResponse` 和 part 类型记录 trajectory：

```python
from pydantic_ai import ModelRequest, ModelResponse
from pydantic_ai.messages import RetryPromptPart, ToolCallPart, ToolReturnPart

for message in result.new_messages():
    if isinstance(message, ModelResponse):
        for part in message.parts:
            if isinstance(part, ToolCallPart):
                record_tool_call(part.tool_name, part.args, part.tool_call_id)
    elif isinstance(message, ModelRequest):
        for part in message.parts:
            if isinstance(part, ToolReturnPart):
                record_tool_result(
                    part.tool_name,
                    part.content,
                    part.tool_call_id,
                    part.outcome,
                    part.metadata,
                )
            elif isinstance(part, RetryPromptPart):
                record_retry(part.tool_name, part.content, part.tool_call_id)
```

关键字段：

- `ModelRequest`: `parts`, `timestamp`, `instructions`, `run_id`, `conversation_id`, `metadata`, `state`（[`messages.py#L1644-L1683`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/messages.py#L1644-L1683)）。
- `ModelResponse`: `parts`, per-request `usage`, `model_name`, `timestamp`, `provider_name`, `provider_url`, `provider_details`, `provider_response_id`, `finish_reason`, `run_id`, `conversation_id`, `metadata`, `state`（[`messages.py#L2223-L2291`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/messages.py#L2223-L2291)）。
- `ToolCallPart`: `tool_name`, `args`, `tool_call_id`, `id`, `provider_name`, `provider_details`, `part_kind`（[`messages.py#L1872-L1919`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/messages.py#L1872-L1919)）。
- `ToolReturnPart`: `tool_name`, `content`, `tool_call_id`, `metadata`, `timestamp`, `outcome`, `part_kind`（[`messages.py#L1224-L1267`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/messages.py#L1224-L1267)、[`messages.py#L1452-L1459`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/messages.py#L1452-L1459)）。
- `RetryPromptPart`: `content`, `tool_name`, `tool_call_id`, `timestamp`, `part_kind`（[`messages.py#L1517-L1555`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/messages.py#L1517-L1555)）。

Provider-specific extras must stay in `provider_details`; application audit metadata should use run/message/tool `metadata`. 不要依赖某个 gateway 一定填充所有 provider fields。

### Live events

completed result 不保存独立 event list；持久 trajectory 应从 messages 生成。若还需要 live timing，使用 `agent.run_stream_events()` 或 `agent.iter()`，处理：

- `FunctionToolCallEvent.part`、`.args_valid`、`.tool_call_id`；
- `FunctionToolResultEvent.part`、`.content`、`.tool_call_id`；
- `PartStartEvent` / `PartDeltaEvent` / `PartEndEvent`；
- `FinalResultEvent.tool_name` / `.tool_call_id`。

事件字段定义见 [`messages.py#L3240-L3422`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/messages.py#L3240-L3422)，官方消费示例见 [`docs/agent.md#L432-L548`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/agent.md#L432-L548)。

## 测试契约

### 1. 本地 deterministic tests

`TestModel` 和 `FunctionModel` 用于证明 Worker application logic；它们不能证明 enterprise gateway compatibility。

`TestModel` 默认调用所有 function tools，并按 schema 生成参数和 structured output；它是 procedural Python，不含 ML，也不能模拟 provider-executed native tools（[`docs/testing.md#L16-L32`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/testing.md#L16-L32)）。可用参数包括 `call_tools`、`custom_output_text`、`custom_output_args`、`seed`，并可检查 `last_model_request_parameters`（[`models/test.py#L61-L114`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/models/test.py#L61-L114)）。

最小 tests：

```python
from pydantic_ai import models
from pydantic_ai.models.test import TestModel

models.ALLOW_MODEL_REQUESTS = False

async def test_worker_exposes_only_read_tools():
    test_model = TestModel(call_tools=["list_paths", "search_text", "read_text"])
    with worker.override(model=test_model):
        result = await worker.run("inspect", deps=fake_deps)

    assert {t.name for t in test_model.last_model_request_parameters.function_tools} == {
        "list_paths", "search_text", "read_text"
    }
    assert isinstance(result.output, WorkerProposal)
```

用 `capture_run_messages()` 或 `result.new_messages()` 断言 `ToolCallPart` / `ToolReturnPart`，官方完整模式见 [`docs/testing.md#L87-L198`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/testing.md#L87-L198)。

`FunctionModel` 接收 `(messages, AgentInfo)` 并返回自己构造的 `ModelResponse`，适合精确编排 invalid args、parallel calls、retry、error 和 per-response usage（[`docs/api/models/function.md#L1-L62`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/api/models/function.md#L1-L62)）。最小 coverage 应包括：

1. 首次 `ToolCallPart` 给空 query，断言 tool `ModelRetry` 形成 `RetryPromptPart`，第二次给合法 query 后成功；
2. output tool 首次给 invalid schema，断言 output retry，随后得到 `WorkerProposal`；
3. `ModelResponse(usage=RequestUsage(...))` 多轮累加到 `result.usage`；
4. 同一 response 返回多个 `ToolCallPart`，用 events/counters 证明 read-only tools 并发；
5. `UsageLimits(request_limit=...)`、`tool_calls_limit` 和 timeout 分别抛预期异常；官方 parallel tool-limit test 的模式见 [`tests/test_usage_limits.py#L915-L976`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/tests/test_usage_limits.py#L915-L976)；
6. 多个 `worker.run()` 并发时，断言 `max_concurrency` 上限；官方 test 见 [`tests/test_concurrency.py#L260-L315`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/tests/test_concurrency.py#L260-L315)。

这些 tests 能证明 Pydantic validation、tool allowlist、deps wiring、retry/limit/timeout、trajectory extraction 和 application concurrency；不能证明 gateway 会正确接收 schema、选择工具、返回 usage、支持 parallel tool calls，或返回 OpenAI-compatible response shape。

### 2. Enterprise gateway contract tests

必须使用 production 同一 `AsyncOpenAI` + `OpenAIProvider` + `OpenAIChatModel` 构造路径，通过 `Agent.run()` 的 public API 对真实 test tenant/model 运行，不用 `TestModel`、`FunctionModel` 或 mocked HTTP。

官方仓库自己的 testing philosophy 也把 real provider public-API/VCR tests 视为最终兼容性证据（[`tests/AGENTS.md#L1-L9`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/tests/AGENTS.md#L1-L9)），并要求 positive/negative capability cases（[`tests/AGENTS.md#L193-L201`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/tests/AGENTS.md#L193-L201)）。本项目至少需要：

| Contract test | 必须断言 |
|---|---|
| tool calling | model 实际调用一个无副作用 probe tool；history 有匹配的 `ToolCallPart` / `ToolReturnPart` / ID；final output 成功 |
| structured output | `output_type=GatewayProbeResult` 返回实际 typed instance；不接受手工 `json.loads` 绕过 Pydantic validation |
| retry | probe tool 第一次 `raise ModelRetry`、第二次成功；history 有 `RetryPromptPart`，且不超过配置 budget |
| HTTP error | invalid credential/专用 error route 映射为 `ModelHTTPError`；unreachable endpoint 映射为 `ModelAPIError`；测试不能重试到超长超时 |
| usage | `result.usage.requests >= 1`，input/output tokens 为 gateway 定义的非零合理值；逐个 `ModelResponse.usage` 与 run aggregate 一致 |
| parallel tools | 设置 `ModelSettings(parallel_tool_calls=True)`，让 model 在同一 response 调两个独立 probe tools；同一 `ModelResponse` 必须有两个 `ToolCallPart`，并证明本地执行有 overlap |
| configured concurrency | `asyncio.gather` 发出超过 `max_concurrency` 的 runs；全部成功，客户端测得并发不越 Worker limit；gateway/server telemetry 证明允许目标并发而非串行退化或 429 storm |
| timeout/limits | slow probe 被 tool timeout 转成 retry；`request_limit` / `tool_calls_limit` 在真实 gateway loop 中终止 |
| response fields | `model_name`、`provider_url`、`finish_reason`、`provider_response_id`/`provider_details` 中项目要审计的字段存在或有明确 fallback |

VCR cassette 只适合稳定回放，不足以替代部署前对当前 enterprise gateway 的 live smoke/contract suite。cassette 还必须 scrub authorization 和组织 headers。

## Custom OpenAI-compatible endpoint caveats

1. **优先 `OpenAIChatModel`。** 官方把 compatible endpoints 定义在 Chat Completions 路径；不要因为 public OpenAI 默认已经是 Responses API 就假定企业 gateway 有 `/responses`（[`docs/models/openai.md#L23-L45`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/openai.md#L23-L45)、[`docs/models/openai.md#L302-L344`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/openai.md#L302-L344)）。
2. **“compatible”不是 capability guarantee。** 不同 backend 对 JSON Schema、strict tool definitions、system messages 和 token field 有差异。v2.8.0 提供 `OpenAIModelProfile` knobs，例如 `openai_supports_strict_tool_definition=False`、`openai_chat_supports_multiple_system_messages=False`、`openai_chat_supports_max_completion_tokens=False`（[`docs/models/openai.md#L349-L381`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/docs/models/openai.md#L349-L381)）。只根据失败的 contract test 设置这些 flags，不预先堆兼容配置。
3. **更多 profile 差异存在。** `tool_choice='required'`、custom thinking field、document input 等都有单独 capability fields（[`profiles/openai.py#L57-L177`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/profiles/openai.py#L57-L177)）。Worker 当前不需要 thinking/native document/tool choice forcing，保持未启用最省风险。
4. **usage 可能缺失。** 若 Chat response 的 `usage` 是 `None`，v2.8.0 返回空 `RequestUsage()`，因此 token limits/audit 会得到零，不会自动推算（[`models/openai.py#L4168-L4206`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/models/openai.py#L4168-L4206)）。Production gate 必须要求 gateway 返回 usage，或明确由 gateway telemetry 提供 authoritative accounting。
5. **response 必须是有效 JSON/shape。** endpoint 回 plain text 或不符合 OpenAI SDK schema 时，adapter 抛 `UnexpectedModelBehavior`（[`models/openai.py#L987-L1009`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/models/openai.py#L987-L1009)）。
6. **parallel support 要实测。** v2.8.0 会把 `parallel_tool_calls` 传给 Chat Completions request（[`models/openai.py#L925-L948`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/models/openai.py#L925-L948)），但 gateway/model 是否接受并返回多个 calls 只能由 live contract test 证明。
7. **自定义 client 的 header 参数是 `default_headers`。** PydanticAI 只持有并复用传入的 client；不要写 `AsyncOpenAI(headers=...)`。动态 per-request headers 使用 PydanticAI `ModelSettings(extra_headers=...)`。
8. **无 key endpoint 仍可能需要 placeholder。** `OpenAIProvider(base_url=..., api_key=None)` 会在本地 compatible endpoint 情况下补非空 placeholder，因为 OpenAI SDK 要求 key（[`providers/openai.py#L72-L88`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/providers/openai.py#L72-L88)）；直接构造 `AsyncOpenAI` 时应显式给企业 key或非 secret placeholder。
9. **provider label 不是安全边界。** `OpenAIProvider.name` 固定为 `openai`，`base_url` 才是实际 route（[`providers/openai.py#L22-L35`](https://github.com/pydantic/pydantic-ai/blob/v2.8.0/pydantic_ai_slim/pydantic_ai/providers/openai.py#L22-L35)）。审计记录至少同时保存 configured gateway ID、`ModelResponse.provider_url`、model name 和 application metadata。

## 最小实施建议

第一版只实现一个 explicit `build_gateway_model(settings) -> OpenAIChatModel`、一个 typed Worker Agent、三个 read-only tools，以及两层测试：`TestModel`/`FunctionModel` 的 deterministic contract tests，加真实 enterprise gateway live contract tests。暂不加 MCP、Web、shell、native tools、multi-agent delegation、Responses API 或 custom Model subclass；只有固定 gateway contract 明确要求时再增加。
