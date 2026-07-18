"""Shared fixtures and helpers for Wiki Run tests."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Literal

from pydantic_ai import ModelRequest, ModelResponse, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from okf_wiki.host import (
    AnalysisReceipt,
    Complete,
    ModelProviderConfig,
    NeedsInput,
    ProducerSkillFork,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunRequest,
    resolve_effective_source_ignores,
)


REQUIRED_PRODUCER_SKILL_PATHS = {
    "SKILL.md",
    "references/domain-research.md",
    "references/generate.md",
    "references/leaf-research.md",
    "references/refresh.md",
    "references/review.md",
    "templates/architecture.md",
    "templates/concept.md",
    "templates/flow.md",
    "templates/module.md",
    "templates/overview.md",
}


def make_repository(path: Path, source_text: str) -> str:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    (path / "README.md").write_text(source_text, encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def make_published_wiki(path: Path) -> Path:
    """Create a prior real-directory Published Wiki (not a legacy symlink layout)."""
    path.mkdir(parents=True)
    (path / "index.md").write_text("old publication\n", encoding="utf-8")
    releases = path.parent / f".{path.name}.releases"
    releases.mkdir(exist_ok=True)
    return path


def make_producer_skill(path: Path) -> ProducerSkillVersion:
    return ProducerSkillFork.create(ProducerSkillVersion.default(), path).version()


def writing_model(
    code: str, pages: list[str], *, summary: dict[str, object] | None = None
) -> FunctionModel:
    def model(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        # Host-owned Wiki Reviewer (pre-publish) and adaptive roster Reviewer share this prompt.
        if "You are a Wiki Reviewer." in instructions:
            return _reviewer_function_response(messages, instructions)

        tool_returns = [
            part
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        if any(part.tool_name == "run_code" for part in tool_returns):
            complete = next(tool for tool in info.output_tools if tool.name.endswith("Complete"))
            payload: dict[str, object] = {
                "status": "complete",
                "manifest": {"pages": pages},
            }
            if summary is not None:
                payload["summary"] = summary
            return ModelResponse(parts=[ToolCallPart(complete.name, payload)])
        return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])

    return FunctionModel(model)


def _reviewer_function_response(
    messages: list[ModelRequest | ModelResponse], instructions: str
) -> ModelResponse:
    """Scripted Reviewer: publish a defects receipt via CodeMode, then return the Handoff Ref.

    ``publish_receipt`` is exposed inside the CodeMode sandbox (not as a top-level tool),
    matching the adaptive roster Reviewer tests.
    """
    import re

    from pydantic_ai.messages import TextPart

    run_code_returns = [
        part
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
    ]
    if run_code_returns:
        content = run_code_returns[-1].content
        if isinstance(content, dict):
            content = content.get("output", content)
        text = str(content).strip()
        assert "Traceback" not in text and "Error" not in text, text
        return ModelResponse(parts=[TextPart(text)])

    assignment = re.search(
        r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+), "
        r"attempt=(\d+)",
        instructions,
    )
    if assignment is None:
        raise AssertionError("Wiki Reviewer Host assignment missing from instructions")
    run_id, task_id, node_id, parent_id, attempt = assignment.groups()
    code = (
        "handoff = publish_receipt("
        f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
        f"attempt={attempt}, status='complete', scope='review:{task_id}', "
        "summary='no critical defects', findings=[])\n"
        "print(handoff)"
    )
    return ModelResponse(parts=[ToolCallPart("run_code", {"code": code})])


TEST_WIKI_LIMITS = WikiRunLimits(
    request_limit=3,
    tool_calls_limit=2,
    retries=0,
    request_timeout_seconds=5,
    tool_timeout_seconds=5,
)
SIMPLE_WIKI_PAGE = "---\ntitle: Wiki\n---\n# Wiki\n\n[Source](repo:README.md#L1-L1)\n"


def expected_published_repository(
    revision: str,
    *,
    ignore: tuple[str, ...] = (),
    apply_default_source_ignores: bool = True,
) -> dict[str, object]:
    return {
        "id": "source",
        "revision": revision,
        "ignore": list(ignore),
        "apply_default_source_ignores": apply_default_source_ignores,
        "effective_ignore": list(
            resolve_effective_source_ignores(
                apply_default_source_ignores=apply_default_source_ignores,
                user_ignore=ignore,
            )
        ),
    }


def write_pages_code(pages: dict[str, str]) -> str:
    return "from pathlib import Path\n" + "\n".join(
        f"Path('/wiki/{path}').write_text({content!r})" for path, content in pages.items()
    )


def run_test_wiki(
    source: Path,
    revision: str,
    skill: ProducerSkillVersion,
    staging: Path,
    publication: Path,
    model: FunctionModel,
    *,
    operation: Literal["generate", "refresh"] = "generate",
    auto_approve_publication: bool = True,
) -> Complete | NeedsInput:
    return asyncio.run(
        WikiRunApplication().run(
            WikiRunRequest(
                operation=operation,
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(model=model),
                limits=TEST_WIKI_LIMITS,
                staging=staging,
                publication=publication,
                # Tests that assert a published wiki auto-approve by default (YOLO path).
                # HITL awaiting/approve cases set this False and/or inject a handler.
                auto_approve_publication=auto_approve_publication,
            )
        )
    )


def publish_test_pages(
    source: Path,
    revision: str,
    skill: ProducerSkillVersion,
    staging: Path,
    publication: Path,
    pages: dict[str, str],
) -> Complete | NeedsInput:
    return run_test_wiki(
        source,
        revision,
        skill,
        staging,
        publication,
        writing_model(write_pages_code(pages), list(pages)),
    )


def generated_test_wiki(
    tmp_path: Path, page: str = SIMPLE_WIKI_PAGE
) -> tuple[Path, str, ProducerSkillFork, Path]:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), tmp_path / "skill")
    publication = tmp_path / "published"
    publish_test_pages(
        source,
        revision,
        fork.version(),
        tmp_path / "generate-staging",
        publication,
        {"index.md": page},
    )
    return source, revision, fork, publication


def publication_state(publication: Path) -> tuple[int, int, dict[str, bytes]]:
    """Identity of a real-directory Published Wiki: inode + file bytes."""
    release = publication.resolve()
    files = {
        path.relative_to(release).as_posix(): path.read_bytes()
        for path in release.rglob("*")
        if path.is_file() and not path.is_symlink()
    }
    info = os.lstat(publication)
    return (info.st_dev, info.st_ino, files)


def run_records(publication: Path) -> list[dict[str, Any]]:
    directory = publication.parent / f".{publication.name}.runs"
    return [json.loads(path.read_bytes()) for path in sorted(directory.glob("*.json"))]


def analysis_workspace_paths(run_id: str) -> set[Path]:
    return set(Path(tempfile.gettempdir()).glob(f"okf-analysis-{run_id[:8]}-*"))


def _minimal_receipt(
    run_id: str = "run-1", node_id: str = "node-1", attempt: int = 1
) -> AnalysisReceipt:
    return AnalysisReceipt(
        run_id=run_id,
        node_id=node_id,
        attempt=attempt,
        status="complete",
        scope="scope",
        summary="bounded summary",
    )
