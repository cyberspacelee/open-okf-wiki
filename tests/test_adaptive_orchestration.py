from pathlib import Path
import asyncio
import json
import re
import subprocess
from dataclasses import dataclass, field

import pytest
from pydantic_ai import ModelRequestContext, ModelSettings, RunUsage
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai_harness import CodeMode
from pydantic_ai_harness.compaction import (
    ClampOversizedMessages,
    ClearToolResults,
    LimitWarner,
    SummarizingCompaction,
    TieredCompaction,
)
from pydantic_ai_harness.dynamic_workflow import DynamicWorkflow
from pydantic_ai_harness.overflowing_tool_output import OverflowingToolOutput
from pydantic_ai_harness.planning import Planning
from pydantic_ai_harness.subagents import SubAgents
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.run.adaptive import (
    AdaptivePolicy,
    build_root_agent,
    build_root_assembly,
    should_enable_adaptive,
)
from okf_wiki.run.analysis.workspace import AnalysisWorkspace
from okf_wiki.run.context import (
    ObservableTieredCompaction,
    build_context_capabilities,
)
from okf_wiki.run import WikiRunLimits
from okf_wiki.run import (
    Complete,
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunEvent,
    WikiRunRequest,
)


def _has_context_stack(capabilities: list) -> None:
    """Assert LimitWarner + ObservableTieredCompaction + OverflowingToolOutput."""
    assert any(isinstance(capability, LimitWarner) for capability in capabilities)
    assert any(isinstance(capability, ObservableTieredCompaction) for capability in capabilities)
    assert any(isinstance(capability, TieredCompaction) for capability in capabilities)
    assert any(isinstance(capability, OverflowingToolOutput) for capability in capabilities)


def test_build_context_capabilities_returns_harness_stack(tmp_path: Path) -> None:
    workspace = AnalysisWorkspace("a" * 32, root=tmp_path / "analysis")
    try:
        capabilities = build_context_capabilities(
            model="test",
            target_tokens=100_000,
            workspace=workspace,
        )
        assert len(capabilities) == 3
        warner, compaction, overflow = capabilities
        assert isinstance(warner, LimitWarner)
        assert warner.max_context_tokens == 100_000
        assert warner.warning_threshold == 0.7
        assert isinstance(compaction, ObservableTieredCompaction)
        assert compaction.target_tokens == 50_000
        assert compaction.trigger_tokens == 60_000
        assert compaction.warning_tokens == 70_000
        tier_types = [type(tier) for tier in compaction.tiers]
        assert tier_types == [ClampOversizedMessages, ClearToolResults, SummarizingCompaction]
        assert isinstance(overflow, OverflowingToolOutput)
    finally:
        workspace.cleanup()


def test_build_context_capabilities_rejects_non_positive_target(tmp_path: Path) -> None:
    workspace = AnalysisWorkspace("a" * 32, root=tmp_path / "analysis")
    try:
        with pytest.raises(ValueError, match="target_tokens"):
            build_context_capabilities(model="test", target_tokens=0, workspace=workspace)
    finally:
        workspace.cleanup()


@dataclass
class _ObservationDeps:
    compaction_warning_emitted: bool = False
    depth: int = 1
    role: str = "domain"
    node_id: str | None = "domain-1"
    events: list[tuple[str, dict, str | None]] = field(default_factory=list)

    def emit(self, event_type: str, payload: dict, *, node_id: str | None = None) -> None:
        self.events.append((event_type, payload, node_id))


