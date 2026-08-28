import json
import pathlib
import subprocess

import _index
import _publish
import _state
import _validate
import _workspace
import pytest


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def git_source(path: pathlib.Path) -> pathlib.Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "qa@example.test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(path), "config", "user.name", "QA"], check=True)
    write(path / "app.py", "def answer():\n    return 42\n")
    write(path / "lib.py", "def branch():\n    return 'branch'\n")
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "initial"], check=True)
    return path


def workspace(tmp_path: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "source")
    _workspace.init(root, "en", 30)
    _workspace.add_git_link(root, str(source), "src")
    return root, source


def start(root: pathlib.Path) -> pathlib.Path:
    _state.start_run(root, "repo-wiki/test", "producer-session")
    state = _state.read(root)
    return _state.run_dir(root, state["run_id"])


def plan_page(
    path: str,
    *,
    owner: str = "workspace",
    source: str = "src",
    source_path: str = "app.py",
    depends_on: list[str] | None = None,
) -> dict:
    return {
        "path": path,
        "type": "Architecture" if "architecture" in path else "Overview",
        "owner": owner,
        "title": pathlib.PurePosixPath(path).stem.title(),
        "description": "Open before changing this behavior.",
        "tags": ["routing"],
        "scopes": [{"source": source, "paths": [source_path]}],
        "depends_on": depends_on or [],
    }


def plan(*pages: dict) -> dict:
    return {"pages": list(pages), "gaps": []}


def root_plan() -> dict:
    return plan(
        plan_page("architecture.md"),
        plan_page("overview.md"),
    )


def branch_plan() -> dict:
    leaf = "data/src/leaf.md"
    branch = "data/src/branch.md"
    architecture = "architecture.md"
    return plan(
        plan_page(leaf, owner="src"),
        plan_page(branch, owner="src", source_path="lib.py"),
        plan_page(
            architecture,
            depends_on=[leaf],
        ),
        plan_page(
            "overview.md",
            depends_on=[architecture, branch],
        ),
    )


def chain_plan() -> dict:
    leaf = "data/src/leaf.md"
    architecture = "architecture.md"
    return plan(
        plan_page(leaf, owner="src"),
        plan_page(architecture, depends_on=[leaf]),
        plan_page("overview.md", depends_on=[architecture]),
    )


def page_text(resource: str = "src/app.py#L1-L2") -> str:
    return f"""---
type: Overview
title: Temporary
description: Temporary routing text.
coverage: full
sources:
  - id: code
    resource: {resource}
---

## Responsibility

The selected behavior is implemented at the cited entry point.[^code]

[^code]: Source entry point
"""


def submit(root: pathlib.Path, target_id: str, content: str) -> tuple[dict, dict]:
    packet = _state.task_start(root, target_id)
    write(pathlib.Path(packet["artifact"]), content)
    result = _state.task_complete(root, target_id, packet["attempt"])
    return packet, result


def submit_plan(root: pathlib.Path, payload: dict) -> tuple[dict, dict]:
    return submit(root, "plan:workspace", json.dumps(payload))


def approve_review(root: pathlib.Path, page: str) -> tuple[dict, dict]:
    packet = _state.task_start(root, f"review:{page}")
    report = {
        "page": page,
        "page_digest": packet["page_digest"],
        "verdict": "approved",
        "issues": [],
    }
    write(pathlib.Path(packet["artifact"]), json.dumps(report))
    result = _state.task_complete(root, f"review:{page}", packet["attempt"])
    return packet, result


def target_statuses(root: pathlib.Path) -> dict[str, str]:
    return {item["id"]: item["status"] for item in _state.status(root)["targets"]}


def test_run_start_exposes_only_workspace_plan(tmp_path):
    root, _ = workspace(tmp_path)

    result = _state.start_run(root, "repo-wiki/test", "producer-session")

    assert result["contract"] == "target-dag"
    assert result["ready_targets"] == ["plan:workspace"]
    assert result["targets"] == [
        {"id": "plan:workspace", "kind": "plan", "status": "pending"}
    ]
    assert result["next_actions"] == ["task start plan:workspace"]


