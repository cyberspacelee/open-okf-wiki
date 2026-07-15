import asyncio
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.wiki_run import (
    Complete,
    ModelProviderConfig,
    ProducerSkillRevision,
    RepositorySnapshot,
    WikiManifest,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
)


def test_wiki_run_produces_typed_markdown_without_mutating_inputs(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    source.mkdir()
    skill.mkdir()
    source_text = "# Example repository\n\nThe source marker is SOURCE-FIRST.\n"
    skill_text = "# Producer Skill\n\nUse the skill marker SKILL-FIRST.\n"
    (source / "README.md").write_text(source_text, encoding="utf-8")
    (skill / "SKILL.md").write_text(skill_text, encoding="utf-8")

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        complete.name,
                        {"status": "complete", "manifest": {"pages": ["index.md"]}},
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "run_code",
                    {
                        "code": """from pathlib import Path
skill = Path('/skill/SKILL.md').read_text()
source = Path('/source/README.md').read_text()
source_write_blocked = False
skill_write_blocked = False
try:
    Path('/source/README.md').write_text('tampered')
except Exception:
    source_write_blocked = True
try:
    Path('/skill/SKILL.md').write_text('tampered')
except Exception:
    skill_write_blocked = True
assert source_write_blocked and skill_write_blocked
Path('/wiki/index.md').write_text('# Example Wiki\\n\\n' + skill + '\\n' + source)
"""
                    },
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repository=RepositorySnapshot(path=source, revision="source-rev"),
                skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
                model=ModelProviderConfig(model=FunctionModel(model)),
                limits=WikiRunLimits(
                    request_limit=3,
                    tool_calls_limit=2,
                    input_tokens_limit=10_000,
                    output_tokens_limit=2_000,
                    total_tokens_limit=12_000,
                    retries=1,
                    request_timeout_seconds=5,
                    tool_timeout_seconds=5,
                ),
                staging=staging,
            )
        )
    )

    assert result == Complete(manifest=WikiManifest(pages=["index.md"]))
    assert (staging / "index.md").read_text(encoding="utf-8") == (
        "# Example Wiki\n\n" + skill_text + "\n" + source_text
    )
    assert (source / "README.md").read_text(encoding="utf-8") == source_text
    assert (skill / "SKILL.md").read_text(encoding="utf-8") == skill_text


def test_wiki_run_rejects_nested_staging_without_creating_it(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = source / "staging"
    source.mkdir()
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Producer Skill\n", encoding="utf-8")

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        raise AssertionError("model must not run for invalid mounts")

    with pytest.raises(ValueError, match="must not overlap"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repository=RepositorySnapshot(path=source, revision="source-rev"),
                    skill=ProducerSkillRevision(path=skill, revision="skill-rev"),
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=staging,
                )
            )
        )

    assert not staging.exists()
