import pytest
from _diagram import validate
from _markdown import extract
from _models import DiagramSpec


def spec(kind: str) -> list[DiagramSpec]:
    return [
        DiagramSpec.model_validate(
            {"id": "behavior", "kind": kind, "question": "What happens?"}
        )
    ]


@pytest.mark.parametrize(
    ("kind", "source"),
    [
        ("flowchart", "flowchart LR\n    A --> B"),
        ("sequence", "sequenceDiagram\n    A->>B: Request"),
        ("state", "stateDiagram-v2\n    [*] --> Ready"),
        ("er", "erDiagram\n    ORDER ||--|{ LINE : contains"),
    ],
)
def test_supported_mermaid_diagrams_have_basic_structure_and_match_the_plan(
    kind, source
):
    body = f"""```mermaid
%% okf-id: behavior
{source}
    accTitle: Behavior diagram
    accDescr: The diagram answers the planned behavior question.
```

The diagram summarizes the cited behavior.[^code]

[^code]: Source behavior
"""
    assert validate(extract(body), spec(kind)) == []


def test_diagram_requires_matching_id_kind_accessibility_and_cited_caption():
    body = """```mermaid
%% okf-id: actual
sequenceDiagram
    A->>B: Request
```

Uncited summary.
"""
    issues = validate(extract(body), spec("flowchart"))
    codes = {code for code, _, _ in issues}
    assert codes == {
        "diagram-accessibility-missing",
        "diagram-evidence-missing",
        "diagram-plan-mismatch",
    }


def test_basic_validator_rejects_a_dangling_connector():
    body = """```mermaid
%% okf-id: behavior
flowchart LR
    accTitle: Behavior diagram
    accDescr: The diagram answers the planned behavior question.
    A -->
```

The diagram summarizes the cited behavior.[^code]
"""
    assert "mermaid-structure-invalid" in {
        code for code, _, _ in validate(extract(body), spec("flowchart"))
    }


@pytest.mark.parametrize(
    "source",
    [
        "notDiagram\n    A --> B",
        "flowchart LR",
    ],
)
def test_basic_validator_rejects_an_unknown_declaration_or_empty_body(source):
    body = f"""```mermaid
%% okf-id: behavior
{source}
    accTitle: Behavior diagram
    accDescr: The diagram answers the planned behavior question.
```

The diagram summarizes the cited behavior.[^code]
"""
    assert "mermaid-structure-invalid" in {
        code for code, _, _ in validate(extract(body), spec("flowchart"))
    }


def test_unplanned_and_unclosed_mermaid_fences_are_rejected():
    body = """```mermaid
%% okf-id: behavior
flowchart LR
    A --> B
    """
    codes = {code for code, _, _ in validate(extract(body), [])}
    assert codes == {"mermaid-fence-unclosed"}