def test_attempt_is_isolated_until_gate_promotes_it(tmp_path):
    root, _ = workspace(tmp_path)
    run = start(root)
    canonical = run / "drafts/plan/workspace.json"
    payload = root_plan()

    packet = _state.task_start(root, "plan:workspace")
    attempt = pathlib.Path(packet["artifact"])
    assert attempt.is_relative_to(run / "attempts")
    assert not canonical.exists()
    write(attempt, json.dumps(payload))
    assert not canonical.exists()

    result = _state.task_complete(root, "plan:workspace", packet["attempt"])

    assert result["ok"]
    assert json.loads(canonical.read_text()) == payload
    assert not attempt.exists()
    assert set(result["state"]["ready_targets"]) == {
        "page:architecture.md",
        "page:overview.md",
    }


def test_old_attempt_token_is_stale_after_retry(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    first = _state.task_start(root, "plan:workspace")
    write(pathlib.Path(first["artifact"]), "discard me")
    _state.task_fail(root, "plan:workspace", "retry", first["attempt"])
    second = _state.task_start(root, "plan:workspace")

    with pytest.raises(_state.StateError, match="stale or inactive"):
        _state.task_complete(root, "plan:workspace", first["attempt"])

    assert first["attempt"] != second["attempt"]
    assert not pathlib.Path(first["artifact"]).exists()


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ("roots", {"overview-missing", "architecture-missing"}),
        ("scope", {"scope-path-invalid"}),
        ("cycle", {"schema-invalid"}),
    ],
)
def test_plan_gate_rejects_invalid_roots_scopes_and_dag(tmp_path, case, expected):
    root, _ = workspace(tmp_path)
    start(root)
    if case == "roots":
        payload = plan(plan_page("data/src/leaf.md", owner="src"))
    elif case == "scope":
        payload = root_plan()
        payload["pages"][0]["scopes"][0]["paths"] = ["missing"]
    elif case == "cycle":
        payload = plan(
            plan_page("architecture.md", depends_on=["overview.md"]),
            plan_page("overview.md", depends_on=["architecture.md"]),
        )

    _, result = submit_plan(root, payload)

    assert not result["ok"]
    assert expected <= {item["code"] for item in result["issues"]}


