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
    complete_source_plans(root)
    state = _state.read(root)
    return _state.run_dir(root, state["run_id"])


def source_brief(source: str, counterparts: list[str] | None = None) -> dict:
    counterparts = counterparts or []
    return {
        "source": source,
        "roles": ["business-domain-owner"],
        "concepts": [
            {
                "name": "answer-lifecycle",
                "description": "The answer follows one implementation lifecycle.",
                "paths": ["app.py"],
                "evidence_seeds": [f"{source}/app.py#L1-L2"],
            }
        ],
        "connections": (
            [
                {
                    "name": "answer-contract",
                    "description": "The answer contract is shared with another Source.",
                    "evidence_seeds": [f"{source}/app.py#L1-L2"],
                    "counterpart_sources": counterparts,
                    "counterpart_queries": ["answer"],
                }
            ]
            if counterparts
            else []
        ),
        "gaps": [],
    }


def complete_source_plans(root: pathlib.Path) -> None:
    state = _state.read(root)
    source_targets = [
        target
        for target in state["targets"].values()
        if target["kind"] == "plan" and target["spec"].get("mode") == "source"
    ]
    names = [target["spec"]["source"] for target in source_targets]
    for target in source_targets:
        counterparts = [name for name in names if name != target["spec"]["source"]]
        packet = _state.task_start(root, target["id"])
        write(
            pathlib.Path(packet["artifact"]),
            json.dumps(source_brief(target["spec"]["source"], counterparts)),
        )
        assert _state.task_complete(root, target["id"], packet["attempt"])["ok"]


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
        "evidence_seeds": (
            [] if owner == "workspace" else [f"{source}/{source_path}#L1-L1"]
        ),
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


def approve_review_target(root: pathlib.Path, target_id: str) -> tuple[dict, dict]:
    state = _state.read(root)
    if "review" not in state:
        _state.review_start(root, "repo-wiki/reviewer", "review-session")
    packet = _state.task_start(root, target_id)
    report = {
        "subject": packet["subject"],
        "subject_digest": packet["subject_digest"],
        "verdict": "approved",
        "issues": [],
    }
    write(pathlib.Path(packet["artifact"]), json.dumps(report))
    result = _state.task_complete(root, target_id, packet["attempt"])
    return packet, result


def approve_plan_review(root: pathlib.Path) -> tuple[dict, dict]:
    return approve_review_target(root, "review:plan")


def approve_review(root: pathlib.Path, page: str) -> tuple[dict, dict]:
    return approve_review_target(root, f"review:{page}")


def request_changes(
    root: pathlib.Path, target_id: str, reopen_target: str
) -> tuple[dict, dict]:
    state = _state.read(root)
    if "review" not in state:
        _state.review_start(root, "repo-wiki/reviewer", "review-session")
    packet = _state.task_start(root, target_id)
    report = {
        "subject": packet["subject"],
        "subject_digest": packet["subject_digest"],
        "verdict": "changes_requested",
        "issues": [
            {
                "category": "domain-coverage",
                "claim": "A required domain is missing.",
                "resolution": "Add the missing domain and evidence scope.",
                "reopen_target": reopen_target,
            }
        ],
    }
    write(pathlib.Path(packet["artifact"]), json.dumps(report))
    result = _state.task_complete(root, target_id, packet["attempt"])
    return packet, result


def target_statuses(root: pathlib.Path) -> dict[str, str]:
    return {item["id"]: item["status"] for item in _state.status(root)["targets"]}


def test_run_start_exposes_only_workspace_plan(tmp_path):
    root, _ = workspace(tmp_path)

    result = _state.start_run(root, "repo-wiki/test", "producer-session")

    assert result["contract"] == "source-plan-dag"
    assert result["ready_targets"] == ["plan:workspace"]
    assert result["targets"] == [
        {"id": "plan:workspace", "kind": "plan", "status": "pending"}
    ]
    assert result["next_actions"] == ["task start plan:workspace"]


