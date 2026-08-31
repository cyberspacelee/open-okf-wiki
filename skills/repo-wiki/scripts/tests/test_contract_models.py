import json
import pathlib

import _validate
import pytest
from _frontmatter import parse_file
from _models import (
    CompositionMap,
    CompositionPage,
    CompositionReviewReport,
    DraftFrontmatter,
    KnowledgePlan,
    PageScope,
    PlanReviewReport,
    ReviewReport,
    RunPolicy,
)
from pydantic import ValidationError


def scope(paths=None) -> dict:
    return {
        "source": "src",
        "role": "owner",
        "paths": ["app.py"] if paths is None else paths,
    }


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


def test_run_policy_is_complete_strict_and_bounded():
    policy = RunPolicy.defaults()
    assert policy.agents.max_active_children == 4
    assert policy.agents.max_spawn_depth == 1
    assert policy.evidence.search.max_output_bytes == 8 * 1024
    assert policy.evidence.read.max_output_bytes == 64 * 1024

    invalid_agents = policy.model_dump()
    invalid_agents["agents"]["max_active_children"] = 0
    invalid_search = policy.model_dump()
    invalid_search["evidence"]["search"]["max_results"] = 101
    invalid_read = policy.model_dump()
    invalid_read["evidence"]["read"]["default_lines"] = 201
    for invalid in (
        invalid_agents,
        invalid_search,
        invalid_read,
        {**policy.model_dump(), "unexpected": 1},
    ):
        with pytest.raises(ValidationError):
            RunPolicy.model_validate(invalid, strict=True)

    incomplete = policy.model_dump()
    incomplete["evidence"]["read"].pop("max_lines")
    with pytest.raises(ValidationError):
        RunPolicy.model_validate(incomplete, strict=True)


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
        {
            "subject_digest": "a" * 64,
            "verdict": "approved",
            "merge_probes": [],
            "issues": [],
        }
    )
    assert report.verdict == "approved"
    with pytest.raises(ValidationError, match="must contain open issues"):
        PlanReviewReport.model_validate(
            {
                "subject_digest": "a" * 64,
                "verdict": "changes_requested",
                "merge_probes": [],
                "issues": [],
            }
        )

    approved = PlanReviewReport.model_validate(
        {
            "subject_digest": "a" * 64,
            "verdict": "approved",
            "merge_probes": [],
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
                "merge_probes": [],
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
    with pytest.raises(ValidationError, match="merge rationale"):
        CompositionPage.model_validate(
            page(units=["answer-lifecycle", "answer-failure"])
        )


def test_composition_validation_requires_capability_hierarchy():
    plan = KnowledgePlan.model_validate(
        {
            "kind": "knowledge-plan",
            "units": [unit(), unit("answer-failure")],
            "gaps": [],
        }
    )
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "pages": [
                page(path="answer.md"),
                page(
                    "failure",
                    path="accounting/flow/failure.md",
                    units=["answer-failure"],
                ),
            ],
            "gaps": [],
        }
    )
    codes = {
        item.code
        for item in _validate._validate_composition(
            plan, composition, pathlib.Path("composition.md")
        )
    }
    assert codes == {"capability-path-required", "page-type-directory"}


def test_composition_diagram_sources_are_inherited_from_unit_scopes():
    plan = KnowledgePlan.model_validate(
        {"kind": "knowledge-plan", "units": [unit()], "gaps": []}
    )
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "pages": [
                page(
                    type="Architecture",
                    diagrams=[
                        {
                            "id": "boundary",
                            "kind": "flowchart",
                            "question": "Where is the boundary?",
                            "sources": ["missing"],
                        }
                    ],
                )
            ],
            "gaps": [],
        }
    )

    issues = _validate._validate_composition(
        plan, composition, pathlib.Path("composition.md")
    )

    assert [item.code for item in issues] == ["diagram-source-outside-scope"]


def test_plan_review_merge_probes_cover_every_unit(tmp_path):
    path = tmp_path / "plan-review.json"
    path.write_text(
        json.dumps(
            {
                "subject_digest": "a" * 64,
                "verdict": "approved",
                "merge_probes": [
                    {
                        "unit_ids": ["answer", "details"],
                        "decision": "keep-separate",
                        "rationale": "They have independent change surfaces.",
                    }
                ],
                "issues": [],
            }
        )
    )
    _, issues = _validate.validate_plan_review(
        path, "a" * 64, {"answer", "details", "failure"}
    )
    assert [item.code for item in issues] == ["merge-probe-incomplete"]


