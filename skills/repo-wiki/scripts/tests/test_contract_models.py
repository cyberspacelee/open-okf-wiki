import json
import pathlib

import _validate
import pytest
from _frontmatter import parse_file, render
from _models import (
    CompositionMap,
    CompositionPage,
    CompositionReviewReport,
    DiagramSpec,
    DraftFrontmatter,
    KnowledgePlan,
    PageScope,
    PlanReviewReport,
    ReferenceRoot,
    ReviewReport,
    RunPolicy,
)
from pydantic import ValidationError


def scope(paths=None) -> dict:
    return {
        "source": "src",
        "roles": ["owner"],
        "paths": ["app.py"] if paths is None else paths,
    }


def unit(unit_id="answer-lifecycle", **overrides) -> dict:
    return {
        "id": unit_id,
        "kind": "lifecycle",
        "question": "How does the answer move through its lifecycle?",
        "domain_ids": ["answers"],
        "concept_ids": ["answer"],
        "scopes": [scope()],
        "evidence_seeds": ["src/app.py#L1-L2"],
        **overrides,
    }


def knowledge_plan(units=None, **overrides) -> dict:
    units = [unit()] if units is None else units
    owner = units[0]["id"]
    return {
        "kind": "knowledge-plan-ledger",
        "intent_digest": "0" * 64,
        "source_areas": [
            {
                "id": "src.answers",
                "source": "src",
                "paths": ["app.py"],
                "disposition": "domain",
                "domain_ids": ["answers"],
            }
        ],
        "domains": [
            {
                "id": "answers",
                "name": "Answers",
                "definition": "Owns answers and their lifecycle.",
                "owner_unit_id": owner,
            }
        ],
        "concepts": [
            {
                "id": "answer",
                "domain_id": "answers",
                "kind": "entity",
                "name": "Answer",
                "definition": "A response owned by the answers domain.",
                "owner_unit_id": owner,
                "model_basis": {"basis": "none"},
            }
        ],
        "table_groups": [],
        "relationships": [],
        "units": units,
        "gaps": [],
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
    assert policy.evidence.search.max_results == 100
    assert policy.evidence.search.max_output_bytes == 64 * 1024
    assert policy.evidence.read.default_lines == 200
    assert policy.evidence.read.max_lines == 1000
    assert policy.evidence.read.max_output_bytes == 256 * 1024

    invalid_agents = policy.model_dump()
    invalid_agents["agents"]["max_active_children"] = 0
    invalid_search = policy.model_dump()
    invalid_search["evidence"]["search"]["max_results"] = 101
    invalid_read = policy.model_dump()
    invalid_read["evidence"]["read"]["default_lines"] = 1001
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
    plan = KnowledgePlan.model_validate(knowledge_plan())
    assert plan.units[0].id == "answer-lifecycle"
    with pytest.raises(ValidationError):
        KnowledgePlan.model_validate(knowledge_plan([unit(owner="src")]))


def test_plan_requires_domain_and_concept_coverage_and_empty_composition_is_valid():
    incomplete = knowledge_plan()
    incomplete["concepts"] = []
    with pytest.raises(ValidationError):
        KnowledgePlan.model_validate(incomplete)
    knowledge = KnowledgePlan.model_validate(knowledge_plan())
    composition = CompositionMap.model_validate(
        {"kind": "composition-map", "reference_roots": [], "pages": [], "gaps": []}
    )
    assert knowledge.concepts[0].id == "answer"
    assert composition.pages == []


def test_model_basis_requires_the_authoritative_structure_source():
    data = knowledge_plan()
    concept = data["concepts"][0]
    concept["model_basis"] = {
        "basis": "code",
        "structure_evidence": ["src/app.py#L1-L2"],
    }
    plan = KnowledgePlan.model_validate(data)
    assert plan.concepts[0].model_basis.basis == "code"
    assert plan.effective_units[-1].id == "model.answer"

    concept["model_basis"]["structure_evidence"] = []
    with pytest.raises(ValidationError, match="requires structure evidence"):
        KnowledgePlan.model_validate(data)


def test_persistent_model_units_are_derived():
    data = knowledge_plan()
    data["concepts"][0]["model_basis"] = {
        "basis": "code",
        "structure_evidence": ["src/app.py#L1-L2"],
    }
    assert KnowledgePlan.model_validate(data).effective_units[-1].id == "model.answer"


def test_non_persistent_model_basis_cannot_report_structural_gaps():
    data = knowledge_plan()
    data["gaps"] = [
        {
            "id": "model.missing",
            "category": "model-coverage",
            "claim": "Persistence evidence is missing.",
            "evidence": ["src/app.py#L1-L2"],
        }
    ]
    basis = data["concepts"][0]["model_basis"]
    basis.update(coverage="partial", gap_ids=["model.missing"])
    with pytest.raises(ValidationError, match="none model basis must be full"):
        KnowledgePlan.model_validate(data)


def test_opengauss_model_requires_a_matching_table_disposition():
    data = knowledge_plan()
    concept = data["concepts"][0]
    concept["model_basis"] = {
        "basis": "opengauss",
        "catalog_tables": [{"source": "database", "table": "answers"}],
    }
    data["table_groups"] = [
        {
            "source": "database",
            "role": "entity",
            "tables": ["answers"],
            "domain_id": "answers",
        }
    ]
    assert KnowledgePlan.model_validate(data).table_dispositions[0].role == "entity"


def test_table_groups_keep_large_catalog_plans_compact():
    data = knowledge_plan()
    data["table_groups"] = [
        {
            "source": "database",
            "role": "working",
            "tables": [f"work_table_{index:03d}_tmp" for index in range(195)],
        }
    ]

    plan = KnowledgePlan.model_validate(data)
    text = json.dumps(data)

    assert len(plan.table_dispositions) == 195
    assert len(text.encode()) < 16 * 1024
    assert text.count("\n") < 300


def test_excluded_table_groups_require_classification_evidence():
    data = knowledge_plan()
    data["table_groups"] = [
        {"source": "database", "role": "excluded", "tables": ["legacy"]}
    ]

    with pytest.raises(ValidationError, match="classification evidence"):
        KnowledgePlan.model_validate(data)


def test_replica_mappings_are_sparse_complete_and_evidenced():
    data = knowledge_plan()
    data["table_groups"] = [
        {
            "source": "primary",
            "role": "entity",
            "tables": ["answers"],
            "domain_id": "answers",
        },
        {
            "source": "analytics",
            "role": "replica",
            "tables": ["answers_copy"],
            "domain_id": "answers",
        },
    ]
    data["table_replicas"] = [
        {
            "table": {"source": "analytics", "table": "answers_copy"},
            "replica_of": {"source": "primary", "table": "answers"},
            "evidence": ["src/app.py#L1-L2"],
        }
    ]

    plan = KnowledgePlan.model_validate(data)
    assert plan.table_dispositions[1].replica_of.table == "answers"


def test_partial_models_and_unresolved_tables_require_structured_gaps():
    data = knowledge_plan()
    data["gaps"] = [
        {
            "id": "missing-table",
            "category": "catalog-selection",
            "claim": "The relevant OpenGauss table was not selected.",
            "evidence": [],
        }
    ]
    concept = data["concepts"][0]
    concept["model_basis"] = {
        "basis": "code",
        "coverage": "partial",
        "structure_evidence": ["src/app.py#L1-L2"],
        "gap_ids": ["missing-table"],
    }
    assert (
        KnowledgePlan.model_validate(data).concepts[0].model_basis.coverage == "partial"
    )

    concept["model_basis"]["gap_ids"] = []
    with pytest.raises(ValidationError, match="partial model coverage"):
        KnowledgePlan.model_validate(data)


def test_heuristic_relationships_cannot_enter_er_diagrams():
    data = knowledge_plan()
    data["relationships"] = [
        {
            "id": "answer-parent",
            "from_concept_id": "answer",
            "to_concept_id": "answer",
            "level": "heuristic",
            "cardinality": "unknown",
            "evidence": ["src/app.py#L1-L2"],
            "include_in_er": True,
        }
    ]
    with pytest.raises(ValidationError, match="must not appear in ER"):
        KnowledgePlan.model_validate(data)


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
        assert parse_file(path).meta == {"coverage": "full"}


def test_composition_accepts_one_page_and_only_late_binding_fields():
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "reference_roots": [],
            "pages": [page()],
            "gaps": [],
        }
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
            {
                "kind": "composition-map",
                "reference_roots": [],
                "pages": [page(), page(path="other.md")],
            }
        )
    with pytest.raises(ValidationError, match="paths must be unique"):
        CompositionMap.model_validate(
            {
                "kind": "composition-map",
                "reference_roots": [],
                "pages": [page(), page("other")],
            }
        )
    with pytest.raises(ValidationError, match="require a flowchart"):
        CompositionPage.model_validate(page(type="Architecture"))
    with pytest.raises(ValidationError, match="merge rationale"):
        CompositionPage.model_validate(
            page(units=["answer-lifecycle", "answer-failure"])
        )


