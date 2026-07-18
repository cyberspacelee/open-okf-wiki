"""Producer Skill version and fork tests."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.host import (
    Complete,
    ModelProviderConfig,
    ProducerSkillFork,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiManifest,
    WikiChangeSummary,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
)

from wiki_run_helpers import (
    REQUIRED_PRODUCER_SKILL_PATHS,
    make_repository,
)


def test_default_producer_skill_is_a_complete_content_addressed_version() -> None:
    version = ProducerSkillVersion.default()

    assert {
        path.relative_to(version.path).as_posix()
        for path in version.path.rglob("*")
        if path.is_file()
    } == REQUIRED_PRODUCER_SKILL_PATHS
    assert version.digest == "9f409d481942416264ea5be185195369e08246c99d5f4721813a18e3eadc115d"


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("missing", "missing required file: references/generate.md"),
        ("unreadable", "unreadable file: references/generate.md"),
        ("malformed", "SKILL.md has invalid YAML frontmatter"),
        ("ambiguous", "ambiguous paths"),
    ],
)
def test_wiki_run_rejects_an_invalid_skill_before_model_work(
    tmp_path: Path, case: str, message: str
) -> None:
    source = tmp_path / "source"
    source_revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    version = fork.version()
    if case == "missing":
        (fork.path / "references/generate.md").unlink()
    elif case == "unreadable":
        (fork.path / "references/generate.md").chmod(0)
    elif case == "malformed":
        (fork.path / "SKILL.md").write_text("---\nname: [\n---\nBroken\n", encoding="utf-8")
    else:
        (fork.path / "references/GENERATE.md").write_text("# Ambiguous\n", encoding="utf-8")
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run for an invalid Producer Skill")

    with pytest.raises(ValueError, match=message):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                    auto_approve_publication=True,
                )
            )
        )

    assert not model_called


def test_wiki_run_rejects_a_changed_selected_skill_version_before_model_work(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source_revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    selected = fork.version()
    template = fork.path / "templates/overview.md"
    template.write_text(template.read_text(encoding="utf-8") + "\nAudience: operators\n")
    model_called = False

    def model(_: list[ModelRequest | ModelResponse], __: AgentInfo) -> ModelResponse:
        nonlocal model_called
        model_called = True
        raise AssertionError("model must not run with a changed Skill Version")

    with pytest.raises(ValueError, match="Selected Skill Version content changed"):
        asyncio.run(
            WikiRunApplication().run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=selected,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(),
                    staging=tmp_path / "staging",
                    publication=tmp_path / "published",
                    auto_approve_publication=True,
                )
            )
        )

    assert not model_called


def test_skill_fork_is_an_owned_copy_that_product_versions_cannot_overwrite(
    tmp_path: Path,
) -> None:
    default = ProducerSkillVersion.default()
    default_template = (default.path / "templates/overview.md").read_text(encoding="utf-8")
    fork = ProducerSkillFork.create(default, tmp_path / "my-skill")
    fork_template = fork.path / "templates/overview.md"
    customized = default_template + "\nAudience: maintainers\n"
    fork_template.write_text(customized, encoding="utf-8")

    with pytest.raises(ValueError, match="destination must not already exist"):
        ProducerSkillFork.create(default, fork.path)

    assert fork_template.read_text(encoding="utf-8") == customized
    assert (default.path / "templates/overview.md").read_text(encoding="utf-8") == default_template
    assert fork.version().digest != default.digest


def test_skill_fork_does_not_remove_a_competing_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "skill"
    marker = destination / "owned-by-competitor"
    mkdir = os.mkdir

    def race(path: str | os.PathLike[str], mode: int = 0o777) -> None:
        if Path(path) == destination:
            mkdir(path, mode)
            marker.write_text("keep\n", encoding="utf-8")
            raise FileExistsError(path)
        mkdir(path, mode)

    monkeypatch.setattr(os, "mkdir", race)

    with pytest.raises(ValueError, match="destination must not already exist"):
        ProducerSkillFork.create(ProducerSkillVersion.default(), destination)

    assert marker.read_text(encoding="utf-8") == "keep\n"


@pytest.mark.parametrize("customization_path", ["references/generate.md", "templates/overview.md"])
def test_skill_fork_customization_changes_wiki_output_through_the_same_run_seam(
    tmp_path: Path, customization_path: str
) -> None:
    source = tmp_path / "source"
    source_revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    customizable = fork.path / customization_path

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
                        "code": f"""from pathlib import Path
