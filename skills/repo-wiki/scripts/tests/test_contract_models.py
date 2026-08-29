import pytest
from _models import PagePlan, PagePlanEntry, PageScope, ReviewReport, SourceBrief
from pydantic import ValidationError


def scope(paths=None) -> dict:
    return {"source": "SourceA", "paths": ["src/core"] if paths is None else paths}


def page(path: str, *, depends_on=None, **overrides) -> dict:
    return {
        "path": path,
        "type": "Architecture",
        "owner": "SourceA",
        "title": path,
        "description": "Open before changing this area.",
        "tags": [],
        "scopes": [scope()],
        "evidence_seeds": ["SourceA/src/core/File.java#L1-L2"],
        "depends_on": depends_on or [],
        "diagrams": [
            {
                "id": "component-map",
                "kind": "flowchart",
                "question": "Which components depend on each other?",
            }
        ],
        **overrides,
    }


def source_brief(**overrides) -> dict:
    return {
        "source": "SourceA",
        "roles": ["business-domain-owner"],
        "concepts": [
            {
                "name": "request-lifecycle",
                "description": "Requests move through validated lifecycle states.",
                "paths": ["src/core"],
                "evidence_seeds": ["SourceA/src/core/Request.java#L1-L2"],
            }
        ],
        "connections": [
            {
                "name": "public-api",
                "description": "The public API is consumed by SourceB.",
                "evidence_seeds": ["SourceA/src/core/RequestApi.java#L1-L2"],
                "counterpart_sources": ["SourceB"],
                "counterpart_queries": ["RequestApi"],
            }
        ],
        "gaps": [],
        **overrides,
    }


def test_source_brief_is_bounded_strict_and_allows_evidence_only_sources():
    brief = SourceBrief.model_validate(source_brief())
    assert brief.source == "SourceA"
    assert brief.concepts[0].paths == ["src/core"]

    evidence_only = source_brief(
        roles=["evidence-only-dependency"], concepts=[], connections=[]
    )
    assert SourceBrief.model_validate(evidence_only).concepts == []

    with pytest.raises(ValidationError):
        SourceBrief.model_validate(source_brief(extra="forbidden"))
    with pytest.raises(ValidationError):
        SourceBrief.model_validate(source_brief(roles=["unknown-role"]))
    with pytest.raises(ValidationError, match="roles must be unique"):
        SourceBrief.model_validate(
            source_brief(roles=["public-contract", "public-contract"])
        )
    with pytest.raises(ValidationError, match="concept names must be unique"):
        payload = source_brief()
        payload["concepts"] *= 2
        SourceBrief.model_validate(payload)


@pytest.mark.parametrize("path", ["../src", "./src", "src/", r"src\core"])
def test_source_brief_rejects_non_normalized_concept_paths(path):
    payload = source_brief()
    payload["concepts"][0]["paths"] = [path]
    with pytest.raises(ValidationError):
        SourceBrief.model_validate(payload)


@pytest.mark.parametrize("path", [".", "src", "src/main/java", "build.gradle.kts"])
def test_page_scope_accepts_normalized_relative_paths(path):
    assert PageScope.model_validate(scope([path])).paths == [path]


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/src",
        "C:/src",
        "../src",
        "src/../main",
        "./src",
        "src/",
        "src//main",
        r"src\\main",
    ],
)
def test_page_scope_rejects_non_normalized_paths(path):
    with pytest.raises(ValidationError):
        PageScope.model_validate(scope([path]))


def test_page_scope_bounds_and_forbids_extra_fields():
    with pytest.raises(ValidationError):
        PageScope.model_validate(scope([]))
    with pytest.raises(ValidationError):
        PageScope.model_validate(scope([f"pkg/{index}" for index in range(33)]))
    with pytest.raises(ValidationError):
        PageScope.model_validate({**scope(), "tier": "deep"})


def test_page_plan_entry_keeps_dependency_shape_without_a_mode_field():
    entry = PagePlanEntry.model_validate(page("sourcea/architecture.md"))
    assert entry.depends_on == []
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(page("sourcea/architecture.md", mode="synthesis"))