def test_observable_tiered_compaction_emits_warning_and_completed_on_over_budget() -> None:
    """Synthetic over-budget history: warning once, then completed when clamp rewrites."""
    content = "word " * 50_000
    messages = [
        ModelRequest(parts=[UserPromptPart(content="hi")]),
        ModelResponse(parts=[TextPart(content=content)]),
    ]
    deps = _ObservationDeps()
    model = TestModel()
    capability = ObservableTieredCompaction(
        tiers=[ClampOversizedMessages(max_part_chars=100, keep_head_chars=20, keep_tail_chars=20)],
        target_tokens=100,
        trigger_tokens=1_000,
        warning_tokens=500,
    )
    run_ctx = RunContext(deps=deps, model=model, usage=RunUsage())
    request = ModelRequestContext(
        model=model,
        messages=list(messages),
        model_settings=None,
        model_request_parameters=ModelRequestParameters(),
    )
    result = asyncio.run(capability.before_model_request(run_ctx, request))
    event_types = [event[0] for event in deps.events]
    assert event_types == ["compaction_warning", "compaction_completed"]
    warning = deps.events[0][1]
    assert warning["node_kind"] == "domain"
    assert warning["depth"] == 1
    assert warning["warning_tokens"] == 500
    assert deps.events[0][2] == "domain-1"
    completed = deps.events[1][1]
    assert completed["target_tokens"] == 100
    assert completed["before_tokens"] > 1_000
    part0 = result.messages[1].parts[0]
    part_content = getattr(part0, "content", "")
    assert isinstance(part_content, str)
    assert len(part_content) < len(content)
    # Warning is once per deps instance.
    again = ModelRequestContext(
        model=model,
        messages=list(messages),
        model_settings=None,
        model_request_parameters=ModelRequestParameters(),
    )
    asyncio.run(capability.before_model_request(run_ctx, again))
    assert sum(1 for event in deps.events if event[0] == "compaction_warning") == 1


def _builder(
    tmp_path: Path,
    limits: WikiRunLimits,
    *,
    adaptive: bool = True,
    reviewer_model: object | None = None,
    reviewer_settings: ModelSettings | None = None,
):
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
        emit=lambda *_args, **_kwargs: None,
        reviewer_model=reviewer_model,
        reviewer_settings=reviewer_settings,
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


def _run_adaptive(
    tmp_path: Path,
    source: Path,
    revision: str,
    model,
    **limit_overrides,
) -> tuple[Complete, list[WikiRunEvent]]:
    # Leave headroom for Domain retry/recovery after child + Reviewer reservations.
    limit_values = {
        "request_limit": 60,
        "tool_calls_limit": 100,
        "total_tokens_limit": 400_000,
        "adaptive_source_files_threshold": 1,
        "retries": 2,
        "request_timeout_seconds": 5,
        "tool_timeout_seconds": 5,
        **limit_overrides,
    }
    events: list[WikiRunEvent] = []
    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=ProducerSkillVersion.default(),
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(**limit_values),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
                auto_approve_publication=True,
            )
        )
    )
    assert isinstance(result, Complete)
    return result, events


def test_small_scope_does_not_trigger_adaptive_fanout() -> None:
    limits = WikiRunLimits(adaptive_source_files_threshold=10, adaptive_source_bytes_threshold=100)
    assert not should_enable_adaptive(
        repository_count=1, source_files=9, source_bytes=99, limits=limits
    )
    assert should_enable_adaptive(
        repository_count=1, source_files=10, source_bytes=99, limits=limits
    )


def test_small_scope_keeps_codemode_without_adaptive_roster(tmp_path: Path) -> None:
    """Non-adaptive roots still get context capabilities; no Planning/SubAgents roster."""
    agent, orchestration, workspace = _builder(tmp_path, WikiRunLimits(), adaptive=False)
    try:
        assert not orchestration.policy.enabled
        capabilities = agent.root_capability.capabilities
        assert any(isinstance(capability, CodeMode) for capability in capabilities)
        assert any(isinstance(capability, TieredCompaction) for capability in capabilities)
        assert not any(
            isinstance(capability, (Planning, SubAgents, DynamicWorkflow))
            for capability in capabilities
        )
    finally:
        workspace.cleanup()