def test_legacy_run_contract_is_rejected_without_migration(tmp_path):
    root, _ = workspace(tmp_path)
    started = _state.start_run(root, "repo-wiki/test", "producer-session")
    path = pathlib.Path(started["run_dir"]) / "state.json"
    state = json.loads(path.read_text(encoding="utf-8"))
    state["contract"] = "target-dag"
    write(path, json.dumps(state))

    with pytest.raises(_state.StateError, match="source-plan-dag is required"):
        _state.read(root)


def test_multi_source_run_fans_out_briefs_then_fans_in_workspace_plan(tmp_path):
    root, _ = workspace(tmp_path)
    other = git_source(root / "other")
    _workspace.add_git_link(root, str(other), "other")

    started = _state.start_run(root, "repo-wiki/test", "producer-session")

    assert set(started["ready_targets"]) == {"plan:src", "plan:other"}
    for name, counterpart in (("src", "other"), ("other", "src")):
        packet = _state.task_start(root, f"plan:{name}")
        assert packet["reference"].endswith("/references/source-plan.md")
        assert packet["navigation_budget"] == {"calls": 12, "bytes": 64 * 1024}
        assert {
            item.get("source")
            for item in packet["inputs"]
            if item["role"] == "source_index"
        } == {name}
        with pytest.raises(_state.StateError, match="outside target scope"):
            _state.task_read(root, f"plan:{name}", f"{counterpart}/app.py#L1-L2")
        write(
            pathlib.Path(packet["artifact"]),
            json.dumps(source_brief(name, [counterpart])),
        )
        assert _state.task_complete(root, f"plan:{name}", packet["attempt"])["ok"]

    assert _state.status(root)["ready_targets"] == ["plan:workspace"]
    packet = _state.task_start(root, "plan:workspace")
    brief_inputs = [item for item in packet["inputs"] if item["role"] == "source_brief"]
    assert {(item["target"], item["source"]) for item in brief_inputs} == {
        ("plan:src", "src"),
        ("plan:other", "other"),
    }
    assert packet["navigation_budget"] == {"calls": 32, "bytes": 128 * 1024}


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda payload: payload.update(source="other"), "source-brief-owner-invalid"),
        (
            lambda payload: payload["concepts"][0].update(paths=["missing.py"]),
            "source-brief-path-invalid",
        ),
        (
            lambda payload: payload["connections"][0].update(
                counterpart_sources=["src"]
            ),
            "source-brief-counterpart-invalid",
        ),
    ],
)
def test_source_brief_gate_binds_owner_paths_evidence_and_counterparts(
    tmp_path, mutate, expected
):
    root, _ = workspace(tmp_path)
    other = git_source(root / "other")
    _workspace.add_git_link(root, str(other), "other")
    _state.start_run(root, "repo-wiki/test", "producer-session")
    packet = _state.task_start(root, "plan:src")
    payload = source_brief("src", ["other"])
    mutate(payload)
    write(pathlib.Path(packet["artifact"]), json.dumps(payload))

    result = _state.task_complete(root, "plan:src", packet["attempt"])

    assert not result["ok"]
    assert expected in {item["code"] for item in result["issues"]}


def test_source_brief_counterparts_are_bound_to_run_inputs(tmp_path):
    root, _ = workspace(tmp_path)
    other = git_source(root / "other")
    _workspace.add_git_link(root, str(other), "other")
    _state.start_run(root, "repo-wiki/test", "producer-session")
    git_source(root / "late")
    config_path = root / "workspace.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["sources"].append(
        {"name": "late", "kind": "git", "path": "late", "origin": "late"}
    )
    write(config_path, json.dumps(config))

    _, result = submit(root, "plan:src", json.dumps(source_brief("src", ["late"])))

    assert not result["ok"]
    assert "source-brief-counterpart-invalid" in {
        item["code"] for item in result["issues"]
    }