@pytest.mark.parametrize(
    ("page_type", "diagrams"),
    [
        ("Overview", []),
        (
            "Architecture",
            [{"id": "map", "kind": "flowchart", "question": "What depends on what?"}],
        ),
        ("Domain", []),
        (
            "Flow",
            [
                {
                    "id": "request",
                    "kind": "sequence",
                    "question": "Who handles the request?",
                }
            ],
        ),
        (
            "Lifecycle",
            [
                {
                    "id": "states",
                    "kind": "state",
                    "question": "How does it change state?",
                }
            ],
        ),
        (
            "DataModel",
            [{"id": "relations", "kind": "er", "question": "Which records relate?"}],
        ),
        ("Table", []),
    ],
)
def test_page_types_define_their_representation_contract(page_type, diagrams):
    entry = PagePlanEntry.model_validate(
        page("a.md", type=page_type, diagrams=diagrams)
    )
    assert entry.type == page_type


@pytest.mark.parametrize(
    ("page_type", "diagrams"),
    [
        ("Overview", [{"id": "map", "kind": "flowchart", "question": "Why?"}]),
        ("Architecture", []),
        ("Flow", [{"id": "states", "kind": "state", "question": "Why?"}]),
        ("Lifecycle", [{"id": "flow", "kind": "flowchart", "question": "Why?"}]),
        ("DataModel", []),
        ("Table", [{"id": "relations", "kind": "er", "question": "Why?"}]),
    ],
)
def test_page_types_reject_the_wrong_representation(page_type, diagrams):
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(page("a.md", type=page_type, diagrams=diagrams))


def test_diagram_specs_are_required_bounded_and_page_local_unique():
    without_diagrams = page("a.md")
    without_diagrams.pop("diagrams")
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(without_diagrams)
    with pytest.raises(ValidationError, match="diagram ids must be unique"):
        PagePlanEntry.model_validate(
            page("a.md", diagrams=page("a.md")["diagrams"] * 2)
        )
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(
            page(
                "a.md",
                diagrams=[
                    {"id": f"map-{index}", "kind": "flowchart", "question": "Why?"}
                    for index in range(5)
                ],
            )
        )
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(page("a.md", type="Essay", diagrams=[]))


def test_page_plan_entry_scope_bounds():
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(page("a.md", scopes=[]))
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(
            page("a.md", scopes=[scope([f"pkg/{index}"]) for index in range(17)])
        )


@pytest.mark.parametrize("path", ["../x.md", "CON.md", "x//y.md", "Upper.md", "x.txt"])
def test_page_and_dependency_paths_are_portable(path):
    field = "path" if path != "x.txt" else "depends_on"
    payload = page("sourcea/architecture.md")
    payload[field] = path if field == "path" else [path]
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(payload)


def test_page_plan_requires_unique_nonempty_bounded_pages():
    plan = PagePlan.model_validate({"pages": [page("a.md")]})
    assert [item.path for item in plan.pages] == ["a.md"]

    with pytest.raises(ValidationError):
        PagePlan.model_validate({"source": "SourceA", "pages": [page("a.md")]})

    with pytest.raises(ValidationError):
        PagePlan.model_validate({"pages": []})
    with pytest.raises(ValidationError):
        PagePlan.model_validate({"pages": [page("same.md"), page("same.md")]})
    with pytest.raises(ValidationError):
        PagePlan.model_validate(
            {"pages": [page(f"p-{index}.md") for index in range(65)]}
        )
    with pytest.raises(ValidationError):
        PagePlan.model_validate({"pages": [page("a.md")], "gaps": ["gap"] * 17})


def test_page_plan_text_and_tag_fields_are_bounded():
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(page("a.md", title="x" * 121))
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(page("a.md", description="x" * 801))
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(page("a.md", tags=["tag"] * 17))
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(
            page("a.md", evidence_seeds=[f"SourceA/src/F{i}.java" for i in range(4)])
        )
    with pytest.raises(ValidationError):
        PagePlanEntry.model_validate(
            {
                key: value
                for key, value in page("a.md").items()
                if key != "evidence_seeds"
            }
        )