def test_composition_validation_requires_capability_hierarchy():
    knowledge = KnowledgePlan.model_validate(
        knowledge_plan([unit(), unit("answer-failure")])
    )
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "reference_roots": [],
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
            knowledge, composition, pathlib.Path("composition.md")
        )
    }
    assert codes == {"capability-path-required", "page-type-directory"}


def test_composition_diagram_sources_are_inherited_from_unit_scopes():
    knowledge = KnowledgePlan.model_validate(knowledge_plan())
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "reference_roots": [],
            "pages": [
                page(
                    type="Domain",
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
        knowledge, composition, pathlib.Path("composition.md")
    )

    assert [item.code for item in issues] == ["diagram-source-outside-scope"]


def test_composition_keeps_domain_pages_independent_but_allows_domain_depth():
    units = [
        unit(),
        unit("audit-capability", domain_ids=["audit"], concept_ids=["audit"]),
    ]
    data = knowledge_plan(units)
    data["source_areas"][0]["domain_ids"].append("audit")
    data["domains"].append(
        {
            "id": "audit",
            "name": "Audit",
            "definition": "Owns the independent audit responsibility.",
            "owner_unit_id": "audit-capability",
        }
    )
    data["concepts"].append(
        {
            "id": "audit",
            "domain_id": "audit",
            "kind": "service",
            "name": "Audit",
            "definition": "Records changes for the audit domain.",
            "owner_unit_id": "audit-capability",
            "model_basis": {"basis": "none"},
        }
    )
    knowledge = KnowledgePlan.model_validate(data)
    merged = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "reference_roots": [],
            "pages": [
                page(
                    path="domains/combined.md",
                    units=["answer-lifecycle", "audit-capability"],
                    merge_rationale="Both responsibilities were placed together.",
                )
            ],
            "gaps": [],
        }
    )
    assert "domain-page-cross-domain" in {
        item.code
        for item in _validate._validate_composition(
            knowledge, merged, pathlib.Path("composition.md")
        )
    }

    same_domain = knowledge_plan(
        [unit(), unit("answer-details", concept_ids=["answer"])]
    )
    knowledge = KnowledgePlan.model_validate(same_domain)
    split = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "reference_roots": [],
            "pages": [
                page(path="answers/domain.md"),
                page(
                    "answer-details",
                    path="answers/details.md",
                    type="Concept",
                    units=["answer-details"],
                ),
            ],
            "gaps": [],
        }
    )
    assert not _validate._validate_composition(
        knowledge, split, pathlib.Path("composition.md")
    )


