import json
import pathlib
import subprocess
from datetime import datetime

import _publish
import _state
import _validate
import _workspace
import pytest
from _files import compact_json_size
from _frontmatter import render
from _models import RunPolicy


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def workspace(
    tmp_path: pathlib.Path, language: str = "en", policy: dict | None = None
) -> pathlib.Path:
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
    _workspace.init(root, language, 30, policy)
    _workspace.add_git_link(root, str(source), "src")
    return root


def start(root: pathlib.Path) -> pathlib.Path:
    result = _state.start_run(root)
    assert result["contract"] == "artifact-loop-late-bind"
    assert result["language"] in ("en", "zh")
    assert result["sources"] == ["src"]
    assert result["phase"] == "plan"
    run = _state.run_dir(root, _state.read(root)["run_id"])
    assert "repo-wiki-progress:initial" in (run / "work/progress.md").read_text()
    return run


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
    issues = (
        [
            {**item, "status": "resolved"}
            for item in json.loads(path.read_text()).get("issues", [])
        ]
        if path.is_file() and verdict == "approved"
        else []
    )
    if verdict == "changes_requested":
        issues = [
            {
                "id": "coverage.answer-failure",
                "status": "open",
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


def plan_review(path: pathlib.Path, digest: str, verdict: str) -> None:
    issues = (
        [
            {**item, "status": "resolved"}
            for item in json.loads(path.read_text()).get("issues", [])
        ]
        if path.is_file() and verdict == "approved"
        else []
    )
    if verdict == "changes_requested":
        issues = [
            {
                "id": "domain.visible-subsystem",
                "status": "open",
                "category": "domain-coverage",
                "claim": "A visible subsystem is absent from units and gaps.",
                "resolution": "Account for it in a unit or evidence-backed gap.",
            }
        ]
    write(
        path,
        json.dumps({"subject_digest": digest, "verdict": verdict, "issues": issues}),
    )


def composition_review(path: pathlib.Path, digest: str, verdict: str) -> None:
    issues = (
        [
            {**item, "status": "resolved"}
            for item in json.loads(path.read_text()).get("issues", [])
        ]
        if path.is_file() and verdict == "approved"
        else []
    )
    if verdict == "changes_requested":
        issues = [
            {
                "id": "routing.shared-route",
                "status": "open",
                "category": "routing",
                "claim": "Two independently maintained units share one route.",
                "resolution": "Split the change surfaces or explain the causal merge.",
                "area": "composition",
                "page_ids": ["answer"],
                "operation": "split",
            }
        ]
    write(
        path,
        json.dumps({"subject_digest": digest, "verdict": verdict, "issues": issues}),
    )


def approve_plan(root: pathlib.Path, run: pathlib.Path) -> None:
    progress = run / "work/progress.md"
    if "repo-wiki-progress:initial" in progress.read_text():
        write(progress, "# Progress\n\nPlan complete; review is next.\n")
    packet = _state.plan_review_prepare(root)
    assert packet["ok"]
    plan_review(run / "work/plan-review.json", packet["subject_digest"], "approved")


def approve_composition(root: pathlib.Path, run: pathlib.Path) -> None:
    packet = _state.composition_review_prepare(root)
    assert packet["ok"]
    composition_review(
        run / "work/composition-review.json", packet["subject_digest"], "approved"
    )


def test_artifact_loop_reaches_publication_and_rechecks_changes(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    assert (run / "index/src.md").is_file()

    search = _state.evidence_search(root, "src", "return 42")
    assert search["items"][0]["locator"] == "src/app.py#L2"
    assert "return 42" in _state.evidence_read(root, "src/app.py#L1-L2")["text"]

    write_work(run)
    assert _state.status(root)["next_actions"] == ["review plan"]
    plan_packet = _state.plan_review_prepare(root)
    plan_review(
        run / "work/plan-review.json",
        plan_packet["subject_digest"],
        "changes_requested",
    )
    assert _state.status(root)["phase"] == "plan"
    plan_path = run / "work/plan.md"
    write(
        plan_path,
        plan_path.read_text() + "\nThe missing subsystem is now accounted for.\n",
    )
    repaired_plan_packet = _state.plan_review_prepare(root)
    assert repaired_plan_packet["subject_digest"] != plan_packet["subject_digest"]
    assert repaired_plan_packet["previous_review"]["issues"][0]["id"] == (
        "domain.visible-subsystem"
    )
    plan_review(
        run / "work/plan-review.json",
        repaired_plan_packet["subject_digest"],
        "approved",
    )
    assert _state.status(root)["next_actions"] == ["review composition"]
    composition_packet = _state.composition_review_prepare(root)
    composition_review(
        run / "work/composition-review.json",
        composition_packet["subject_digest"],
        "changes_requested",
    )
    assert _state.status(root)["phase"] == "write"
    composition_path = run / "work/composition.md"
    write(
        composition_path,
        composition_path.read_text()
        + "\nEach page now has an explicit maintainer route.\n",
    )
    repaired_composition_packet = _state.composition_review_prepare(root)
    assert (
        repaired_composition_packet["subject_digest"]
        != composition_packet["subject_digest"]
    )
    assert repaired_composition_packet["previous_review"]["issues"][0]["id"] == (
        "routing.shared-route"
    )
    composition_review(
        run / "work/composition-review.json",
        repaired_composition_packet["subject_digest"],
        "approved",
    )
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
    assert second["previous_review"]["issues"][0]["id"] == ("coverage.answer-failure")
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
        ).issues
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

    approve_plan(root, run)
    approve_composition(root, run)
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
        ).issues
        if item.severity == "error"
    ]
    assert errors == []


