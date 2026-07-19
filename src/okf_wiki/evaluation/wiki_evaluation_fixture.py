"""Credential-free Wiki evaluation fixtures; never used by live evaluation."""

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal, cast

from pydantic_ai import ModelRequest, ModelResponse, RequestUsage, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from ..run.security import GIT_EXECUTABLE


@dataclass(frozen=True, slots=True)
class FixtureCase:
    id: str
    size: Literal["small", "medium", "large"]
    structure: str
    expected_topics: list[str]
    repository: Path
    revision: str
    pages: dict[str, str]


def fixture_cases(root: Path) -> list[FixtureCase]:
    data = cast(
        list[dict[str, object]],
        json.loads(
            Path(__file__).with_name("wiki_evaluation_corpus.json").read_text(encoding="utf-8")
        ),
    )
    cases = []
    for raw in data:
        files = dict(cast(dict[str, str], raw["files"]))
        for number in range(1, cast(int, raw.get("generated_feature_count", 0)) + 1):
            files[f"packages/features/feature_{number:02}.py"] = (
                f'FEATURE_NAME = "feature-{number:02}"\n'
                "def register(registry):\n    registry.register(FEATURE_NAME, object())\n"
            )
        repository = root / "sources" / cast(str, raw["id"])
        cases.append(
            FixtureCase(
                id=cast(str, raw["id"]),
                size=cast(Literal["small", "medium", "large"], raw["size"]),
                structure=cast(str, raw["structure"]),
                expected_topics=cast(list[str], raw["expected_topics"]),
                repository=repository,
                revision=_create_repository(repository, cast(str, raw["id"]), files),
                pages=cast(dict[str, str], raw["pages"]),
            )
        )
    return cases


def fixture_model(case_id: str, pages: dict[str, str]) -> FunctionModel:
    code = ["from pathlib import Path"]
    for path, content in pages.items():
        code += [
            f"page = Path({'/wiki/' + path!r})",
            "page.parent.mkdir(parents=True, exist_ok=True)",
            f"page.write_text({content!r})",
        ]

    def respond(messages: list[ModelRequest | ModelResponse], info: AgentInfo) -> ModelResponse:
        instructions = info.instructions or ""
        if "You are a Wiki Reviewer." in instructions:
            from pydantic_ai.messages import TextPart
            import re

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
                return ModelResponse(
                    parts=[TextPart(str(content).strip())],
                    usage=RequestUsage(input_tokens=12, output_tokens=8),
                )
            assignment = re.search(
                r"run_id=([0-9a-f]{32}), task_id=([^,]+), node_id=([^,]+), parent_id=([^,]+), "
                r"attempt=(\d+)",
                instructions,
            )
            assert assignment is not None
            run_id, task_id, node_id, parent_id, attempt = assignment.groups()
            review_code = (
                "handoff = publish_receipt("
                f"run_id='{run_id}', node_id='{node_id}', parent_id='{parent_id}', "
                f"attempt={attempt}, status='complete', scope='review:{task_id}', "
                "summary='fixture review ok', findings=[])\nprint(handoff)"
            )
            return ModelResponse(
                parts=[ToolCallPart("run_code", {"code": review_code})],
                usage=RequestUsage(input_tokens=12, output_tokens=8),
            )

        returned = any(
            isinstance(part, ToolReturnPart) and part.tool_name == "run_code"
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        )
        part = (
            ToolCallPart(
                next(tool for tool in info.output_tools if tool.name.endswith("Complete")).name,
                {"status": "complete", "manifest": {"pages": list(pages)}},
            )
            if returned
            else ToolCallPart("run_code", {"code": "\n".join(code)})
        )
        return ModelResponse(parts=[part], usage=RequestUsage(input_tokens=12, output_tokens=8))

    return FunctionModel(respond, model_name=f"fixture:{case_id}:v1")


def _create_repository(root: Path, case_id: str, files: dict[str, str]) -> str:
    root.mkdir(parents=True)
    for relative, content in files.items():
        path = PurePosixPath(relative)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Unsafe evaluation fixture path: {relative}")
        destination = root.joinpath(*path.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
    home = root.parent / ".git-home"
    home.mkdir(exist_ok=True)
    environment = {
        "PATH": os.defpath,
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_DATE": "2000-01-01T00:00:00+00:00",
        "GIT_COMMITTER_DATE": "2000-01-01T00:00:00+00:00",
    }
    for arguments in (
        ("init", "-q", "--object-format=sha1"),
        ("add", "--all"),
        (
            "-c",
            f"core.hooksPath={os.devnull}",
            "-c",
            "user.name=Wiki Evaluation",
            "-c",
            "user.email=wiki-evaluation@example.invalid",
            "commit",
            "-qm",
            case_id,
        ),
    ):
        subprocess.run(
            [GIT_EXECUTABLE, *arguments], cwd=root, env=environment, check=True, capture_output=True
        )
    return subprocess.run(
        [GIT_EXECUTABLE, "rev-parse", "HEAD"],
        cwd=root,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
