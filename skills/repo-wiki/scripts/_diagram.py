import re

import _files
from _markdown import CodeFence, Structure

_HEADERS = (
    re.compile(r"(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?"),
    re.compile(r"sequenceDiagram"),
    re.compile(r"stateDiagram(?:-v2)?"),
    re.compile(r"erDiagram"),
    re.compile(r"classDiagram(?:-v2)?"),
)
_DANGLING_CONNECTOR = re.compile(
    r"(?:-->|---|-\.->|==>|->>|-->>|->|-\)|--\)|--x|--o)\s*$"
)
_SUPPORTED = "flowchart, graph, sequenceDiagram, stateDiagram, erDiagram, classDiagram"


def _problems(fence: CodeFence) -> list[tuple[int, str, str]]:
    line = fence.start_line
    if fence.end_line is None:
        return [(line, "Mermaid fence is not closed", "Close the fence with ```.")]
    body = [
        (line + n, text)
        for n, raw in enumerate(_files.text_lines(fence.content), 1)
        if (text := raw.strip()) and not text.startswith("%%")
    ]
    if not body:
        return [(line, "Mermaid fence is empty", "Add a diagram or remove the fence.")]
    first_line, first = body[0]
    header, separator, inline = first.partition(";")
    if not any(pattern.fullmatch(header.strip()) for pattern in _HEADERS):
        return [
            (
                first_line,
                f"unsupported Mermaid diagram declaration: {header.strip()}",
                f"Start the fence with one of: {_SUPPORTED}.",
            )
        ]
    rest = body[1:]
    if separator and inline.strip():
        rest.insert(0, (first_line, inline.strip()))
    if not rest:
        return [(line, "Mermaid diagram has no content", "Add nodes and edges.")]
    return [
        (
            number,
            f"Mermaid connector has no target: {text}",
            "Add the target node after the connector.",
        )
        for number, text in rest
        if _DANGLING_CONNECTOR.search(text.split("%%", 1)[0].rstrip(" ;"))
    ]


def check(structure: Structure) -> list[tuple[int, str, str]]:
    return [
        problem
        for fence in structure.fences
        if fence.language == "mermaid"
        for problem in _problems(fence)
    ]
