from pathlib import Path
import asyncio
import json
import re
import subprocess

from pydantic_ai import ModelSettings
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai_harness import CodeMode
from pydantic_ai_harness.compaction import TieredCompaction
from pydantic_ai_harness.dynamic_workflow import DynamicWorkflow
from pydantic_ai_harness.overflowing_tool_output import OverflowingToolOutput
from pydantic_ai_harness.planning import Planning
from pydantic_ai_harness.subagents import SubAgents
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.adaptive_orchestration import (
    AdaptivePolicy,
    build_root_agent,
    should_enable_adaptive,
)
from okf_wiki.analysis_workspace import AnalysisWorkspace
from okf_wiki.wiki_run import WikiRunLimits
from okf_wiki.wiki_run import (
    Complete,
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunEvent,
    WikiRunRequest,
)


def _builder(tmp_path: Path, limits: WikiRunLimits, *, adaptive: bool = True):
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    source.mkdir()
    skill.mkdir()
    staging.mkdir()
    workspace = AnalysisWorkspace("a" * 32, root=tmp_path / "analysis")
    agent, orchestration = build_root_agent(
        model="test",
        settings=ModelSettings(),
        output_type=str,
        instructions="test",
        source_mount=source,
        skill_mount=skill,
        staging=staging,
        workspace=workspace,
        run_id="a" * 32,
        limits=limits,
        adaptive=adaptive,
        write_limit=1_000_000,
        emit=lambda *_: None,
    )
    return agent, orchestration, workspace


def _repository(tmp_path: Path) -> tuple[Path, str]:
    source = tmp_path / "repo"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("source\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True
    ).stdout.strip()
    return source, revision


def test_small_scope_does_not_trigger_adaptive_fanout() -> None:
    limits = WikiRunLimits(adaptive_source_files_threshold=10, adaptive_source_bytes_threshold=100)
    assert not should_enable_adaptive(
        repository_count=1, source_files=9, source_bytes=99, limits=limits
    )
    assert should_enable_adaptive(
        repository_count=1, source_files=10, source_bytes=99, limits=limits
    )


def test_small_scope_keeps_the_historical_single_agent_capability_set(tmp_path: Path) -> None:
    agent, orchestration, workspace = _builder(tmp_path, WikiRunLimits(), adaptive=False)
    try:
        assert not orchestration.policy.enabled
        capabilities = agent.root_capability.capabilities
        assert any(isinstance(capability, CodeMode) for capability in capabilities)
        assert not any(
            isinstance(capability, (Planning, TieredCompaction, SubAgents, DynamicWorkflow))
            for capability in capabilities
        )
    finally:
        workspace.cleanup()


def test_root_capabilities_use_explicit_roster_and_single_writer_mount(tmp_path: Path) -> None:
    agent, orchestration, workspace = _builder(tmp_path, WikiRunLimits())
    try:
        assert orchestration.policy.enabled
        assert orchestration.policy.root_fanout == 2
        capabilities = agent.root_capability.capabilities
        subagents = next(
            capability for capability in capabilities if isinstance(capability, SubAgents)
        )
        assert subagents.agent_folders is None
        assert subagents.inherit_tools is False
        assert len(subagents.agents) == 2
        assert any(isinstance(capability, Planning) for capability in capabilities)
        assert any(isinstance(capability, TieredCompaction) for capability in capabilities)
        assert any(isinstance(capability, OverflowingToolOutput) for capability in capabilities)

        root_code = next(
            capability for capability in capabilities if isinstance(capability, CodeMode)
        )
        assert {mount.virtual_path for mount in root_code.mount} == {"/source", "/skill", "/wiki"}

        domain = subagents.agents[0].agent.wrapped
        domain_capabilities = domain.root_capability.capabilities
        assert any(isinstance(capability, Planning) for capability in domain_capabilities)
        assert any(isinstance(capability, TieredCompaction) for capability in domain_capabilities)
        domain_code = next(
            capability for capability in domain_capabilities if isinstance(capability, CodeMode)
        )
        assert {mount.virtual_path for mount in domain_code.mount} == {"/source", "/skill"}
        assert not any(mount.virtual_path == "/wiki" for mount in domain_code.mount)
    finally:
        workspace.cleanup()


def test_small_envelope_disables_adaptive_path_before_children(tmp_path: Path) -> None:
    limits = WikiRunLimits(request_limit=1, total_tokens_limit=1)
    agent, orchestration, workspace = _builder(tmp_path, limits)
    try:
        assert not orchestration.policy.enabled
        assert not any(
            isinstance(capability, SubAgents) for capability in agent.root_capability.capabilities
        )
    finally:
        workspace.cleanup()