def test_status_derives_plan_composition_and_draft_repairs(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write(run / "work/plan.md", plan())
    assert _state.status(root)["issues"][0]["code"] == "progress-stale"
    write(run / "work/progress.md", "# Progress\n\nPlan complete; review is next.\n")
    assert _state.status(root)["issues"][0]["code"] == "plan-review-missing"
    approve_plan(root, run)
    assert _state.status(root)["issues"][0]["code"] == "composition-missing"
    write(run / "work/composition.md", composition())
    status = _state.status(root)
    assert status["phase"] == "composition-review"
    assert status["issues"][0]["code"] == "composition-review-missing"
    packet = _state.composition_review_prepare(root)
    write(
        run / "work/composition-review.json",
        json.dumps(
            {
                "subject_digest": packet["subject_digest"],
                "verdict": "changes_requested",
                "issues": [
                    {
                        "id": "routing.invalid-area",
                        "status": "open",
                        "category": "routing",
                        "claim": "The route is ambiguous.",
                        "resolution": "Repair the Composition route.",
                        "area": "page",
                        "page_ids": ["answer"],
                        "operation": "repair",
                    }
                ],
            }
        ),
    )
    assert _state.status(root)["issues"][0]["code"] == (
        "composition-review-area-invalid"
    )
    approve_composition(root, run)
    status = _state.status(root)
    assert status["phase"] == "write"
    assert {item["code"] for item in status["issues"]} == {"page-draft-missing"}


def test_status_summarizes_large_issue_sets(tmp_path):
    root = workspace(tmp_path)
    start(root)
    state = _state.read(root)
    issues = [
        {
            "severity": "error",
            "code": "draft-invalid" if index < 11 else "link-invalid",
            "path": f"drafts/{index}.md",
            "line": None,
            "message": "invalid",
        }
        for index in range(12)
    ]

    status = _state._status_payload(root, state, "write", [], issues=issues)

    assert len(status["issues"]) == 10
    assert status["issue_counts"] == {"draft-invalid": 11, "link-invalid": 1}
    assert status["issues_truncated"] == 2


def test_run_policy_is_snapshotted_and_controls_evidence(tmp_path):
    policy = RunPolicy.defaults().model_dump(mode="json")
    policy["agents"]["max_active_children"] = 2
    policy["evidence"]["search"]["max_results"] = 1
    policy["evidence"]["read"]["default_lines"] = 1
    policy["evidence"]["read"]["max_lines"] = 1
    root = workspace(tmp_path, policy=policy)
    source = root / "source"
    write(source / "app.py", "match one\nmatch two\nmatch three\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(
        ["git", "-C", str(source), "commit", "-qm", "add evidence rows"],
        check=True,
    )

    start(root)
    assert _state.status(root)["policy"] == policy
    search = _state.evidence_search(root, "src", "match")
    assert len(search["items"]) == 1
    assert search["limit_reached"] is True
    continued = _state.evidence_search(root, "src", "match", after=search["next_after"])
    assert continued["items"][0]["locator"] == "src/app.py#L2"
    read = _state.evidence_read(root, "src/app.py#L1-L3")
    assert read["end"] == 1
    assert read["limit_reached"] is True
    assert read["next_locator"] == "src/app.py#L2-L2"

    with pytest.raises(_workspace.WorkspaceError, match="active run"):
        _workspace.configure(root, policy_updates={"max_active_children": 4})


def test_evidence_byte_limits_preserve_json_and_continuation(tmp_path):
    policy = RunPolicy.defaults().model_dump(mode="json")
    policy["evidence"]["search"].update(max_results=100, max_output_bytes=4096)
    policy["evidence"]["read"].update(
        default_lines=100, max_lines=100, max_output_bytes=4096
    )
    root = workspace(tmp_path, policy=policy)
    source = root / "source"
    write(
        source / "wide.txt",
        "".join(f'match {index} "\\" 中文' * 50 + "\n" for index in range(12)),
    )
    subprocess.run(["git", "-C", str(source), "add", "wide.txt"], check=True)
    subprocess.run(
        ["git", "-C", str(source), "commit", "-qm", "add wide evidence"],
        check=True,
    )
    start(root)

    first = _state.evidence_search(root, "src", "match")
    second = _state.evidence_search(root, "src", "match", after=first["next_after"])
    assert first["limit_reached"] and first["has_more"]
    assert compact_json_size(first) <= 4096
    assert compact_json_size(second) <= 4096
    assert {item["locator"] for item in first["items"]}.isdisjoint(
        item["locator"] for item in second["items"]
    )

    read = _state.evidence_read(root, "src/wide.txt#L1-L12")
    assert read["limit_reached"] and read["has_more"]
    assert read["next_locator"]
    assert read["clipped_lines"]
    assert compact_json_size(read) <= 4096


def test_workspace_and_run_reject_missing_policy(tmp_path):
    root = workspace(tmp_path)
    config_path = root / "workspace.json"
    config = json.loads(config_path.read_text())
    config.pop("policy")
    config_path.write_text(json.dumps(config))
    with pytest.raises(_workspace.WorkspaceError, match="workspace policy"):
        _workspace.load(root)

    config["policy"] = RunPolicy.defaults().model_dump(mode="json")
    config_path.write_text(json.dumps(config))
    start(root)
    state = _state.read(root)
    state.pop("policy")
    state_path = _state.run_dir(root, state["run_id"]) / "state.json"
    state_path.write_text(json.dumps(state))
    with pytest.raises(_state.StateError, match="run policy"):
        _state.read(root)


def test_active_run_rejects_a_changed_skill_bundle(tmp_path):
    root = workspace(tmp_path)
    start(root)
    state = _state.read(root)
    state["skill_bundle_digest"] = "0" * 64
    state_path = _state.run_dir(root, state["run_id"]) / "state.json"
    state_path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(_state.StateError, match="skill bundle changed"):
        _state.read(root)

    state["status"] = "published"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    assert _state.read(root)["status"] == "published"


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
    approve_plan(root, run)
    approve_composition(root, run)
    packet = _state.review_prepare(root)
    assert packet["ok"]


def test_chinese_partial_page_uses_localized_gap_heading(tmp_path):
    root = workspace(tmp_path, "zh")
    run = start(root)
    write(
        run / "work/plan.md",
        render(
            {
                "kind": "knowledge-plan",
                "units": [unit("answer", "app.py", "capability")],
                "gaps": [],
            },
            "# Plan\n\n一个语义单元。\n",
        ),
    )
    write(run / "work/progress.md", "# Progress\n\n规划完成，下一步审查。\n")
    approve_plan(root, run)
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
                        "title": "答案行为",
                        "description": "修改答案行为前阅读。",
                        "tags": ["答案"],
                        "units": ["answer"],
                        "diagrams": [],
                    }
                ],
                "gaps": [],
            },
            "# Composition\n\n一个单元对应一个页面。\n",
        ),
    )
    write(
        run / "work/drafts/answer.md",
        render(
            {
                "coverage": "partial",
                "sources": [{"id": "entry", "resource": "src/app.py#L1-L2"}],
            },
            "## 职责\n\n入口定义答案行为。[^entry]\n\n"
            "## 缺口\n\n异常路径尚未捕获。\n\n"
            "[^entry]: 冻结的源码入口。\n",
        ),
    )
    approve_composition(root, run)
    assert _state.status(root)["next_actions"] == ["review prepare"]


