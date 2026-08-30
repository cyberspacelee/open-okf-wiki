import pathlib

import pytest
from _frontmatter import parse_file
from _models import (
    CompositionMap,
    CompositionPage,
    KnowledgePlan,
    PageScope,
    PlanReviewReport,
    ReviewReport,
)
from pydantic import ValidationError


def scope(paths=None) -> dict:
    return {"source": "src", "paths": ["app.py"] if paths is None else paths}


def unit(unit_id="answer-lifecycle", **overrides) -> dict:
    return {
        "id": unit_id,
        "kind": "lifecycle",
        "question": "How does the answer move through its lifecycle?",
        "scopes": [scope()],
        "evidence_seeds": ["src/app.py#L1-L2"],
        **overrides,
    }


def page(page_id="answer", path="answer.md", **overrides) -> dict:
    return {
        "id": page_id,
        "path": path,
        "type": "Domain",
        "title": "Answer",
        "description": "Open before changing answer behavior.",
        "tags": ["answer"],
        "units": ["answer-lifecycle"],
        "diagrams": [],
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


def test_plan_owns_semantic_units_without_page_or_owner_fields():
    plan = KnowledgePlan.model_validate(
        {"kind": "knowledge-plan", "units": [unit()], "gaps": []}
    )
    assert plan.units[0].id == "answer-lifecycle"
    with pytest.raises(ValidationError):
        KnowledgePlan.model_validate(
            {"kind": "knowledge-plan", "units": [unit(owner="src")], "gaps": []}
        )


def test_empty_plan_requires_an_explanation_and_empty_composition_is_valid():
    with pytest.raises(ValidationError, match="must explain why"):
        KnowledgePlan.model_validate(
            {"kind": "knowledge-plan", "units": [], "gaps": []}
        )
    plan = KnowledgePlan.model_validate(
        {
            "kind": "knowledge-plan",
            "units": [],
            "gaps": ["All behavior is immediately reconstructable from three files."],
        }
    )
    composition = CompositionMap.model_validate(
        {"kind": "composition-map", "pages": [], "gaps": []}
    )
    assert plan.units == []
    assert composition.pages == []


def test_plan_review_binds_semantic_recall_before_composition():
    report = PlanReviewReport.model_validate(
        {"subject_digest": "a" * 64, "verdict": "approved", "issues": []}
    )
    assert report.verdict == "approved"
    with pytest.raises(ValidationError, match="must contain open issues"):
        PlanReviewReport.model_validate(
            {
                "subject_digest": "a" * 64,
                "verdict": "changes_requested",
                "issues": [],
            }
        )

    approved = PlanReviewReport.model_validate(
        {
            "subject_digest": "a" * 64,
            "verdict": "approved",
            "issues": [
                {
                    "id": "domain.missing",
                    "status": "resolved",
                    "category": "domain-coverage",
                    "claim": "A domain was missing.",
                    "resolution": "Add the domain unit.",
                }
            ],
        }
    )
    assert approved.issues[0].status == "resolved"
    with pytest.raises(ValidationError):
        PlanReviewReport.model_validate(
            {
                "subject_digest": "a" * 64,
                "verdict": "changes_requested",
                "issues": [
                    {
                        "category": "domain-coverage",
                        "claim": "Legacy issue without ledger fields.",
                        "resolution": "Regenerate the report.",
                    }
                ],
            }
        )


def test_page_templates_only_seed_writer_owned_frontmatter():
    templates = pathlib.Path(__file__).parents[2] / "assets/templates"
    assert not list(templates.glob("*.md"))
    assert {path.name for path in (templates / "en").glob("*.md")} == {
        path.name for path in (templates / "zh").glob("*.md")
    }
    for path in templates.glob("*/*.md"):
        assert parse_file(path).meta == {"coverage": "full", "sources": []}


def test_composition_accepts_one_page_and_only_late_binding_fields():
    composition = CompositionMap.model_validate(
        {"kind": "composition-map", "pages": [page()], "gaps": []}
    )
    moved = CompositionPage.model_validate(
        {**composition.pages[0].model_dump(mode="json"), "path": "guide/answer.md"}
    )
    assert moved.id == "answer"
    assert moved.path == "guide/answer.md"
    for removed in ("owner", "scopes", "evidence_seeds", "parent", "depends_on"):
        with pytest.raises(ValidationError):
            CompositionPage.model_validate(page(**{removed: []}))


def test_composition_rejects_duplicate_ids_paths_and_invalid_representation():
    with pytest.raises(ValidationError, match="ids must be unique"):
        CompositionMap.model_validate(
            {"kind": "composition-map", "pages": [page(), page(path="other.md")]}
        )
    with pytest.raises(ValidationError, match="paths must be unique"):
        CompositionMap.model_validate(
            {"kind": "composition-map", "pages": [page(), page("other")]}
        )
    with pytest.raises(ValidationError, match="require a flowchart"):
        CompositionPage.model_validate(page(type="Architecture"))


def test_bundle_review_routes_content_and_structural_repairs():
    report = ReviewReport.model_validate(
        {
            "subject_digest": "a" * 64,
            "verdict": "changes_requested",
            "issues": [
                {
                    "id": "boundary.answer",
                    "status": "open",
                    "category": "concept-boundary",
                    "claim": "Two unrelated capabilities share one page.",
                    "resolution": "Split the page.",
                    "area": "composition",
                    "page_ids": ["answer"],
                    "operation": "split",
                }
            ],
        }
    )
    assert report.issues[0].operation == "split"
    with pytest.raises(ValidationError, match="page issues require"):
        ReviewReport.model_validate(
            {
                "subject_digest": "a" * 64,
                "verdict": "changes_requested",
                "issues": [
                    {
                        "id": "coverage.answer",
                        "status": "open",
                        "category": "coverage",
                        "claim": "Missing behavior.",
                        "resolution": "Add it.",
                        "area": "page",
                    }
                ],
            }
        )
