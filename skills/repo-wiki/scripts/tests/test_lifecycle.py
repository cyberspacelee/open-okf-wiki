import json
import pathlib
import subprocess

import _publish
import _state
import _validate
import _workspace
import pytest
from _frontmatter import render


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def workspace(tmp_path: pathlib.Path) -> pathlib.Path:
    root = tmp_path / "workspace"
    source = root / "source"
    source.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    subprocess.run(
        ["git", "-C", str(source), "config", "user.email", "qa@example.test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(source), "config", "user.name", "QA"], check=True)
    write(source / "app.py", "def answer():\n    return 42\n")
    write(source / "architecture.py", "class Service:\n    pass\n")
    subprocess.run(["git", "-C", str(source), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "initial"], check=True)
    _workspace.init(root, "en", 30)
    _workspace.add_git_link(root, str(source), "src")
    return root


def start(root: pathlib.Path) -> pathlib.Path:
    result = _state.start_run(root)
    assert result["contract"] == "artifact-loop-late-bind"
    assert result["phase"] == "plan"
    return _state.run_dir(root, _state.read(root)["run_id"])


def unit(unit_id: str, source_path: str, kind: str) -> dict:
    return {
        "id": unit_id,
        "kind": kind,
        "question": f"How does {unit_id} work?",
        "scopes": [{"source": "src", "paths": [source_path]}],
        "evidence_seeds": [f"src/{source_path}#L1-L2"],
    }


def plan() -> str:
    return render(
        {
            "kind": "knowledge-plan",
            "units": [
                unit("answer", "app.py", "flow"),
                unit("architecture", "architecture.py", "integration"),
            ],
            "gaps": [],
        },
        "# Knowledge Plan\n\nThe answer crosses an explicit service boundary.\n",
    )


def composition() -> str:
    return render(
        {
            "kind": "composition-map",
            "pages": [
                {
                    "id": "answer",
                    "path": "guides/answer.md",
                    "type": "Domain",
                    "title": "Answer behavior",
                    "description": "Open before changing answer behavior.",
                    "tags": ["answer"],
                    "units": ["answer"],
                    "diagrams": [],
                },
                {
                    "id": "architecture",
                    "path": "architecture.md",
                    "type": "Domain",
                    "title": "Service boundary",
                    "description": "Open before changing service boundaries.",
                    "tags": ["architecture"],
                    "units": ["architecture"],
                    "diagrams": [],
                },
            ],
            "gaps": [],
        },
        "# Composition\n\nPaths provide the final information hierarchy.\n",
    )


def draft(resource: str, related_id: str, related_title: str) -> str:
    return render(
        {
            "coverage": "full",
            "sources": [{"id": "entry", "resource": resource}],
        },
        "## Responsibility\n\n"
        "The captured entry point defines this responsibility.[^entry]\n\n"
        f"## Related concepts\n\nSee [{related_title}][{related_id}].\n\n"
        "[^entry]: Frozen source entry point.\n",
    )


def write_work(run: pathlib.Path) -> None:
    write(run / "work/plan.md", plan())
    write(run / "work/progress.md", "# Progress\n\nPlan complete; pages remain.\n")
    write(run / "work/composition.md", composition())
    write(
        run / "work/drafts/answer.md",
        draft("src/app.py#L1-L2", "architecture", "service boundary"),
    )
    write(
        run / "work/drafts/architecture.md",
        draft("src/architecture.py#L1-L2", "answer", "answer behavior"),
    )


def review(path: pathlib.Path, digest: str, verdict: str) -> None:
    issues = []
    if verdict == "changes_requested":
        issues = [
            {
                "category": "coverage",
                "claim": "The answer page omits its failure behavior.",
                "resolution": "Add the failure behavior with evidence.",
                "area": "page",
                "page_ids": ["answer"],
                "operation": "repair",
            }
        ]
    write(
        path,
        json.dumps({"subject_digest": digest, "verdict": verdict, "issues": issues}),
    )


def test_artifact_loop_reaches_publication_and_rechecks_changes(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    assert (run / "index/src.md").is_file()

    search = _state.evidence_search(root, "src", "return 42")
    assert search["results"][0]["locator"] == "src/app.py#L2"
    assert "return 42" in _state.evidence_read(root, "src/app.py#L1-L2")["text"]

    write_work(run)
    assert _state.status(root)["next_actions"] == ["review prepare"]
    packet = _state.review_prepare(root)
    assert packet["ok"]
    assert "](/architecture.md)" in (run / "candidate/guides/answer.md").read_text()

    review(run / "work/review.json", packet["subject_digest"], "changes_requested")
    result = _state.review_complete(root)
    assert result["verdict"] == "changes_requested"
    assert result["state"]["phase"] == "repair"
    answer = run / "work/drafts/answer.md"
    write(answer, answer.read_text() + "\nFailure behavior is explicit.[^entry]\n")
    assert _state.status(root)["next_actions"] == ["review prepare"]
    second = _state.review_prepare(root)
    assert second["subject_digest"] != packet["subject_digest"]
    assert second["previous_review"]["issue_count"] == 1
    assert second["previous_review"]["artifact"] == str(run / "work/review.json")
    review(run / "work/review.json", second["subject_digest"], "approved")
    completed = _state.review_complete(root)
    assert completed["state"]["status"] == "approved"

    published = _publish.publish(root)
    assert published["pages"] == 2
    assert _state.status(root)["status"] == "published"
    errors = [
        item
        for item in _validate.validate_publication(
            root, pathlib.Path(published["path"])
        )
        if item.severity == "error"
    ]
    assert errors == []


def test_explained_empty_plan_publishes_without_placeholder_pages(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write(
        run / "work/plan.md",
        render(
            {
                "kind": "knowledge-plan",
                "units": [],
                "gaps": [
                    "All behavior is immediately reconstructable from three files."
                ],
            },
            "# Plan\n\nNo knowledge passes the Grep Test.\n",
        ),
    )
    write(
        run / "work/composition.md",
        render(
            {"kind": "composition-map", "pages": [], "gaps": []},
            "# Composition\n\nNo pages are warranted.\n",
        ),
    )

    assert _state.status(root)["next_actions"] == ["review prepare"]
    packet = _state.review_prepare(root)
    assert "previous_review" not in packet
    review(run / "work/review.json", packet["subject_digest"], "approved")
    assert _state.review_complete(root)["state"]["status"] == "approved"

    published = _publish.publish(root)
    assert published["pages"] == 0
    assert (pathlib.Path(published["path"]) / "index.md").is_file()
    errors = [
        item
        for item in _validate.validate_publication(
            root, pathlib.Path(published["path"])
        )
        if item.severity == "error"
    ]
    assert errors == []


def test_status_derives_plan_composition_and_draft_repairs(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write(run / "work/plan.md", plan())
    assert _state.status(root)["issues"][0]["code"] == "composition-missing"
    write(run / "work/composition.md", composition())
    status = _state.status(root)
    assert status["phase"] == "write"
    assert {item["code"] for item in status["issues"]} == {"page-draft-missing"}


def test_one_unit_plan_can_publish_one_page(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write(
        run / "work/plan.md",
        render(
            {
                "kind": "knowledge-plan",
                "units": [unit("answer", "app.py", "flow")],
                "gaps": [],
            },
            "# Plan\n\nOne coherent unit.\n",
        ),
    )
    write(
        run / "work/composition.md",
        render(
            {
                "kind": "composition-map",
                "pages": [
                    {
                        "id": "answer",
                        "path": "answer.md",
                        "type": "Domain",
                        "title": "Answer",
                        "description": "Open before changing answer behavior.",
                        "tags": [],
                        "units": ["answer"],
                        "diagrams": [],
                    }
                ],
                "gaps": [],
            },
            "# Composition\n\nOne unit needs one page.\n",
        ),
    )
    write(run / "work/drafts/answer.md", draft("src/app.py#L1-L2", "answer", "answer"))
    packet = _state.review_prepare(root)
    assert packet["ok"]


def test_block_resume_and_legacy_state_rejection(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    assert _state.block(root, "credentials required")["status"] == "blocked"
    assert _state.resume(root)["status"] == "active"
    path = run / "state.json"
    state = json.loads(path.read_text())
    state["contract"] = "knowledge-composition-late-bind"
    write(path, json.dumps(state))
    with pytest.raises(_state.StateError, match="artifact-loop-late-bind"):
        _state.read(root)