def test_integration_scopes_require_roles_and_each_source_once():
    producer = {"source": "api", "role": "producer", "paths": ["src"]}
    consumer = {"source": "worker", "role": "consumer", "paths": ["src"]}
    integration = unit(
        kind="integration",
        scopes=[producer, consumer],
        evidence_seeds=["api/src/App.py", "worker/src/Worker.py"],
    )
    assert (
        KnowledgePlan.model_validate(
            {"kind": "knowledge-plan", "units": [integration], "gaps": []}
        )
        .units[0]
        .kind
        == "integration"
    )
    with pytest.raises(ValidationError, match="producer and consumer"):
        KnowledgePlan.model_validate(
            {
                "kind": "knowledge-plan",
                "units": [unit(kind="integration")],
                "gaps": [],
            }
        )
    with pytest.raises(ValidationError, match="exactly one scope"):
        KnowledgePlan.model_validate(
            {
                "kind": "knowledge-plan",
                "units": [unit(scopes=[scope(), scope(["src"])])],
                "gaps": [],
            }
        )


def test_draft_frontmatter_is_strict_and_typed():
    assert (
        DraftFrontmatter.model_validate(
            {
                "coverage": "full",
                "sources": [{"id": "entry", "resource": "src/app.py"}],
            },
            strict=True,
        ).coverage
        == "full"
    )
    for invalid in (
        {"coverage": "full"},
        {"coverage": "Most behavior is covered", "sources": []},
        {"coverage": "full", "sources": ["src/app.py"]},
        {
            "coverage": "full",
            "sources": [{"id": "Entry Point", "resource": "src/app.py"}],
        },
        {"coverage": "full", "sources": [], "title": "writer-owned"},
    ):
        with pytest.raises(ValidationError):
            DraftFrontmatter.model_validate(invalid, strict=True)


def test_composition_review_requires_probe_issue_alignment():
    report = CompositionReviewReport.model_validate(
        {
            "subject_digest": "a" * 64,
            "verdict": "approved",
            "merge_probes": [
                {
                    "page_ids": ["answer", "details"],
                    "decision": "keep-separate",
                    "rationale": "The pages have independent change surfaces.",
                }
            ],
            "issues": [],
        }
    )
    assert report.merge_probes[0].decision == "keep-separate"
    with pytest.raises(ValidationError, match="must match"):
        CompositionReviewReport.model_validate(
            {
                "subject_digest": "a" * 64,
                "verdict": "approved",
                "merge_probes": [
                    {
                        "page_ids": ["answer", "details"],
                        "decision": "merge",
                        "rationale": "They duplicate one reader route.",
                    }
                ],
                "issues": [],
            }
        )


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
    for operation, page_ids, message in (
        ("split", [], "split and move issues require"),
        ("move", [], "split and move issues require"),
        ("merge", ["answer"], "merge issues require"),
    ):
        with pytest.raises(ValidationError, match=message):
            ReviewReport.model_validate(
                {
                    "subject_digest": "a" * 64,
                    "verdict": "changes_requested",
                    "issues": [
                        {
                            "id": f"routing.{operation}",
                            "status": "open",
                            "category": "routing",
                            "claim": "The route needs structural repair.",
                            "resolution": "Repair the Composition.",
                            "area": "composition",
                            "page_ids": page_ids,
                            "operation": operation,
                        }
                    ],
                }
            )


def test_catalog_resources_stay_inside_selected_table_scope():
    state = {
        "catalogs": [
            {
                "name": "database",
                "resource": "opengauss://db/public",
                "tables": [
                    {
                        "name": "orders",
                        "page_slug": "orders",
                        "resource": "opengauss://db/public/orders",
                    },
                    {
                        "name": "customers",
                        "page_slug": "customers",
                        "resource": "opengauss://db/public/customers",
                    },
                ],
            }
        ]
    }
    roots = {"database": ["orders"]}

    assert _validate._catalog_in_scope(state, "opengauss://db/public/orders", roots)
    assert not _validate._catalog_in_scope(
        state, "opengauss://db/public/customers", roots
    )
    assert not _validate._catalog_in_scope(state, "opengauss://db/public", roots)
    assert _validate._catalog_in_scope(
        state, "opengauss://db/public/customers", {"database": ["."]}
    )
