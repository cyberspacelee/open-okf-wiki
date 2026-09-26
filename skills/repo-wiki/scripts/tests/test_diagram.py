from _diagram import check
from _markdown import extract


def _check(source: str) -> list[tuple[int, str, str]]:
    return check(extract(f"Intro.\n\n```mermaid\n{source}\n```\n"))


def test_supported_diagrams_pass():
    for source in (
        "flowchart LR\n  A --> B",
        "graph TD; A-->B",
        "sequenceDiagram\n  Client->>API: POST /runs",
        "stateDiagram-v2\n  [*] --> Draft",
        "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
        "classDiagram\n  Animal <|-- Duck",
        "%% comment first\nflowchart LR\n  A --> B",
    ):
        assert _check(source) == [], source


def test_acc_title_not_required():
    assert _check("flowchart LR\n  A --> B") == []


def test_unsupported_header():
    [(line, message, fix)] = _check('pie\n  "a" : 1')
    assert line == 4
    assert "pie" in message
    assert "flowchart" in fix


def test_empty_fence():
    [(line, message, _)] = check(extract("```mermaid\n%% only comment\n```\n"))
    assert line == 1
    assert "empty" in message


def test_header_without_content():
    [(line, message, _)] = _check("flowchart LR")
    assert line == 3
    assert "no content" in message


def test_dangling_connectors_reported_per_line():
    problems = _check("flowchart LR\n  A -->\n  B --> C\n  C ---")
    assert [line for line, _, _ in problems] == [5, 7]
    assert all("no target" in message for _, message, _ in problems)


def test_unclosed_fence():
    [(line, message, fix)] = check(extract("## D\n```mermaid\nflowchart LR\nA-->B\n"))
    assert line == 2
    assert "not closed" in message
    assert fix


def test_non_mermaid_fences_ignored():
    assert check(extract("```python\nx -->\n```\n")) == []


def test_every_fence_checked():
    body = "```mermaid\nbogus\n```\n\n```mermaid\nflowchart LR\nA-->\n```\n"
    assert [line for line, _, _ in check(extract(body))] == [2, 7]
