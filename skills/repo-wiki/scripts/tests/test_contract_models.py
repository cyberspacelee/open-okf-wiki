import pytest
from _models import (
    CompositionMap,
    CompositionPage,
    KnowledgeDossier,
    KnowledgePlan,
    PageScope,
    ReviewReport,
)
from pydantic import ValidationError


def scope(paths=None) -> dict:
    return {"source": "src", "paths": ["app.py"] if paths is None else paths}


def unit(unit_id="answer-lifecycle", **overrides) -> dict:
    return {
        "id": unit_id,
        "kind": "lifecycle",
        "owner": "src",
        "question": "How does the answer move through its lifecycle?",
        "scopes": [scope()],
        "evidence_seeds": ["src/app.py#L1-L2"],
        **overrides,
    }


def page(page_id: str, path: str, **overrides) -> dict:
    page_type = "Overview" if path == "overview.md" else "Architecture"
    return {
        "id": page_id,
        "path": path,
        "type": page_type,
        "owner": "workspace",
        "title": page_id.title(),
        "description": "Read this before changing answer behavior.",
        "tags": ["answer"],
        "units": ["answer-lifecycle"],
        "scopes": [scope()],
        "evidence_seeds": ["src/app.py#L1-L2"],
        "parent": None,
        "depends_on": [],
        "diagrams": (
            []
            if page_type == "Overview"
            else [
                {
                    "id": "components",
                    "kind": "flowchart",
                    "question": "Which components depend on each other?",
                }
            ]
        ),
        **overrides,
    }


@pytest.mark.parametrize("path", [".", "src", "src/main/java", "build.gradle.kts"])
def test_page_scope_accepts_normalized_relative_paths(path):
    assert PageScope.model_validate(scope([path])).paths == [path]


@pytest.mark.parametrize(
    "path", ["", "/src", "C:/src", "../src", "./src", "src/", "src//main", r"src\main"]
)
def test_page_scope_rejects_non_normalized_paths(path):
    with pytest.raises(ValidationError):
        PageScope.model_validate(scope([path]))


def test_knowledge_plan_is_strict_bounded_and_uses_stable_ids():
    plan = KnowledgePlan.model_validate(
        {"kind": "knowledge-plan", "units": [unit()], "gaps": []}
    )
    assert plan.units[0].id == "answer-lifecycle"
    assert not hasattr(plan.units[0], "path")

    with pytest.raises(ValidationError):
        KnowledgePlan.model_validate(
            {"kind": "knowledge-plan", "units": [unit(), unit()], "gaps": []}
        )
    with pytest.raises(ValidationError):
        KnowledgePlan.model_validate(
            {"kind": "knowledge-plan", "units": [unit()], "paths": []}
        )
    with pytest.raises(ValidationError):
        KnowledgePlan.model_validate(
            {"kind": "knowledge-plan", "units": [unit("Upper_ID")], "gaps": []}
        )


def test_dossier_ready_or_bounded_split_contract():
    ready = KnowledgeDossier.model_validate(
        {
            "kind": "knowledge-dossier",
            "unit_id": "answer-lifecycle",
            "disposition": "ready",
            "children": [],
        }
    )
    assert ready.children == []

    split = KnowledgeDossier.model_validate(
        {
            "kind": "knowledge-dossier",
            "unit_id": "answer-lifecycle",
            "disposition": "split",
            "children": [unit("answer-read"), unit("answer-write")],
        }
    )
    assert len(split.children) == 2

    with pytest.raises(ValidationError, match="at least two"):
        KnowledgeDossier.model_validate(
            {
                "kind": "knowledge-dossier",
                "unit_id": "answer-lifecycle",
                "disposition": "split",
                "children": [unit("answer-read")],
            }
        )
    with pytest.raises(ValidationError, match="must not define children"):
        KnowledgeDossier.model_validate(
            {
                "kind": "knowledge-dossier",
                "unit_id": "answer-lifecycle",
                "disposition": "ready",
                "children": [unit("answer-read")],
            }
        )


def test_composition_uses_id_relations_and_keeps_path_as_a_binding():
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "pages": [
                page("answer-details", "guides/answer.md"),
                page(
                    "overview",
                    "overview.md",
                    units=["workspace-overview"],
                    depends_on=["answer-details"],
                ),
            ],
            "gaps": [],
        }
    )
    moved = CompositionPage.model_validate(
        {**composition.pages[0].model_dump(mode="json"), "path": "reference/answer.md"}
    )
    assert moved.id == composition.pages[0].id
    assert moved.path != composition.pages[0].path


def test_composition_rejects_duplicate_paths_unknown_relations_and_cycles():
    with pytest.raises(ValidationError, match="paths must be unique"):
        CompositionMap.model_validate(
            {
                "kind": "composition-map",
                "pages": [page("one", "overview.md"), page("two", "overview.md")],
            }
        )
    with pytest.raises(ValidationError, match="composed page ids"):
        CompositionMap.model_validate(
            {
                "kind": "composition-map",
                "pages": [page("one", "overview.md", depends_on=["missing"])],
            }
        )
    with pytest.raises(ValidationError, match="cycle"):
        CompositionMap.model_validate(
            {
                "kind": "composition-map",
                "pages": [
                    page("one", "one.md", depends_on=["two"]),
                    page("two", "two.md", depends_on=["one"]),
                ],
            }
        )


def test_composition_validates_hierarchy_and_scheduling_as_separate_graphs():
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "pages": [
                page("details", "details.md", parent="architecture"),
                page(
                    "architecture",
                    "architecture.md",
                    units=["system-architecture"],
                    depends_on=["details"],
                ),
            ],
        }
    )
    assert composition.pages[0].parent == "architecture"
    assert composition.pages[1].depends_on == ["details"]


def test_composition_enforces_page_representation_contract():
    with pytest.raises(ValidationError, match="require a flowchart"):
        CompositionPage.model_validate(
            page("architecture", "architecture.md", diagrams=[])
        )
    with pytest.raises(ValidationError):
        CompositionPage.model_validate(page("overview", "../overview.md"))


def test_review_report_supports_structural_operations_on_stable_targets():
    report = ReviewReport.model_validate(
        {
            "subject": "page:compose",
            "subject_digest": "a" * 64,
            "verdict": "changes_requested",
            "issues": [
                {
                    "category": "concept-boundary",
                    "claim": "Two unrelated capabilities share one page.",
                    "resolution": "Split them in the Composition Map.",
                    "reopen_target": "page:compose",
                    "operation": "split",
                }
            ],
        }
    )
    assert report.issues[0].operation == "split"

    with pytest.raises(ValidationError):
        ReviewReport.model_validate(
            {
                "subject": "page:overview.md",
                "subject_digest": "a" * 64,
                "verdict": "approved",
                "issues": [],
            }
        )
    with pytest.raises(ValidationError):
        ReviewReport.model_validate(
            {
                "subject": "page:write/overview",
                "subject_digest": "a" * 64,
                "verdict": "approved",
                "issues": [
                    {
                        "category": "coverage",
                        "claim": "Missing behavior.",
                        "resolution": "Add it.",
                        "reopen_target": "page:write/overview",
                    }
                ],
            }
        )