def test_root_assembly_topology_snapshot_is_host_facing(tmp_path: Path) -> None:
    """Topology assertions go through RootAssembly, not Harness capability graphs."""
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    source.mkdir()
    skill.mkdir()
    staging.mkdir()
    workspace = AnalysisWorkspace("a" * 32, root=tmp_path / "analysis")
    try:
        assembly = build_root_assembly(
            model="test",
            settings=ModelSettings(),
            output_type=str,
            instructions="test",
            source_mount=source,
            skill_mount=skill,
            staging=staging,
            workspace=workspace,
            run_id="a" * 32,
            limits=WikiRunLimits(),
            adaptive=True,
            write_limit=1_000_000,
            emit=lambda *_args, **_kwargs: None,
        )
        snapshot = assembly.topology_snapshot()
        assert snapshot["adaptive_enabled"] is True
        assert snapshot["root_fanout"] == 2
        assert snapshot["enable_reviewer"] is True
        assert snapshot["has_publish_reviewer"] is True
        assert set(assembly.root_subagent_names()) == {"domain_1", "domain_2", "reviewer"}

        disabled = build_root_assembly(
            model="test",
            settings=ModelSettings(),
            output_type=str,
            instructions="test",
            source_mount=source,
            skill_mount=skill,
            staging=staging,
            workspace=workspace,
            run_id="b" * 32,
            limits=WikiRunLimits(adaptive_enable_reviewer=False),
            adaptive=True,
            write_limit=1_000_000,
            emit=lambda *_args, **_kwargs: None,
        )
        assert disabled.topology_snapshot()["enable_reviewer"] is False
        assert set(disabled.root_subagent_names()) == {"domain_1", "domain_2"}
    finally:
        workspace.cleanup()


def test_root_capabilities_use_explicit_roster_and_single_writer_mount(tmp_path: Path) -> None:
    agent, orchestration, workspace = _builder(tmp_path, WikiRunLimits())
    try:
        assert orchestration.policy.enabled
        assert orchestration.policy.root_fanout == 2
        assert orchestration.policy.enable_reviewer
        capabilities = agent.root_capability.capabilities
        subagents = next(
            capability for capability in capabilities if isinstance(capability, SubAgents)
        )
        assert subagents.agent_folders is None
        assert subagents.inherit_tools is False
        # Two domains plus one optional Reviewer.
        assert len(subagents.agents) == 3
        names = {entry.name for entry in subagents.agents}
        assert names == {"domain_1", "domain_2", "reviewer"}
        assert any(isinstance(capability, Planning) for capability in capabilities)
        _has_context_stack(list(capabilities))

        root_code = next(
            capability for capability in capabilities if isinstance(capability, CodeMode)
        )
        assert {mount.virtual_path for mount in root_code.mount} == {"/source", "/skill", "/wiki"}
        wiki_mount = next(mount for mount in root_code.mount if mount.virtual_path == "/wiki")
        assert wiki_mount.mode == "read-write"

        domain = next(entry.agent.wrapped for entry in subagents.agents if entry.name == "domain_1")
        domain_capabilities = domain.root_capability.capabilities
        assert any(isinstance(capability, Planning) for capability in domain_capabilities)
        _has_context_stack(list(domain_capabilities))
        domain_code = next(
            capability for capability in domain_capabilities if isinstance(capability, CodeMode)
        )
        assert {mount.virtual_path for mount in domain_code.mount} == {"/source", "/skill"}
        assert not any(mount.virtual_path == "/wiki" for mount in domain_code.mount)

        domain_sub = next(
            capability for capability in domain_capabilities if isinstance(capability, SubAgents)
        )
        leaf = domain_sub.agents[0].agent.wrapped
        leaf_capabilities = leaf.root_capability.capabilities
        _has_context_stack(list(leaf_capabilities))
        assert not any(isinstance(capability, SubAgents) for capability in leaf_capabilities)

        reviewer = next(
            entry.agent.wrapped for entry in subagents.agents if entry.name == "reviewer"
        )
        reviewer_capabilities = reviewer.root_capability.capabilities
        assert any(isinstance(capability, Planning) for capability in reviewer_capabilities)
        assert not any(isinstance(capability, SubAgents) for capability in reviewer_capabilities)
        _has_context_stack(list(reviewer_capabilities))
        reviewer_code = next(
            capability for capability in reviewer_capabilities if isinstance(capability, CodeMode)
        )
        mount_modes = {mount.virtual_path: mount.mode for mount in reviewer_code.mount}
        assert mount_modes == {
            "/source": "read-only",
            "/skill": "read-only",
            "/wiki": "read-only",
        }
    finally:
        workspace.cleanup()