def test_dynamic_workflow_is_one_domain_layer_only(tmp_path: Path) -> None:
    limits = WikiRunLimits(adaptive_dynamic_workflow=True)
    agent, orchestration, workspace = _builder(tmp_path, limits)
    try:
        subagents = next(
            capability
            for capability in agent.root_capability.capabilities
            if isinstance(capability, SubAgents)
        )
        domain = subagents.agents[0].agent.wrapped
        domain_dynamic = next(
            capability
            for capability in domain.root_capability.capabilities
            if isinstance(capability, DynamicWorkflow)
        )
        assert domain_dynamic.max_agent_calls == 2
        assert not any(
            isinstance(capability, DynamicWorkflow)
            for leaf in domain_dynamic.agents
            for capability in leaf.agent.root_capability.capabilities
        )
    finally:
        workspace.cleanup()


def test_adaptive_policy_rejects_unbounded_topology() -> None:
    try:
        AdaptivePolicy(enabled=True, max_depth=3)
    except ValueError as error:
        assert "max_depth" in str(error)
    else:
        raise AssertionError("unbounded adaptive depth must fail closed")


def test_envelope_reservation_only_counts_enabled_topology_layers(tmp_path: Path) -> None:
    domain_only = AdaptivePolicy(enabled=True, max_depth=1)
    assert domain_only.child_count_reservation() == (12, 50_000)
    assert AdaptivePolicy(enabled=False, max_depth=0).child_count_reservation() == (0, 0)

    agent, orchestration, workspace = _builder(tmp_path, WikiRunLimits(adaptive_max_depth=0))
    try:
        assert not orchestration.policy.enabled
        assert not any(
            isinstance(capability, SubAgents) for capability in agent.root_capability.capabilities
        )
    finally:
        workspace.cleanup()


def test_recursive_adaptive_path_fails_closed_when_no_leaf_slot_exists(tmp_path: Path) -> None:
    agent, orchestration, workspace = _builder(
        tmp_path, WikiRunLimits(adaptive_child_concurrency=1)
    )
    try:
        assert not orchestration.policy.enabled
        assert not any(
            isinstance(capability, SubAgents) for capability in agent.root_capability.capabilities
        )
    finally:
        workspace.cleanup()


def test_expanded_domain_roster_requires_a_larger_whole_tree_envelope(tmp_path: Path) -> None:
    default_root = tmp_path / "default"
    default_root.mkdir()
    agent, orchestration, workspace = _builder(default_root, WikiRunLimits(adaptive_root_fanout=4))
    try:
        assert not orchestration.policy.enabled
        assert not any(
            isinstance(capability, SubAgents) for capability in agent.root_capability.capabilities
        )
    finally:
        workspace.cleanup()

    expanded_root = tmp_path / "expanded"
    expanded_root.mkdir()
    agent, orchestration, workspace = _builder(
        expanded_root,
        WikiRunLimits(
            adaptive_root_fanout=4,
            request_limit=70,
            total_tokens_limit=500_000,
        ),
    )
    try:
        assert orchestration.policy.enabled
        subagents = next(
            capability
            for capability in agent.root_capability.capabilities
            if isinstance(capability, SubAgents)
        )
        assert len(subagents.agents) == 4
    finally:
        workspace.cleanup()


def test_adaptive_run_delegates_and_reduces_a_bounded_receipt(tmp_path: Path) -> None:
    source, revision = _repository(tmp_path)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        if "Domain Researcher" in instructions:
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+)",
                instructions,
            )
            assert assignment is not None
            run_id, task_id, node_id, parent_id = assignment.groups()
            if not run_code_returns:
                code = (
                    "handoff = publish_receipt("
                    f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                    f"attempt=1, status='complete', scope='domain:{task_id}', "
                    "summary='bounded domain receipt')\nprint(handoff)"
                )
                return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
            content = run_code_returns[-1].content
            if isinstance(content, dict):
                content = content.get("output", "")
            return ModelResponse(parts=[TextPart(str(content).strip())])

        if not run_code_returns:
            code = (
                "result = await delegate_task(agent_name='domain_1', "
                "task='Inspect the README and publish a bounded receipt.')\n"
                "from pathlib import Path\n"
                "Path('/wiki/index.md').write_text("
                "'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n'"
                ")\n"
                "print(result)"
            )
            return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name, {"status": "complete", "manifest": {"pages": ["index.md"]}}
                )
            ]
        )

    events = []
    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=ProducerSkillVersion.default(),
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=50,
                    tool_calls_limit=40,
                    total_tokens_limit=350_000,
                    adaptive_source_files_threshold=1,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
            )
        )
    )
    assert isinstance(result, Complete)
    assert (tmp_path / "published" / "index.md").is_file()
    assert any(event.type == "child_started" and event.node_id == "domain-1" for event in events)
    assert any(
        event.type == "receipt_published" and event.node_id == "domain-1" for event in events
    )
    assert any(event.type == "adaptive_summary" for event in events)
    records = list((tmp_path / ".published.runs").glob("*.json"))
    assert len(records) == 1
    record = json.loads(records[0].read_text(encoding="utf-8"))
    assert record["usage"]["requests"] >= 1