def test_chinese_page_rejects_english_template_heading(tmp_path):
    root = workspace(tmp_path, "zh")
    run = start(root)
    state = _state.read(root)
    page = run / "candidate/answer.md"
    write(
        page,
        render(
            {
                "id": "answer",
                "type": "Domain",
                "title": "答案行为",
                "description": "修改答案行为前阅读。",
                "tags": [],
                "generated": {
                    "by": "repo-wiki",
                    "at": datetime.fromisoformat(state["started_at"]),
                },
                "status": "draft",
                "coverage": "full",
                "language": "zh",
                "diagrams": [],
                "sources": [],
            },
            "## Responsibility and public surface\n\n这里说明答案行为。\n",
        ),
    )
    issues = _validate.validate_page(root, state, page)
    assert [item.code for item in issues] == ["template-heading-leak"]


def test_candidate_validation_collects_independent_errors_after_bad_plan(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    state = _state.read(root)
    write(run / "work/plan.md", "---\nkind: wrong\n---\n\n# Bad plan\n")
    page = run / "candidate/answer.md"
    write(
        page,
        render(
            {
                "id": "answer",
                "type": "Domain",
                "title": "答案",
                "description": "只有中文说明。",
                "tags": [],
                "generated": {
                    "by": "repo-wiki",
                    "at": datetime.fromisoformat(state["started_at"]),
                },
                "status": "draft",
                "coverage": "full",
                "language": "en",
                "diagrams": [],
                "sources": [],
            },
            "## 职责与公开边界\n\n{{unfinished}}\n",
        ),
    )
    result = _validate.validate_candidate(root, state, published=False)
    codes = {item.code for item in result.issues}
    assert {
        "schema-invalid",
        "language-content-missing",
        "template-heading-leak",
    } <= codes
    assert "placeholder-remaining" in codes
    assert not result.complete
    assert "composition-unit-binding" in result.skipped_checks


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