def test_optional_reviewer_model_is_wired_into_roster(tmp_path: Path) -> None:
    """Adaptive roster Reviewer uses reviewer_model when provided."""

    def reviewer_fn(messages, info):
        del messages, info
        return ModelResponse(parts=[TextPart("unused")])

    reviewer_model = FunctionModel(reviewer_fn)
    agent, orchestration, workspace = _builder(
        tmp_path,
        WikiRunLimits(),
        reviewer_model=reviewer_model,
        reviewer_settings=ModelSettings(temperature=0.1),
    )
    try:
        assert orchestration.policy.enable_reviewer
        capabilities = agent.root_capability.capabilities
        subagents = next(
            capability for capability in capabilities if isinstance(capability, SubAgents)
        )
        reviewer = next(
            entry.agent.wrapped for entry in subagents.agents if entry.name == "reviewer"
        )
        assert reviewer.model is reviewer_model
        # Root keeps the producer TestModel from model="test".
        assert agent.model is not reviewer_model
    finally:
        workspace.cleanup()


def test_reviewer_can_be_disabled_from_the_roster(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    source.mkdir()
    skill.mkdir()
    staging.mkdir()
    workspace = AnalysisWorkspace("a" * 32, root=tmp_path / "analysis")
    try:
        assembly = build_root_assembly(
            model="test",
            settings=ModelSettings(),
            output_type=str,
            instructions="test",
            source_mount=source,
            skill_mount=skill,
            staging=staging,
            workspace=workspace,
            run_id="c" * 32,
            limits=WikiRunLimits(adaptive_enable_reviewer=False),
            adaptive=True,
            write_limit=1_000_000,
            emit=lambda *_args, **_kwargs: None,
        )
        assert assembly.policy.enabled
        assert not assembly.policy.enable_reviewer
        assert set(assembly.root_subagent_names()) == {"domain_1", "domain_2"}
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
    # Two domains @ 6/25k plus one Reviewer @ 5/30k when max_depth=1 (no leaves).
    domain_only = AdaptivePolicy(enabled=True, max_depth=1)
    assert domain_only.child_count_reservation() == (17, 80_000)
    research_only = AdaptivePolicy(enabled=True, max_depth=1, enable_reviewer=False)
    assert research_only.child_count_reservation() == (12, 50_000)
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
            request_limit=80,
            total_tokens_limit=550_000,
        ),
    )
    try:
        assert orchestration.policy.enabled
        subagents = next(
            capability
            for capability in agent.root_capability.capabilities
            if isinstance(capability, SubAgents)
        )
        # Four domains plus the optional Reviewer.
        assert len(subagents.agents) == 5
        assert {entry.name for entry in subagents.agents} == {
            "domain_1",
            "domain_2",
            "domain_3",
            "domain_4",
            "reviewer",
        }
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
                    request_limit=60,
                    tool_calls_limit=80,
                    total_tokens_limit=400_000,
                    adaptive_source_files_threshold=1,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
                auto_approve_publication=True,
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
                    request_limit=60,
                    tool_calls_limit=100,
                    total_tokens_limit=400_000,
                    adaptive_source_files_threshold=1,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
                auto_approve_publication=True,
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
                    request_limit=60,
                    tool_calls_limit=100,
                    total_tokens_limit=400_000,
                    adaptive_source_files_threshold=1,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
                auto_approve_publication=True,
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