def test_recursive_root_domain_leaf_reduces_child_receipts(tmp_path: Path) -> None:
    source, revision = _repository(tmp_path)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        attempt_match = re.search(r"attempt=(\d+)", instructions)
        attempt = int(attempt_match.group(1)) if attempt_match is not None else 1
        if "You are a Leaf Researcher." in instructions:
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+)",
                instructions,
            )
            assert assignment is not None
            run_id, task_id, node_id, parent_id = assignment.groups()
            if not run_code_returns:
                code = (
                    "handoff = publish_receipt("
                    f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                    f"attempt={attempt}, status='complete', scope='leaf:{task_id}', "
                    "summary='leaf receipt')\nprint(handoff)"
                )
                return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
            content = run_code_returns[-1].content
            if isinstance(content, dict):
                content = content.get("output", "")
            return ModelResponse(parts=[TextPart(str(content).strip())])

        if "You are a Domain Researcher." in instructions:
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+)",
                instructions,
            )
            assert assignment is not None
            run_id, task_id, node_id, parent_id = assignment.groups()
            if not run_code_returns:
                code = (
                    "import asyncio\nimport json\n"
                    "left, right = await asyncio.gather("
                    "delegate_task(agent_name='leaf_1', task='Inspect the first leaf.'), "
                    "delegate_task(agent_name='leaf_2', task='Inspect the second leaf.'))\n"
                    "left_ref = json.loads(left)['receipt']\n"
                    "right_ref = json.loads(right)['receipt']\n"
                    "handoff = publish_receipt("
                    f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                    f"attempt={attempt}, status='complete', scope='domain:{task_id}', "
                    "summary='reduced leaf receipts', child_receipts=[left_ref, right_ref])\n"
                    "print(handoff)"
                )
                return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
            content = run_code_returns[-1].content
            if isinstance(content, dict):
                content = content.get("output", "")
            return ModelResponse(parts=[TextPart(str(content).strip())])

        if not run_code_returns:
            code = (
                "result = await delegate_task(agent_name='domain_1', task='Reduce two leaf scopes.')\n"
                "from pathlib import Path\n"
                "Path('/wiki/index.md').write_text("
                "'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')\n"
                "print(result)"
            )
            return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name, {"status": "complete", "manifest": {"pages": ["index.md"]}}
                )
            ]
        )

    events: list[WikiRunEvent] = []
    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=ProducerSkillVersion.default(),
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=50,
                    tool_calls_limit=80,
                    total_tokens_limit=350_000,
                    adaptive_source_files_threshold=1,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
            )
        )
    )
    assert isinstance(result, Complete)
    assert (tmp_path / "published" / "index.md").is_file()
    assert {event.node_id for event in events} >= {
        "domain-1",
        "domain-1-leaf-1",
        "domain-1-leaf-2",
    }
    summary = next(event for event in events if event.type == "adaptive_summary")
    max_active = summary.payload["max_active"]
    assert isinstance(max_active, int)
    assert 1 < max_active <= 4