def test_plan_review_routes_source_recall_repair_to_only_that_brief(tmp_path):
    root, _ = workspace(tmp_path)
    other = git_source(root / "other")
    _workspace.add_git_link(root, str(other), "other")
    start(root)
    assert submit_plan(root, root_plan())[1]["ok"]
    before = _state.read(root)["targets"]["plan:other"]["output_digest"]

    packet, changed = request_changes(root, "review:plan", "plan:src")

    assert {
        item["source"] for item in packet["inputs"] if item["role"] == "source_brief"
    } == {
        "src",
        "other",
    }
    assert changed["state"]["ready_targets"] == ["plan:src"]
    state = _state.read(root)
    assert state["targets"]["plan:other"]["status"] == "complete"
    assert state["targets"]["plan:other"]["output_digest"] == before
    assert state["targets"]["plan:workspace"]["status"] == "pending"
    submit(root, "plan:src", json.dumps(source_brief("src", ["other"])))
    assert _state.status(root)["ready_targets"] == ["plan:workspace"]


def test_attempt_is_isolated_until_gate_promotes_it(tmp_path):
    root, _ = workspace(tmp_path)
    run = start(root)
    canonical = run / "drafts/plan/workspace.json"
    payload = root_plan()

    packet = _state.task_start(root, "plan:workspace")
    attempt = pathlib.Path(packet["artifact"])
    packet_path = pathlib.Path(packet["packet_path"])
    assert attempt.is_relative_to(run / "attempts")
    assert packet_path.is_file()
    assert _state.task_packet(root, "plan:workspace", packet["attempt"]) == packet
    assert not canonical.exists()
    write(attempt, json.dumps(payload))
    assert not canonical.exists()

    result = _state.task_complete(root, "plan:workspace", packet["attempt"])

    assert result["ok"]
    assert json.loads(canonical.read_text()) == payload
    assert not attempt.exists()
    assert not packet_path.exists()
    assert result["state"]["ready_targets"] == ["review:plan"]


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
    assert not pathlib.Path(first["packet_path"]).exists()


