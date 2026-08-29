import re

from _markdown import CodeFence, Structure
from _models import DiagramSpec

_ID = re.compile(r"^\s*%%\s*okf-id:\s*([a-z0-9][a-z0-9-]*)\s*$", re.MULTILINE)
_TITLE = re.compile(r"^\s*accTitle\s*:\s*(\S.*)$", re.MULTILINE)
_DESCRIPTION = re.compile(
    r"^\s*accDescr\s*:\s*(\S.*)$|^\s*accDescr\s*\{\s*([^}]*\S[^}]*)\s*\}",
    re.MULTILINE | re.DOTALL,
)
_FOOTNOTE = re.compile(r"\[\^([^\]]+)\]")
_HEADERS = (
    (re.compile(r"(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?"), "flowchart"),
    (re.compile(r"sequenceDiagram"), "sequence"),
    (re.compile(r"stateDiagram(?:-v2)?"), "state"),
    (re.compile(r"erDiagram"), "er"),
)
_DANGLING_CONNECTOR = re.compile(
    r"(?:-->|---|-\.->|==>|->>|-->>|->|-\)|--\)|--x|--o)\s*$"
)


def _basic_structure(source: str) -> tuple[str | None, str | None]:
    lines = [
        line
        for raw in source.splitlines()
        if (line := raw.strip()) and not line.startswith("%%")
    ]
    if not lines:
        return None, "Mermaid fence has no diagram declaration or content"
    header, separator, inline_body = lines[0].partition(";")
    kind = next(
        (kind for pattern, kind in _HEADERS if pattern.fullmatch(header.strip())),
        None,
    )
    if kind is None:
        return None, "Mermaid fence must start with a supported diagram declaration"

    body = [inline_body.strip()] if separator and inline_body.strip() else []
    in_description = False
    for line in lines[1:]:
        if in_description:
            if "}" in line:
                in_description = False
            continue
        if line.startswith("accDescr"):
            in_description = "{" in line and "}" not in line
            continue
        if not line.startswith("accTitle"):
            body.append(line)
    if not body:
        return None, "Mermaid fence has no diagram content"
    for line in body:
        code = line.split("%%", 1)[0].rstrip(" ;")
        if _DANGLING_CONNECTOR.search(code):
            return None, f"Mermaid connector has no target: {line}"
    return kind, None


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

    for fence in fences:
        kind, error = _basic_structure(fence.content)
        if error:
            issues.append(("mermaid-structure-invalid", error, fence.start_line))
            continue
        ids = _ID.findall(fence.content)
        if len(ids) == 1 and ids[0] in actual:
            actual[ids[0]] = kind
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