def test_reviewer_loads_skill_reference_and_publishes_a_defects_receipt(
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
        if "You are a Wiki Reviewer." in instructions:
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+), "
                r"attempt=(\d+)",
                instructions,
            )
            assert assignment is not None
            run_id, task_id, node_id, parent_id, attempt = assignment.groups()
            # Mid-run roster uses ``reviewer``; Run Boundary pre-publish uses ``publish-reviewer``.
            assert task_id in {"reviewer", "publish-reviewer"}
            assert node_id == task_id and parent_id == "root"
            if not run_code_returns:
                # Load the product review skill, then inspect staged wiki before publishing.
                code = (
                    "from pathlib import Path\n"
                    "skill = Path('/skill/references/review.md').read_text()\n"
                    "wiki = Path('/wiki/index.md').read_text()\n"
                    "assert 'Review' in skill or 'review' in skill.lower()\n"
                    "assert 'Wiki' in wiki\n"
                    "handoff = publish_receipt("
                    f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                    f"attempt={attempt}, status='complete', scope='review:wiki', "
                    "summary='reviewed staged pages against skill', "
                    "findings=['no critical defects'])\nprint(handoff)"
                )
                return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
            content = run_code_returns[-1].content
            if isinstance(content, dict):
                content = content.get("output", "")
            # Surface sandbox failures rather than masking them as handoff validation noise.
            text = str(content)
            assert "Traceback" not in text and "Error" not in text, text
            return ModelResponse(parts=[TextPart(text.strip())])

        if "You are a Domain Researcher." in instructions:
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
                    "summary='domain ready for review')\nprint(handoff)"
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
                "'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')\n"
                "review = await delegate_task(agent_name='reviewer', "
                "task='Review staged pages against /skill/references/review.md.')\n"
                "print(result)\nprint(review)"
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

    result, events = _run_adaptive(tmp_path, source, revision, model)
    assert isinstance(result, Complete)
    assert (tmp_path / "published" / "index.md").is_file()
    assert any(event.type == "child_started" and event.node_id == "reviewer" for event in events)
    assert any(
        event.type == "receipt_published" and event.node_id == "reviewer" for event in events
    )


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
                    request_limit=60,
                    tool_calls_limit=100,
                    total_tokens_limit=400_000,
                    adaptive_source_files_threshold=1,
                    adaptive_dynamic_workflow=True,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
                auto_approve_publication=True,
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


def test_leaf_timeout_is_shorter_than_domain_timeout(tmp_path: Path) -> None:
    agent, orchestration, workspace = _builder(tmp_path, WikiRunLimits())
    try:
        assert orchestration.policy.child_timeout_seconds == 120.0
        assert orchestration.policy.leaf_timeout_seconds == 90.0
        subagents = next(
            capability
            for capability in agent.root_capability.capabilities
            if isinstance(capability, SubAgents)
        )
        domain = next(entry for entry in subagents.agents if entry.name == "domain_1")
        assert domain.timeout_seconds == 120.0
        assert domain.max_calls == 2
        assert subagents.tool_retries == 1
        domain_agent = domain.agent.wrapped
        domain_sub = next(
            capability
            for capability in domain_agent.root_capability.capabilities
            if isinstance(capability, SubAgents)
        )
        leaf = domain_sub.agents[0]
        assert leaf.timeout_seconds == 90.0
        assert domain_sub.tool_retries == 1
        # concurrency 4, domain_fanout 2 → at most 2 concurrent Domains so Leaf slots remain.
        assert orchestration.event_payload()["max_active"] == 0
        assert orchestration.event_payload()["queue_seconds_total"] == 0.0
    finally:
        workspace.cleanup()


def test_domain_concurrency_reserves_leaf_fanout_slots(tmp_path: Path) -> None:
    agent, orchestration, workspace = _builder(
        tmp_path,
        WikiRunLimits(adaptive_child_concurrency=4, adaptive_domain_fanout=2),
    )
    try:
        # Run Boundary must not allow 3 Domains to occupy 3 of 4 global slots when each Domain
        # may still fan out 2 Leaves (only one Leaf slot would remain).
        # Global child concurrency remains 4; domain parent gate reserves leaf capacity.
        assert orchestration.policy.child_concurrency == 4
        assert orchestration.policy.domain_fanout == 2
        assert orchestration.root_deps.semaphore._value == 4  # type: ignore[attr-defined]
        # Reserved domain capacity: child_concurrency - domain_fanout = 2
        # (see build_root_assembly domain_semaphore construction).
        expected_domain_capacity = max(
            1, orchestration.policy.child_concurrency - orchestration.policy.domain_fanout
        )
        assert expected_domain_capacity == 2
        subagents = next(
            capability
            for capability in agent.root_capability.capabilities
            if isinstance(capability, SubAgents)
        )
        domain_wrapper = next(entry.agent for entry in subagents.agents if entry.name == "domain_1")
        parent = domain_wrapper._parent_semaphore  # type: ignore[attr-defined]
        assert parent is not None
        assert parent._value == expected_domain_capacity  # type: ignore[attr-defined]
    finally:
        workspace.cleanup()