def test_code_data_model_requires_authored_er_but_opengauss_does_not():
    data = knowledge_plan()
    concept = data["concepts"][0]
    concept["model_basis"] = {
        "basis": "code",
        "structure_evidence": ["src/app.py#L1-L2"],
    }
    knowledge = KnowledgePlan.model_validate(data)
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "reference_roots": [],
            "pages": [
                page(path="answers/domain.md"),
                page(
                    "answer-model",
                    path="answers/data-model.md",
                    type="DataModel",
                    units=["model.answer"],
                ),
            ],
            "gaps": [],
        }
    )
    codes = {
        item.code
        for item in _validate._validate_composition(
            knowledge, composition, pathlib.Path("composition.md")
        )
    }
    assert codes == {"code-data-model-diagram-required"}

    composition.pages[1].diagrams.append(
        DiagramSpec.model_validate(
            {
                "id": "answer-structure",
                "kind": "er",
                "question": "How is an answer represented?",
                "sources": ["src"],
            }
        )
    )
    assert not _validate._validate_composition(
        knowledge, composition, pathlib.Path("composition.md")
    )


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


def test_merge_probe_reviews_have_no_hidden_512_item_ceiling():
    item_ids = [f"item-{index:03d}" for index in range(513)]
    plan_probes = [
        {
            "unit_ids": item_ids[index : index + 2],
            "decision": "keep-separate",
            "rationale": "The routed items have independent change surfaces.",
        }
        for index in range(len(item_ids) - 1)
    ]
    page_probes = [
        {
            "page_ids": probe["unit_ids"],
            "decision": probe["decision"],
            "rationale": probe["rationale"],
        }
        for probe in plan_probes
    ]

    plan_review = PlanReviewReport.model_validate(
        {
            "subject_digest": "a" * 64,
            "verdict": "approved",
            "merge_probes": plan_probes,
            "issues": [],
        }
    )
    composition_review = CompositionReviewReport.model_validate(
        {
            "subject_digest": "a" * 64,
            "verdict": "approved",
            "merge_probes": page_probes,
            "issues": [],
        }
    )

    assert not _validate._merge_probe_issues(
        pathlib.Path("plan-review.json"),
        plan_review.merge_probes,
        "unit_ids",
        set(item_ids),
    )
    assert not _validate._merge_probe_issues(
        pathlib.Path("composition-review.json"),
        composition_review.merge_probes,
        "page_ids",
        set(item_ids),
    )