def test_plan_review_blocks_pages_and_follow_up_receives_prior_report(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    assert submit_plan(root, root_plan())[1]["ok"]

    first, changed = request_changes(root, "review:plan", "plan:workspace")

    assert first["subject"] == "plan:workspace"
    assert changed["state"]["ready_targets"] == ["plan:workspace"]
    assert submit_plan(root, root_plan())[1]["ok"]
    follow_up = _state.task_start(root, "review:plan")
    assert follow_up["review_mode"] == "follow_up"
    assert {item["role"] for item in follow_up["inputs"]} >= {
        "subject",
        "previous_review",
        "source_index",
    }
    assert not any(
        target.startswith("page:") for target in _state.status(root)["ready_targets"]
    )


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


@pytest.mark.parametrize(
    ("seed", "expected"),
    [
        (None, "plan-evidence-seed-missing"),
        ("src/lib.py#L1-L1", "plan-evidence-outside-scope"),
        ("src/missing.py#L1-L1", "plan-evidence-unresolved"),
    ],
)
def test_plan_gate_requires_resolvable_in_scope_evidence_seeds(
    tmp_path, seed, expected
):
    root, _ = workspace(tmp_path)
    start(root)
    payload = branch_plan()
    leaf = next(page for page in payload["pages"] if page["path"] == "data/src/leaf.md")
    leaf["evidence_seeds"] = [] if seed is None else [seed]

    _, result = submit_plan(root, payload)

    assert not result["ok"]
    assert expected in {item["code"] for item in result["issues"]}


def test_structured_gate_rejects_non_utf8_and_oversized_artifacts(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    packet = _state.task_start(root, "plan:workspace")
    artifact = pathlib.Path(packet["artifact"])
    artifact.parent.mkdir(parents=True, exist_ok=True)

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
    assert approve_plan_review(root)[1]["ok"]
    leaf = "data/src/leaf.md"
    assert submit(root, f"page:{leaf}", page_text())[1]["ok"]
    assert (
        _state.read(root)["targets"][f"review:{leaf}"]["spec"]["subject"]
        == f"page:{leaf}"
    )

    with pytest.raises(_state.StateError, match="distinct"):
        _state.review_start(root, "repo-wiki/reviewer", "producer-session")
    review = _state.review_start(root, "repo-wiki/reviewer", "review-session")
    assert review["ready_targets"] == [f"review:{leaf}"]

    packet = _state.task_start(root, f"review:{leaf}")
    wrong = {
        "subject": f"page:{leaf}",
        "subject_digest": "0" * 64,
        "verdict": "approved",
        "issues": [],
    }
    write(pathlib.Path(packet["artifact"]), json.dumps(wrong))
    rejected = _state.task_complete(root, f"review:{leaf}", packet["attempt"])
    assert not rejected["ok"]
    assert {item["code"] for item in rejected["issues"]} == {"review-digest-invalid"}

    wrong["subject_digest"] = packet["subject_digest"]
    write(pathlib.Path(packet["artifact"]), json.dumps(wrong))
    approved = _state.task_complete(root, f"review:{leaf}", packet["attempt"])

    assert approved["ok"] and approved["verdict"] == "approved"
    assert "page:architecture.md" in approved["state"]["ready_targets"]
    assert "page:data/src/branch.md" in approved["state"]["ready_targets"]


def test_review_page_reopen_keeps_all_ancestors_blocked(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    assert submit_plan(root, chain_plan())[1]["ok"]
    assert approve_plan_review(root)[1]["ok"]
    leaf = "data/src/leaf.md"
    assert submit(root, f"page:{leaf}", page_text())[1]["ok"]
    _state.review_start(root, "repo-wiki/reviewer", "review-session")
    packet = _state.task_start(root, f"review:{leaf}")
    report = {
        "subject": f"page:{leaf}",
        "subject_digest": packet["subject_digest"],
        "verdict": "changes_requested",
        "issues": [
            {
                "category": "unsupported-claim",
                "claim": "The selected behavior is implemented here.",
                "resolution": "Rewrite the claim with evidence.",
                "reopen_target": f"page:{leaf}",
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


def test_two_review_repair_rounds_pause_for_human_decision(tmp_path):
    root, _ = workspace(tmp_path)
    start(root)
    assert submit_plan(root, root_plan())[1]["ok"]
    assert approve_plan_review(root)[1]["ok"]
    page = "architecture.md"
    assert submit(root, f"page:{page}", page_text())[1]["ok"]

    first, changed = request_changes(root, f"review:{page}", f"page:{page}")
    assert first["review_mode"] == "initial"
    assert changed["review_round"] == 1 and not changed["paused"]
    assert submit(root, f"page:{page}", page_text())[1]["ok"]
    second, changed = request_changes(root, f"review:{page}", f"page:{page}")

    assert second["review_mode"] == "follow_up"
    assert changed["review_round"] == 2 and changed["paused"]
    assert changed["state"]["pause_reason"] == {
        "code": "review-convergence-limit",
        "subject": f"page:{page}",
        "rounds": 2,
    }
    resumed = _state.resume(root)
    assert resumed["status"] == "active"
    assert _state.read(root)["review_rounds"].get(f"page:{page}") is None


def test_plan_metadata_repair_preserves_page_body_and_reopens_only_review(tmp_path):
    root, _ = workspace(tmp_path)
    run = start(root)
    payload = root_plan()
    assert submit_plan(root, payload)[1]["ok"]
    assert approve_plan_review(root)[1]["ok"]
    page = "architecture.md"
    assert submit(root, f"page:{page}", page_text())[1]["ok"]
    before = _state.read(root)["targets"][f"page:{page}"]
    before_digest = before["output_digest"]
    before_input = before["last_attempt"]["input_digest"]

    _, changed = request_changes(root, f"review:{page}", "plan:workspace")
    assert changed["state"]["ready_targets"] == ["plan:workspace"]
    assert _state.read(root)["targets"][f"page:{page}"]["status"] == "complete"
    payload["pages"][0].update(
        {
            "title": "Revised architecture",
            "description": "Open before changing revised boundaries.",
            "tags": ["architecture", "revised"],
        }
    )
    assert submit_plan(root, payload)[1]["ok"]
    candidate = run / "candidate" / page
    text = candidate.read_text(encoding="utf-8")
    metadata_page = _state.read(root)["targets"][f"page:{page}"]

    assert "title: Revised architecture" in text
    assert "The selected behavior is implemented" in text
    assert metadata_page["status"] == "complete"
    assert metadata_page["attempts"] == 1
    assert metadata_page["output_digest"] != before_digest
    assert approve_plan_review(root)[1]["ok"]
    repaired = _state.read(root)["targets"][f"page:{page}"]
    assert repaired["last_attempt"]["input_digest"] != before_input
    assert f"review:{page}" in _state.status(root)["ready_targets"]


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
    assert approve_plan_review(root)[1]["ok"]
    assert submit(root, f"page:{src_leaf}", page_text())[1]["ok"]
    assert submit(root, f"page:{other_leaf}", page_text("other/app.py#L1-L2"))[1]["ok"]
    _state.review_start(root, "repo-wiki/reviewer", "review-session")
    approve_review(root, src_leaf)
    approve_review(root, other_leaf)
    other_brief_digest = _state.read(root)["targets"]["plan:other"]["output_digest"]

    write(source / "app.py", "def answer():\n    return 43\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "refresh"], check=True)
    refreshed = _state.refresh_source(root, "src")

    assert refreshed["ready_targets"] == ["plan:src"]
    statuses = target_statuses(root)
    assert statuses["plan:other"] == "complete"
    assert statuses[f"page:{other_leaf}"] == "complete"
    assert statuses[f"review:{other_leaf}"] == "complete"
    assert (
        _state.read(root)["targets"]["plan:other"]["output_digest"]
        == other_brief_digest
    )

    assert submit(root, "plan:src", json.dumps(source_brief("src", ["other"])))[1]["ok"]
    assert _state.status(root)["ready_targets"] == ["plan:workspace"]
    assert submit_plan(root, payload)[1]["ok"]
    assert approve_plan_review(root)[1]["ok"]
    statuses = target_statuses(root)
    assert statuses[f"page:{other_leaf}"] == "complete"
    assert statuses[f"review:{other_leaf}"] == "complete"


def test_candidate_tamper_is_detected_before_more_work(tmp_path):
    root, _ = workspace(tmp_path)
    run = start(root)
    assert submit_plan(root, root_plan())[1]["ok"]
    assert approve_plan_review(root)[1]["ok"]
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

    search = _state.task_search(root, "plan:workspace", "src", "return")
    assert search["results"][0]["locator"] == "src/app.py#L2"
    assert (
        "1|def answer"
        in _state.task_read(root, "plan:workspace", "src/app.py#L1-L2")["text"]
    )
    with pytest.raises(_state.StateError, match="end must not precede start"):
        _state.task_read(root, "plan:workspace", "src/app.py#L2-L1")
    with pytest.raises(_state.StateError, match="regular file inside the Pin"):
        _state.task_read(root, "plan:workspace", "src/escape")


def test_navigation_budget_is_cumulative_per_attempt(tmp_path, monkeypatch):
    root, _ = workspace(tmp_path)
    start(root)
    monkeypatch.setitem(
        _state.NAVIGATION_LIMITS, "plan", (1, 100_000, 0, 0, 1, 100_000)
    )
    packet = _state.task_start(root, "plan:workspace")

    first = _state.task_search(root, "plan:workspace", "src", "return")
    assert first["navigation"]["calls_used"] == 1
    with pytest.raises(_state.StateError, match="budget exhausted"):
        _state.task_outline(root, "plan:workspace", "src")
    active = _state.read(root)["targets"]["plan:workspace"]["active_attempt"]
    assert active["navigation"]["calls"] == 1
    assert active["navigation"]["bytes"] > 0
    assert (
        _state.task_packet(root, "plan:workspace", packet["attempt"])[
            "navigation_budget"
        ]["calls"]
        == 1
    )


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
    assert approve_plan_review(root)[1]["ok"]
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