def test_unresolved_critical_branch_preserves_previous_published_wiki(tmp_path: Path) -> None:
    source, revision = _repository(tmp_path)
    publication = tmp_path / "published"

    def publish_model(messages, info: AgentInfo) -> ModelResponse:
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        if not run_code_returns:
            code = (
                "from pathlib import Path\n"
                "Path('/wiki/index.md').write_text("
                "'---\\ntitle: Prior\\n---\\n# Prior\\n\\n[Source](repo:README.md#L1-L1)\\n')\n"
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

    first = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=ProducerSkillVersion.default(),
                model=ModelProviderConfig(model=FunctionModel(publish_model)),
                limits=WikiRunLimits(
                    request_limit=5,
                    tool_calls_limit=10,
                    retries=0,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                    adaptive_source_files_threshold=10_000,
                ),
                staging=tmp_path / "staging-prior",
                publication=publication,
                auto_approve_publication=True,
            )
        )
    )
    assert isinstance(first, Complete)
    prior = (publication / "index.md").read_text(encoding="utf-8")
    assert "Prior" in prior

    def failing_adaptive(messages, info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        if "You are a Domain Researcher." in instructions:
            return ModelResponse(parts=[TextPart("not a receipt")])
        if not run_code_returns:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "run_code",
                        {
                            "code": (
                                "result = await delegate_task("
                                "agent_name='domain_1', task='fail deliberately')\n"
                                "from pathlib import Path\n"
                                "Path('/wiki/index.md').write_text("
                                "'---\\ntitle: Bad\\n---\\n# Bad\\n\\n"
                                "[Source](repo:README.md#L1-L1)\\n')\n"
                                "print(result)"
                            )
                        },
                    )
                ]
            )
        complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
        return ModelResponse(
            parts=[
                ToolCallPart(
                    complete.name, {"status": "complete", "manifest": {"pages": ["index.md"]}}
                )
            ]
        )

    with pytest.raises(Exception):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=revision),),
                    skill=ProducerSkillVersion.default(),
                    model=ModelProviderConfig(model=FunctionModel(failing_adaptive)),
                    limits=WikiRunLimits(
                        request_limit=60,
                        tool_calls_limit=100,
                        total_tokens_limit=400_000,
                        adaptive_source_files_threshold=1,
                        adaptive_enable_reviewer=False,
                        retries=2,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=tmp_path / "staging-bad",
                    publication=publication,
                    auto_approve_publication=True,
                )
            )
        )
    assert (publication / "index.md").read_text(encoding="utf-8") == prior


def test_parent_direct_fallback_receipt_clears_failed_child(tmp_path: Path) -> None:
    source, revision = _repository(tmp_path)
    captured: dict[str, str] = {}

    def fallback_model(messages, info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        run_code_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
        ]
        if "You are a Domain Researcher." in instructions:
            return ModelResponse(parts=[TextPart("not a receipt")])
        if not run_code_returns:
            code = (
                "first = await delegate_task(agent_name='domain_1', task='fail-1')\n"
                "second = await delegate_task(agent_name='domain_1', task='fail-2')\n"
                "print(first)\nprint(second)\n"
            )
            return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])
        if len(run_code_returns) == 1:
            code = (
                f"handoff = publish_fallback_receipt("
                f"run_id='{captured['run_id']}', task_id='domain-1', node_id='domain-1', "
                f"parent_id='root', attempt=3, scope='domain:domain-1', "
                f"summary='root fallback after retries')\n"
                "from pathlib import Path\n"
                "Path('/wiki/index.md').write_text("
                "'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n[Source](repo:README.md#L1-L1)\\n')\n"
                "print(handoff)"
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

    def capture(event: WikiRunEvent) -> None:
        events.append(event)
        if event.type == "run_created":
            captured["run_id"] = event.run_id

    result = asyncio.run(
        WikiRunApplication(observer=capture).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=ProducerSkillVersion.default(),
                model=ModelProviderConfig(model=FunctionModel(fallback_model)),
                limits=WikiRunLimits(
                    request_limit=60,
                    tool_calls_limit=100,
                    total_tokens_limit=400_000,
                    adaptive_source_files_threshold=1,
                    adaptive_enable_reviewer=False,
                    retries=2,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
                auto_approve_publication=True,
            )
        )
    )
    assert isinstance(result, Complete)
    assert any(
        event.type == "receipt_published" and event.payload.get("fallback") for event in events
    )