def test_integration_scopes_require_roles_and_each_source_once():
    producer = {"source": "api", "roles": ["producer"], "paths": ["src"]}
    consumer = {"source": "worker", "roles": ["consumer"], "paths": ["src"]}
    integration = unit(
        kind="integration",
        scopes=[producer, consumer],
        evidence_seeds=["api/src/App.py", "worker/src/Worker.py"],
    )
    assert (
        KnowledgePlan.model_validate(knowledge_plan([integration])).units[0].kind
        == "integration"
    )
    with pytest.raises(ValidationError, match="producer and consumer"):
        KnowledgePlan.model_validate(knowledge_plan([unit(kind="integration")]))
    with pytest.raises(ValidationError, match="exactly one scope"):
        KnowledgePlan.model_validate(
            knowledge_plan([unit(scopes=[scope(), scope(["src"])])])
        )


def test_draft_frontmatter_is_strict_and_typed():
    assert (
        DraftFrontmatter.model_validate({"coverage": "full"}, strict=True).coverage
        == "full"
    )
    for invalid in (
        {},
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
    catalogs = [
        {
            "name": "database",
            "resource": "database/.",
            "tables": [
                {
                    "name": "orders",
                    "page_slug": "orders",
                    "resource": "database/orders",
                },
                {
                    "name": "customers",
                    "page_slug": "customers",
                    "resource": "database/customers",
                },
            ],
        }
    ]
    roots = {"database": ["orders"]}

    assert _validate._catalog_in_scope(catalogs, "database/orders", roots)
    assert not _validate._catalog_in_scope(catalogs, "database/customers", roots)
    assert not _validate._catalog_in_scope(catalogs, "database/.", roots)
    assert _validate._catalog_in_scope(
        catalogs, "database/customers", {"database": ["."]}
    )
    assert not _validate._catalog_resource(catalogs, "opengauss://db/public/orders")


@pytest.mark.parametrize(
    "path",
    ("reference docs", "CON", "reference/schema.md/tables"),
)
def test_reference_roots_are_portable_directories(path):
    with pytest.raises(ValidationError):
        ReferenceRoot(source="database", path=path)