def test_structured_gate_rejects_non_utf8_and_oversized_artifacts(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    packet = _state.task_start(root, "plan:workspace")
    artifact = pathlib.Path(packet["artifact"])
    artifact.parent.mkdir(parents=True)

    artifact.write_bytes(b"\xff")
    result = _state.task_complete(root, "plan:workspace", packet["attempt"])
    assert {item["code"] for item in result["issues"]} == {"artifact-invalid"}

    size = _validate.MAX_STRUCTURED_ARTIFACT_BYTES + 1
    artifact.write_text("x" * size, encoding="utf-8")
    result = _state.task_complete(root, "plan:workspace", packet["attempt"])
    assert {item["code"] for item in result["issues"]} == {"artifact-too-large"}
    message = result["issues"][0]["message"]
    assert str(size) in message
    assert str(_validate.MAX_STRUCTURED_ARTIFACT_BYTES) in message
    assert "remove repeated items" in message


def test_review_is_page_bound_and_unlocks_parent_without_branch_barrier(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    assert submit_plan(root, branch_plan())[1]["ok"]
    leaf = "data/src/leaf.md"
    assert submit(root, f"page:{leaf}", page_text())[1]["ok"]
    assert "page_digest" not in _state.read(root)["targets"][f"review:{leaf}"]["spec"]

    with pytest.raises(_state.StateError, match="distinct"):
        _state.review_start(root, "repo-wiki/reviewer", "producer-session")
    review = _state.review_start(root, "repo-wiki/reviewer", "review-session")
    assert review["ready_targets"] == [f"review:{leaf}"]

    packet = _state.task_start(root, f"review:{leaf}")
    wrong = {
        "page": leaf,
        "page_digest": "0" * 64,
        "verdict": "approved",
        "issues": [],
    }
    write(pathlib.Path(packet["artifact"]), json.dumps(wrong))
    rejected = _state.task_complete(root, f"review:{leaf}", packet["attempt"])
    assert not rejected["ok"]
    assert {item["code"] for item in rejected["issues"]} == {"review-digest-invalid"}

    wrong["page_digest"] = packet["page_digest"]
    write(pathlib.Path(packet["artifact"]), json.dumps(wrong))
    approved = _state.task_complete(root, f"review:{leaf}", packet["attempt"])

    assert approved["ok"] and approved["verdict"] == "approved"
    assert "page:architecture.md" in approved["state"]["ready_targets"]
    assert "page:data/src/branch.md" in approved["state"]["ready_targets"]


def test_review_page_reopen_keeps_all_ancestors_blocked(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    assert submit_plan(root, chain_plan())[1]["ok"]
    leaf = "data/src/leaf.md"
    assert submit(root, f"page:{leaf}", page_text())[1]["ok"]
    _state.review_start(root, "repo-wiki/reviewer", "review-session")
    packet = _state.task_start(root, f"review:{leaf}")
    report = {
        "page": leaf,
        "page_digest": packet["page_digest"],
        "verdict": "changes_requested",
        "issues": [
            {
                "category": "unsupported-claim",
                "target": leaf,
                "claim": "The selected behavior is implemented here.",
                "resolution": "Rewrite the claim with evidence.",
                "reopen": "page",
            }
        ],
    }
    write(pathlib.Path(packet["artifact"]), json.dumps(report))

    result = _state.task_complete(root, f"review:{leaf}", packet["attempt"])

    assert result["ok"] and result["verdict"] == "changes_requested"
    assert result["state"]["ready_targets"] == [f"page:{leaf}"]
    statuses = target_statuses(root)
    assert statuses[f"page:{leaf}"] == "pending"
    assert statuses["page:architecture.md"] == "pending"
    assert statuses["page:overview.md"] == "pending"


def test_refresh_rejects_submission_from_the_old_revision(tmp_path):
    root, source = workspace(tmp_path)
    run = start(root)
    packet = _state.task_start(root, "plan:workspace")
    write(pathlib.Path(packet["artifact"]), json.dumps(root_plan()))
    write(source / "app.py", "def answer():\n    return 43\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "refresh"], check=True)

    refreshed = _state.refresh_source(root, "src")

    assert refreshed["ready_targets"] == ["plan:workspace"]
    assert not (run / "drafts/plan/workspace.json").exists()
    with pytest.raises(_state.StateError, match="stale or inactive"):
        _state.task_complete(root, "plan:workspace", packet["attempt"])


def test_unchanged_refresh_preserves_active_attempt(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    packet = _state.task_start(root, "plan:workspace")
    write(pathlib.Path(packet["artifact"]), json.dumps(root_plan()))

    refreshed = _state.refresh_source(root, "src")

    assert refreshed["in_progress"] == ["plan:workspace"]
    assert _state.task_complete(root, "plan:workspace", packet["attempt"])["ok"]


def test_failed_refresh_restores_the_previous_pin(tmp_path, monkeypatch):
    root, source = workspace(tmp_path)
    start(root)
    previous = _state.read(root)["revisions"][0]
    write(source / "app.py", "def answer():\n    return 43\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "refresh"], check=True)
    current = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    write_index = _index.write_source_index

    def fail_new_index(root, run_id, registered, revision):
        if revision.get("commit") == current:
            raise RuntimeError("index failed")
        return write_index(root, run_id, registered, revision)

    monkeypatch.setattr(_index, "write_source_index", fail_new_index)
    with pytest.raises(RuntimeError, match="index failed"):
        _state.refresh_source(root, "src")

    state = _state.read(root)
    assert state["revisions"] == [previous]
    _state.assert_revisions_current(root, state)


def test_refresh_and_replan_preserve_unaffected_source_branch(tmp_path):
    root, source = workspace(tmp_path)
    other = git_source(root / "other")
    _workspace.add_git_link(root, str(other), "other")
    start(root)
    src_leaf = "data/src/leaf.md"
    other_leaf = "data/other/leaf.md"
    payload = plan(
        plan_page(src_leaf, owner="src"),
        plan_page(other_leaf, owner="other", source="other"),
        plan_page(
            "architecture.md",
            depends_on=[src_leaf, other_leaf],
        ),
        plan_page(
            "overview.md",
            depends_on=["architecture.md"],
        ),
    )
    assert submit_plan(root, payload)[1]["ok"]
    assert submit(root, f"page:{src_leaf}", page_text())[1]["ok"]
    assert submit(root, f"page:{other_leaf}", page_text("other/app.py#L1-L2"))[1]["ok"]
    _state.review_start(root, "repo-wiki/reviewer", "review-session")
    approve_review(root, src_leaf)
    approve_review(root, other_leaf)

    write(source / "app.py", "def answer():\n    return 43\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "refresh"], check=True)
    refreshed = _state.refresh_source(root, "src")

    assert refreshed["ready_targets"] == ["plan:workspace", f"page:{src_leaf}"]
    statuses = target_statuses(root)
    assert statuses[f"page:{other_leaf}"] == "complete"
    assert statuses[f"review:{other_leaf}"] == "complete"

    assert submit_plan(root, payload)[1]["ok"]
    statuses = target_statuses(root)
    assert statuses[f"page:{other_leaf}"] == "complete"
    assert statuses[f"review:{other_leaf}"] == "complete"


def test_candidate_tamper_is_detected_before_more_work(tmp_path):
    root, _ = workspace(tmp_path)
    run = start(root)
    assert submit_plan(root, root_plan())[1]["ok"]
    assert submit(root, "page:architecture.md", page_text())[1]["ok"]
    page = run / "candidate/architecture.md"
    write(page, page.read_text() + "\ntampered\n")

    with pytest.raises(_state.StateError, match="completed artifact changed"):
        _state.status(root)


def test_navigation_is_bounded_to_regular_files_inside_the_pin(tmp_path):
    root, source = workspace(tmp_path)
    secret = tmp_path / "secret.txt"
    write(secret, "SECRET\n")
    (source / "escape").symlink_to(secret)
    subprocess.run(["git", "-C", str(source), "add", "escape"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "symlink"], check=True)
    start(root)
    _state.task_start(root, "plan:workspace")

    assert _state.task_search(root, "plan:workspace", "src", "return")["results"]
    assert (
        "1|def answer"
        in _state.task_read(root, "plan:workspace", "src", "app.py")["text"]
    )
    with pytest.raises(_state.StateError, match="end must not precede start"):
        _state.task_read(root, "plan:workspace", "src", "app.py", end=0)
    with pytest.raises(_state.StateError, match="regular file inside the Pin"):
        _state.task_read(root, "plan:workspace", "src", "escape")


def test_pause_and_resume_preserve_ready_set(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)

    paused = _state.pause(root)
    assert paused["status"] == "paused"
    assert paused["next_actions"] == ["run resume"]
    with pytest.raises(_state.StateError, match="run is paused"):
        _state.task_start(root, "plan:workspace")

    resumed = _state.resume(root)
    assert resumed["status"] == "active"
    assert resumed["ready_targets"] == ["plan:workspace"]


def test_publication_requires_every_page_to_be_machine_confirmed(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    with pytest.raises(_publish.PublishError, match="approved"):
        _publish.publish(root)
    assert submit_plan(root, root_plan())[1]["ok"]
    for page in ("architecture.md", "overview.md"):
        assert submit(root, f"page:{page}", page_text())[1]["ok"]
    _state.review_start(root, "repo-wiki/reviewer", "review-session")

    approve_review(root, "architecture.md")
    _, final = approve_review(root, "overview.md")

    assert final["state"]["status"] == "approved"
    published = _publish.publish(root)
    assert pathlib.Path(published["path"], "index.md").is_file()
    assert _state.status(root)["status"] == "published"
    state = _state.read(root)
    assert not _workspace.pin_dir(root, state["run_id"], "src").exists()
    manifest = json.loads(
        pathlib.Path(published["path"], ".okf-manifest.json").read_text()
    )
    for page, entry in manifest["pages"].items():
        assert (
            entry["input_digest"]
            == state["targets"][f"page:{page}"]["last_attempt"]["input_digest"]
        )