customization = Path('/skill/{customization_path}').read_text()
marker = [line[len('Customization: '):] for line in customization.splitlines() if line.startswith('Customization: ')][0]
Path('/wiki/index.md').write_text(f'---\\ntitle: Wiki\\n---\\n# Wiki\\n\\n{{marker}}\\n\\n[Source](repo:README.md#L1-L1)\\n')
""",
                    },
                )
            ]
        )

    application = WikiRunApplication()

    def run(version: ProducerSkillVersion, name: str) -> str:
        asyncio.run(
            application.run(
                WikiRunRequest(
                    repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                    skill=version,
                    model=ModelProviderConfig(model=FunctionModel(model)),
                    limits=WikiRunLimits(
                        request_limit=3,
                        tool_calls_limit=2,
                        retries=0,
                        request_timeout_seconds=5,
                        tool_timeout_seconds=5,
                    ),
                    staging=tmp_path / f"{name}-staging",
                    publication=tmp_path / f"{name}-published",
                    auto_approve_publication=True,
                )
            )
        )
        return (tmp_path / f"{name}-published/index.md").read_text(encoding="utf-8")

    original = customizable.read_text(encoding="utf-8")
    customizable.write_text(original + "\nCustomization: platform team\n", encoding="utf-8")
    first = run(fork.version(), "first")
    customizable.write_text(original + "\nCustomization: library users\n", encoding="utf-8")
    second = run(fork.version(), "second")

    assert "platform team" in first
    assert "library users" in second
    assert first != second


def test_wiki_run_freezes_source_and_skill_before_model_work(tmp_path: Path) -> None:
    source = tmp_path / "source"
    skill = tmp_path / "skill"
    staging = tmp_path / "staging"
    source_text = "# Example repository\n\nThe source marker is SOURCE-FIRST.\n"
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), skill)
    skill_text = """---
name: repository-wiki-producer
description: Produce a source-grounded Wiki.
---

# Producer Skill

Use the skill marker SKILL-FIRST.
"""
    source_revision = make_repository(source, source_text)
    (skill / "SKILL.md").write_text(skill_text, encoding="utf-8")
    skill_version = fork.version()
    originals_changed = False

    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        nonlocal originals_changed
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
        (source / "README.md").write_text("changed after snapshot\n", encoding="utf-8")
        (skill / "SKILL.md").write_text("changed after snapshot\n", encoding="utf-8")
        originals_changed = True
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
Path('/wiki/index.md').write_text('---\\ntitle: Example Wiki\\n---\\n# Example Wiki\\n\\n' + skill + '\\n' + source + '\\n[Source](repo:README.md#L1-L3)\\n')
"""
                    },
                )
            ]
        )

    result = asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=source_revision),),
                skill=skill_version,
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
                publication=tmp_path / "published",
                auto_approve_publication=True,
            )
        )
    )

    assert result == Complete(
        manifest=WikiManifest(pages=["index.md"]),
        summary=WikiChangeSummary(
            added=["index.md"], content_changed=True, publication_changed=True
        ),
    )
    assert (staging / "index.md").read_text(encoding="utf-8") == (
        "---\ntitle: Example Wiki\n---\n# Example Wiki\n\n"
        + skill_text
        + "\n"
        + source_text
        + "\n[Source](repo:README.md#L1-L3)\n"
    )
    assert originals_changed
    assert (source / "README.md").read_text(encoding="utf-8") == "changed after snapshot\n"
    assert (skill / "SKILL.md").read_text(encoding="utf-8") == "changed after snapshot\n"
    metadata = json.loads((tmp_path / "published" / ".okf-wiki.json").read_text(encoding="utf-8"))
    assert metadata["skill_digest"] == skill_version.digest