def test_page_plan_rejects_unknown_and_self_dependencies():
    with pytest.raises(ValidationError, match="planned pages"):
        PagePlan.model_validate({"pages": [page("a.md", depends_on=["missing.md"])]})
    with pytest.raises(ValidationError, match="itself"):
        PagePlan.model_validate({"pages": [page("a.md", depends_on=["a.md"])]})


def test_page_plan_rejects_dependency_cycles():
    with pytest.raises(ValidationError, match="cycle"):
        PagePlan.model_validate(
            {
                "pages": [
                    page("a.md", depends_on=["b.md"]),
                    page("b.md", depends_on=["c.md"]),
                    page("c.md", depends_on=["a.md"]),
                ]
            }
        )


def test_review_report_is_subject_and_digest_bound():
    digest = "a" * 64
    report = ReviewReport.model_validate(
        {
            "subject": "page:a.md",
            "subject_digest": digest,
            "verdict": "approved",
            "issues": [],
        }
    )
    assert report.subject_digest == digest

    representation = {
        "category": "representation",
        "claim": "The diagram omits the retry branch.",
        "resolution": "Add the evidenced retry message.",
        "reopen_target": "page:a.md",
    }
    assert (
        ReviewReport.model_validate(
            {
                "subject": "page:a.md",
                "subject_digest": digest,
                "verdict": "changes_requested",
                "issues": [representation],
            }
        )
        .issues[0]
        .category
        == "representation"
    )

    issue = {
        "category": "unsupported-claim",
        "claim": "Unsupported statement.",
        "resolution": "Add evidence or remove it.",
        "reopen_target": "page:a.md",
    }
    with pytest.raises(ValidationError):
        ReviewReport.model_validate(
            {
                "subject": "page:a.md",
                "subject_digest": digest,
                "verdict": "approved",
                "issues": [issue],
            }
        )
    with pytest.raises(ValidationError):
        ReviewReport.model_validate(
            {
                "subject": "page:a.md",
                "subject_digest": digest,
                "verdict": "changes_requested",
                "issues": [],
            }
        )
    with pytest.raises(ValidationError, match="invalid target"):
        ReviewReport.model_validate(
            {
                "subject": "page:a.md",
                "subject_digest": digest,
                "verdict": "changes_requested",
                "issues": [{**issue, "reopen_target": "page:b.md"}],
            }
        )


def test_review_plan_reopen_may_target_the_plan_owner():
    report = ReviewReport.model_validate(
        {
            "subject": "page:a.md",
            "subject_digest": "b" * 64,
            "verdict": "changes_requested",
            "issues": [
                {
                    "category": "routing",
                    "claim": "The page belongs elsewhere.",
                    "resolution": "Replan the Source.",
                    "reopen_target": "plan:workspace",
                }
            ],
        }
    )
    assert report.issues[0].reopen_target == "plan:workspace"


def test_plan_review_may_reopen_workspace_or_source_plan_but_not_pages():
    report = ReviewReport.model_validate(
        {
            "subject": "plan:workspace",
            "subject_digest": "c" * 64,
            "verdict": "changes_requested",
            "issues": [
                {
                    "category": "domain-coverage",
                    "claim": "Usage is missing from the API brief.",
                    "resolution": "Repair the API Source Brief.",
                    "reopen_target": "plan:API",
                }
            ],
        }
    )
    assert report.issues[0].reopen_target == "plan:API"

    with pytest.raises(ValidationError, match="invalid target"):
        ReviewReport.model_validate(
            {
                "subject": "plan:workspace",
                "subject_digest": "c" * 64,
                "verdict": "changes_requested",
                "issues": [
                    {
                        "category": "domain-coverage",
                        "claim": "Usage is missing.",
                        "resolution": "Add the usage domain.",
                        "reopen_target": "page:usage.md",
                    }
                ],
            }
        )