def test_failed_domain_attempt_can_retry_once_and_clear_the_unresolved_state(
    tmp_path: Path,
) -> None:
    source, revision = _repository(tmp_path)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        if "You are a Domain Researcher." in instructions:
            attempt_match = re.search(r"attempt=(\d+)", instructions)
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+)",
                instructions,
            )
            assert attempt_match is not None and assignment is not None
            attempt = int(attempt_match.group(1))
            run_id, task_id, node_id, parent_id = assignment.groups()
            if attempt == 1:
                return ModelResponse(parts=[TextPart("not a receipt")])
            if not run_code_returns:
                code = (
                    "handoff = publish_receipt("
                    f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                    f"attempt={attempt}, status='complete', scope='domain:{task_id}', "
                    "summary='retry recovered')\nprint(handoff)"
                )
                return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
            content = run_code_returns[-1].content
            if isinstance(content, dict):
                content = content.get("output", "")
            return ModelResponse(parts=[TextPart(str(content).strip())])

        if not run_code_returns:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "run_code",
                        {
                            "code": (
                                "result = await delegate_task("
                                "agent_name='domain_1', task='Inspect the domain.')\nprint(result)"
                            )
                        },
                    )
                ]
            )
        if len(run_code_returns) == 1:
            code = (
                "result = await delegate_task(agent_name='domain_1', task='Retry the domain.')\n"
                "from pathlib import Path\n"
                "Path('/wiki/index.md').write_text("
                "'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')\n"
                "print(result)"
            )
            return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name, {"status": "complete", "manifest": {"pages": ["index.md"]}}
                )
            ]
        )

    events = []
    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=ProducerSkillVersion.default(),
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=50,
                    tool_calls_limit=80,
                    total_tokens_limit=350_000,
                    adaptive_source_files_threshold=1,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
            )
        )
    )
    assert isinstance(result, Complete)
    domain_starts = [
        event for event in events if event.type == "child_started" and event.node_id == "domain-1"
    ]
    assert len(domain_starts) == 2
    domain_receipts = [
        event.payload["status"]
        for event in events
        if event.type == "receipt_published" and event.node_id == "domain-1"
    ]
    assert domain_receipts == ["failed", "complete"]
    summary = next(event for event in events if event.type == "adaptive_summary")
    assert summary.payload["critical_failures"] == 0


def test_optional_dynamic_workflow_runs_one_typed_leaf_coordination_layer(
    tmp_path: Path,
) -> None:
    source, revision = _repository(tmp_path)

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        workflow_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_workflow"
        ]
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        if "You are a Leaf Researcher." in instructions:
            attempt_match = re.search(r"attempt=(\d+)", instructions)
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+)",
                instructions,
            )
            assert attempt_match is not None and assignment is not None
            run_id, task_id, node_id, parent_id = assignment.groups()
            if not run_code_returns:
                code = (
                    "handoff = publish_receipt("
                    f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                    f"attempt={attempt_match.group(1)}, status='complete', scope='leaf:{task_id}', "
                    "summary='dynamic leaf')\nprint(handoff)"
                )
                return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
            content = run_code_returns[-1].content
            if isinstance(content, dict):
                content = content.get("output", "")
            return ModelResponse(parts=[TextPart(str(content).strip())])

        if "You are a Domain Researcher." in instructions:
            attempt_match = re.search(r"attempt=(\d+)", instructions)
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+)",
                instructions,
            )
            assert attempt_match is not None and assignment is not None
            run_id, task_id, node_id, parent_id = assignment.groups()
            if not workflow_returns and not run_code_returns:
                workflow = (
                    "import asyncio\n"
                    "await asyncio.gather("
                    "leaf_1(task='first leaf'), leaf_2(task='second leaf'))"
                )
                return ModelResponse(parts=[ToolCallPart("run_workflow", {"code": workflow})])
            if not run_code_returns:
                code = (
                    "handoff = publish_receipt("
                    f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                    f"attempt={attempt_match.group(1)}, status='complete', scope='domain:{task_id}', "
                    "summary='dynamic reduction')\nprint(handoff)"
                )
                return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
            content = run_code_returns[-1].content
            if isinstance(content, dict):
                content = content.get("output", "")
            return ModelResponse(parts=[TextPart(str(content).strip())])

        if not run_code_returns:
            code = (
                "result = await delegate_task(agent_name='domain_1', task='Use the dynamic leaf layer.')\n"
                "from pathlib import Path\n"
                "Path('/wiki/index.md').write_text("
                "'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')\n"
                "print(result)"
            )
            return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name, {"status": "complete", "manifest": {"pages": ["index.md"]}}
                )
            ]
        )

    events: list[WikiRunEvent] = []
    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=ProducerSkillVersion.default(),
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=50,
                    tool_calls_limit=80,
                    total_tokens_limit=350_000,
                    adaptive_source_files_threshold=1,
                    adaptive_dynamic_workflow=True,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
            )
        )
    )
    assert isinstance(result, Complete)
    assert any(
        event.type == "child_started" and event.node_id == "domain-1-leaf-1" for event in events
    )
    assert any(
        event.type == "child_started" and event.node_id == "domain-1-leaf-2" for event in events
    )
