import pytest
from _models import PagePlan, PagePlanEntry, PageScope, ReviewReport
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
        "depends_on": depends_on or [],
        **overrides,
    }


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


def test_review_report_is_page_bound_and_digest_bound():
    digest = "a" * 64
    report = ReviewReport.model_validate(
        {"page": "a.md", "page_digest": digest, "verdict": "approved", "issues": []}
    )
    assert report.page_digest == digest

    issue = {
        "category": "unsupported-claim",
        "target": "a.md",
        "claim": "Unsupported statement.",
        "resolution": "Add evidence or remove it.",
        "reopen": "page",
    }
    with pytest.raises(ValidationError):
        ReviewReport.model_validate(
            {
                "page": "a.md",
                "page_digest": digest,
                "verdict": "approved",
                "issues": [issue],
            }
        )
    with pytest.raises(ValidationError):
        ReviewReport.model_validate(
            {
                "page": "a.md",
                "page_digest": digest,
                "verdict": "changes_requested",
                "issues": [],
            }
        )
    with pytest.raises(ValidationError, match="reviewed page"):
        ReviewReport.model_validate(
            {
                "page": "a.md",
                "page_digest": digest,
                "verdict": "changes_requested",
                "issues": [{**issue, "target": "b.md"}],
            }
        )


def test_review_plan_reopen_may_target_the_plan_owner():
    report = ReviewReport.model_validate(
        {
            "page": "a.md",
            "page_digest": "b" * 64,
            "verdict": "changes_requested",
            "issues": [
                {
                    "category": "routing",
                    "target": "SourceA",
                    "claim": "The page belongs elsewhere.",
                    "resolution": "Replan the Source.",
                    "reopen": "plan",
                }
            ],
        }
    )
    assert report.issues[0].reopen == "plan"
