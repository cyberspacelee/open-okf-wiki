import json
import pathlib
import re
import subprocess

from _markdown import CodeFence, Structure
from _models import DiagramSpec

_ID = re.compile(r"^\s*%%\s*okf-id:\s*([a-z0-9][a-z0-9-]*)\s*$", re.MULTILINE)
_TITLE = re.compile(r"^\s*accTitle\s*:\s*(\S.*)$", re.MULTILINE)
_DESCRIPTION = re.compile(
    r"^\s*accDescr\s*:\s*(\S.*)$|^\s*accDescr\s*\{\s*([^}]*\S[^}]*)\s*\}",
    re.MULTILINE | re.DOTALL,
)
_FOOTNOTE = re.compile(r"\[\^([^\]]+)\]")


def _kind(diagram_type: str) -> str | None:
    if diagram_type.startswith("flowchart"):
        return "flowchart"
    if diagram_type == "sequence":
        return "sequence"
    if diagram_type == "stateDiagram":
        return "state"
    if diagram_type == "er":
        return "er"
    return None


def _caption_refs(structure: Structure, fence: CodeFence) -> set[str]:
    if fence.end_line is None:
        return set()
    paragraph = []
    for line in structure.lines[fence.end_line :]:
        stripped = line.strip()
        if not stripped:
            if paragraph:
                break
            continue
        if stripped.startswith(("#", "```", "~~~", "[^")):
            break
        paragraph.append(line)
    return set(_FOOTNOTE.findall("\n".join(paragraph)))


def _parse(sources: list[str]) -> tuple[list[dict] | None, str | None]:
    script = pathlib.Path(__file__).with_name("validate-mermaid.mjs")
    try:
        result = subprocess.run(
            ["node", str(script)],
            input=json.dumps(sources),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
    except OSError as exc:
        return None, f"Node.js is unavailable: {exc}"
    if result.returncode:
        return None, (result.stderr or result.stdout).strip()
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return None, f"Mermaid parser returned invalid JSON: {exc}"
    if not isinstance(parsed, list) or len(parsed) != len(sources):
        return None, "Mermaid parser returned an invalid result list"
    return parsed, None


def validate(
    structure: Structure, planned: list[DiagramSpec]
) -> list[tuple[str, str, int | None]]:
    issues: list[tuple[str, str, int | None]] = []
    fences = [fence for fence in structure.fences if fence.language == "mermaid"]
    unclosed = [fence for fence in fences if fence.end_line is None]
    for fence in unclosed:
        issues.append(
            ("mermaid-fence-unclosed", "Mermaid fence is not closed", fence.start_line)
        )
    fences = [fence for fence in fences if fence.end_line is not None]
    actual: dict[str, str | None] = {}
    for fence in fences:
        ids = _ID.findall(fence.content)
        if len(ids) != 1:
            issues.append(
                (
                    "diagram-id-invalid",
                    "each Mermaid fence requires exactly one %% okf-id comment",
                    fence.start_line,
                )
            )
            continue
        diagram_id = ids[0]
        if diagram_id in actual:
            issues.append(
                (
                    "diagram-id-duplicate",
                    f"duplicate diagram id: {diagram_id}",
                    fence.start_line,
                )
            )
        actual[diagram_id] = None
        if not _TITLE.search(fence.content):
            issues.append(
                (
                    "diagram-accessibility-missing",
                    f"{diagram_id} requires a non-empty accTitle",
                    fence.start_line,
                )
            )
        if not _DESCRIPTION.search(fence.content):
            issues.append(
                (
                    "diagram-accessibility-missing",
                    f"{diagram_id} requires a non-empty accDescr",
                    fence.start_line,
                )
            )
        if not _caption_refs(structure, fence):
            issues.append(
                (
                    "diagram-evidence-missing",
                    f"{diagram_id} requires an adjacent cited caption",
                    fence.end_line,
                )
            )

    if fences:
        parsed, error = _parse([fence.content for fence in fences])
        if error:
            issues.append(("mermaid-runtime-unavailable", error, None))
        else:
            assert parsed is not None
            for fence, result in zip(fences, parsed, strict=True):
                if not result.get("ok"):
                    issues.append(
                        (
                            "mermaid-syntax-invalid",
                            result.get("error", "Mermaid parse failed"),
                            fence.start_line,
                        )
                    )
                    continue
                ids = _ID.findall(fence.content)
                if len(ids) == 1 and ids[0] in actual:
                    actual[ids[0]] = _kind(result.get("diagramType", ""))
    expected = {diagram.id: diagram.kind for diagram in planned}
    if actual != expected:
        issues.append(
            (
                "diagram-plan-mismatch",
                f"planned diagrams {expected} do not match Mermaid diagrams {actual}",
                None,
            )
        )
    return issues
