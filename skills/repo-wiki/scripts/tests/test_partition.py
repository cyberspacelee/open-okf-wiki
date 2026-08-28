"""Partition invariants: disjoint index records, single-writer namespaces,
gate-time conflict rejection, and actionable compose/review reopen."""

import json
import pathlib
import subprocess

import _index
import _state
import _workspace


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def git_source(path: pathlib.Path, files: dict[str, str]) -> pathlib.Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "qa@example.test"], check=True
    )
    subprocess.run(["git", "-C", str(path), "config", "user.name", "QA"], check=True)
    for rel, text in files.items():
        write(path / rel, text)
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "fixture"], check=True)
    return path


def complete(
    root: pathlib.Path, task_id: str, artifact: pathlib.Path, text: str
) -> None:
    _state.task_start(root, task_id)
    write(artifact, text)
    result = _state.task_complete(root, task_id)
    assert result["ok"], result


def start_and_reject(
    root: pathlib.Path, task_id: str, artifact: pathlib.Path, text: str
) -> set[str]:
    _state.task_start(root, task_id)
    write(artifact, text)
    result = _state.task_complete(root, task_id)
    assert not result["ok"], result
    return {item["code"] for item in result["issues"]}


def finish(root: pathlib.Path, artifact: pathlib.Path, task_id: str, text: str) -> None:
    write(artifact, text)
    result = _state.task_complete(root, task_id)
    assert result["ok"], result


# --- index partition -------------------------------------------------------


def test_index_records_are_disjoint_and_sum_to_file_count(tmp_path):
    files = [
        "README.md",
        "pom.xml",
        "app/pom.xml",
        "app/src/Main.java",
        "app/src/util/Strings.java",
        "dist/bundle.js",
    ]
    index = _index.build_index("src", tmp_path, files)
    records = {item["path"]: item for item in index["directories"]}
    assert sum(item["files"] for item in index["directories"]) == len(files)
    # direct semantics: the root owns only its own two files and entry points
    assert records["."]["files"] == 2
    assert records["."]["entry_points"] == ["README.md", "pom.xml"]
    assert records["."]["representative_files"] == ["README.md", "pom.xml"]
    # subtree metric is derived, not stored per field
    assert records["."]["subtree_files"] == len(files)
    assert records["app"]["entry_points"] == ["app/pom.xml"]
    assert records["app/src"]["files"] == 1


def test_index_budget_coarsens_into_parent_and_loses_no_file(tmp_path, monkeypatch):
    files = [f"pkg/mod{index:03d}/impl/File{index:03d}.java" for index in range(120)]
    files += ["pkg/pom.xml", "app.py"]
    monkeypatch.setattr(_index, "MAX_INDEX_BYTES", 4 * 1024)
    index = _index.build_index("src", tmp_path, files)
    assert index["truncated"]
    assert len(json.dumps(index, ensure_ascii=False, indent=2).encode()) + 1 <= 4 * 1024
    records = {item["path"]: item for item in index["directories"]}
    assert sum(item["files"] for item in index["directories"]) == len(files)
    # pruned module dirs collapsed into pkg, which accounts for them
    assert records["pkg"]["collapsed_dirs"] > 0
    assert records["pkg"]["subtree_files"] == 121
    # every surviving record has a full complement of direct fields
    for item in index["directories"]:
        assert {"files", "entry_points", "collapsed_dirs", "subtree_files"} <= set(item)


def test_index_prefers_entry_point_dirs_over_generated_bulk(tmp_path, monkeypatch):
    files = ["aop/Rule.java", "aop/pom.xml"]
    files += [f"dist/out{index:03d}.js" for index in range(200)]
    files += [f"src/f{index:03d}.py" for index in range(3)]
    monkeypatch.setattr(_index, "MAX_INDEX_BYTES", 2 * 1024)
    index = _index.build_index("src", tmp_path, files)
    kept = {item["path"] for item in index["directories"]}
    assert "aop" in kept  # entry-point dir survives generated bulk


def test_test_token_requires_word_boundary():
    assert _index.TEST_TOKEN.search("core/app_test.py")
    assert _index.TEST_TOKEN.search("tests/test_app.py")
    assert not _index.TEST_TOKEN.search("core/latest.js")
    assert not _index.TEST_TOKEN.search("core/contest.py")


def test_excerpt_clips_pathological_lines():
    content = ("x" * 5000 + "\nshort\n").encode()
    text = _index.excerpt(content, 1, 2)
    first = text.splitlines()[0]
    assert first.endswith(_index.EXCERPT_CLIP_MARK)
    assert len(first) < 600


# --- fixtures for gate tests -----------------------------------------------


def two_source_run(tmp_path) -> tuple[pathlib.Path, pathlib.Path]:
    root = tmp_path / "workspace"
    root.mkdir()
    for name in ("api", "web"):
        git_source(root / name, {"app.py": "VALUE = 1\n"})
    _workspace.init(root)
    for name in ("api", "web"):
        _workspace.add_git_link(root, str(root / name), name)
    _state.start_run(root, "repo-wiki/test", "writer")
    run = _state.run_dir(root, _state.read(root)["run_id"])
    for name in ("api", "web"):
        complete(
            root,
            f"triage:{name}",
            run / f"drafts/triage/{name}.json",
            json.dumps(
                {"source": name, "scopes": [{"paths": ["."], "tier": "deep"}]}
            ),
        )
    return root, run


def survey_json(name: str, finding_id: str) -> str:
    return json.dumps(
        {
            "source": name,
            "target": name,
            "findings": [
                {
                    "id": finding_id,
                    "claim": "entry point",
                    "evidence": [f"{name}/app.py#L1"],
                    "domain": "core",
                }
            ],
            "gaps": [],
        }
    )


def finish_surveys(root, run, ids=("api-entry", "web-entry")) -> None:
    for name, finding_id in zip(("api", "web"), ids):
        complete(
            root, f"survey:{name}", run / f"drafts/survey/{name}.json",
            survey_json(name, finding_id),
        )


def finish_connect(root, run) -> None:
    edge = {
        "id": "web-calls-api",
        "participants": [
            {"source": "web", "evidence": ["web/app.py#L1"]},
            {"source": "api", "evidence": ["api/app.py#L1"]},
        ],
        "contract": "HTTP boundary",
        "contract_evidence": [],
        "failure_propagation": "api errors surface in web",
    }
    complete(
        root, "connect:api", run / "drafts/connect/api.json",
        json.dumps({"source": "api", "connections": [edge], "gaps": []}),
    )
    complete(
        root, "connect:web", run / "drafts/connect/web.json",
        json.dumps({"source": "web", "connections": [], "gaps": []}),
    )


def plan_page(path: str, owner: str, page_type: str = "Architecture", **extra) -> dict:
    return {
        "path": path,
        "type": page_type,
        "owner": owner,
        "title": path,
        "description": "Open before changes.",
        "tags": [],
        "finding_ids": [],
        "connection_ids": [],
        **extra,
    }


# --- survey / connect id uniqueness ----------------------------------------


def test_survey_gate_rejects_finding_id_taken_by_sibling(tmp_path):
    root, run = two_source_run(tmp_path)
    complete(
        root, "survey:api", run / "drafts/survey/api.json",
        survey_json("api", "entry"),
    )
    codes = start_and_reject(
        root, "survey:web", run / "drafts/survey/web.json",
        survey_json("web", "entry"),
    )
    assert codes == {"finding-id-taken"}
    finish(
        root, run / "drafts/survey/web.json", "survey:web",
        survey_json("web", "web-entry"),
    )


def test_connect_gate_rejects_connection_id_taken_by_sibling(tmp_path):
    root, run = two_source_run(tmp_path)
    finish_surveys(root, run)

    def edge(participants: tuple[str, str]) -> dict:
        low, high = participants
        return {
            "id": "shared-id",
            "participants": [
                {"source": low, "evidence": [f"{low}/app.py#L1"]},
                {"source": high, "evidence": [f"{high}/app.py#L1"]},
            ],
            "contract": "HTTP boundary",
            "contract_evidence": [],
            "failure_propagation": "errors propagate",
        }

    complete(
        root, "connect:api", run / "drafts/connect/api.json",
        json.dumps({"source": "api", "connections": [edge(("api", "web"))], "gaps": []}),
    )
    # web owns no edges here, so reuse of the id must be caught by the id gate
    _state.task_start(root, "connect:web")
    write(
        run / "drafts/connect/web.json",
        json.dumps({"source": "web", "connections": [edge(("api", "web"))], "gaps": []}),
    )
    result = _state.task_complete(root, "connect:web")
    assert not result["ok"]
    assert "connection-id-taken" in {item["code"] for item in result["issues"]}


# --- plan partition --------------------------------------------------------


def to_plan_phase(tmp_path) -> tuple[pathlib.Path, pathlib.Path]:
    root, run = two_source_run(tmp_path)
    finish_surveys(root, run)
    finish_connect(root, run)
    return root, run


def workspace_plan(**overrides) -> dict:
    payload = {
        "source": None,
        "pages": [
            plan_page("overview.md", "workspace", "Overview"),
            plan_page(
                "architecture.md",
                "workspace",
                "Architecture",
                connection_ids=["web-calls-api"],
            ),
        ],
        "exclusions": [],
    }
    payload.update(overrides)
    return payload


def test_plan_gate_rejects_foreign_path_prefix(tmp_path):
    root, run = to_plan_phase(tmp_path)
    codes = start_and_reject(
        root, "plan:api", run / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "api",
                "pages": [plan_page("web/architecture.md", "api", finding_ids=["api-entry"])],
                "exclusions": [],
            }
        ),
    )
    assert "page-path-foreign" in codes


def test_plan_gate_rejects_foreign_finding_on_source_page(tmp_path):
    root, run = to_plan_phase(tmp_path)
    codes = start_and_reject(
        root, "plan:api", run / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "api",
                "pages": [
                    plan_page(
                        "api/architecture.md",
                        "api",
                        finding_ids=["api-entry", "web-entry"],
                    )
                ],
                "exclusions": [],
            }
        ),
    )
    assert "finding-foreign" in codes


def test_plan_gate_rejects_finding_claimed_by_completed_sibling(tmp_path):
    root, run = to_plan_phase(tmp_path)
    complete(
        root, "plan:api", run / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "api",
                "pages": [plan_page("api/architecture.md", "api", finding_ids=["api-entry"])],
                "exclusions": [],
            }
        ),
    )
    codes = start_and_reject(
        root, "plan:workspace", run / "drafts/plan/workspace.json",
        json.dumps(
            workspace_plan(
                pages=[
                    plan_page("overview.md", "workspace", "Overview", finding_ids=["api-entry"]),
                    plan_page(
                        "architecture.md",
                        "workspace",
                        "Architecture",
                        connection_ids=["web-calls-api"],
                    ),
                ]
            )
        ),
    )
    assert "finding-reassigned" in codes


def test_plan_gate_keeps_connection_assignment_in_workspace(tmp_path):
    root, run = to_plan_phase(tmp_path)
    codes = start_and_reject(
        root, "plan:api", run / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "api",
                "pages": [
                    plan_page(
                        "api/architecture.md",
                        "api",
                        finding_ids=["api-entry"],
                        connection_ids=["web-calls-api"],
                    )
                ],
                "exclusions": [],
            }
        ),
    )
    assert "connection-foreign" in codes


def test_workspace_plan_gate_requires_all_connections_assigned(tmp_path):
    root, run = to_plan_phase(tmp_path)
    codes = start_and_reject(
        root, "plan:workspace", run / "drafts/plan/workspace.json",
        json.dumps(
            workspace_plan(
                pages=[
                    plan_page("overview.md", "workspace", "Overview"),
                    plan_page("architecture.md", "workspace", "Architecture"),
                ]
            )
        ),
    )
    assert "connection-coverage-invalid" in codes


def test_compose_reopens_shard_leaving_findings_uncovered(tmp_path):
    root, run = to_plan_phase(tmp_path)
    # api shard omits its finding entirely — legal at the shard gate,
    # caught at compose with the api shard named and reopened.
    complete(
        root, "plan:api", run / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "api",
                "pages": [plan_page("api/architecture.md", "api")],
                "exclusions": [],
            }
        ),
    )
    complete(
        root, "plan:web", run / "drafts/plan/web.json",
        json.dumps(
            {
                "source": "web",
                "pages": [plan_page("web/architecture.md", "web", finding_ids=["web-entry"])],
                "exclusions": [],
            }
        ),
    )
    _state.task_start(root, "plan:workspace")
    write(run / "drafts/plan/workspace.json", json.dumps(workspace_plan()))
    result = _state.task_complete(root, "plan:workspace")
    assert not result["ok"]
    assert "finding-coverage-invalid" in {item["code"] for item in result["issues"]}
    state = _state.read(root)
    assert state["tasks"]["plan:api"]["status"] == "pending"
    assert state["tasks"]["plan:workspace"]["status"] == "complete"
    # repair the reopened shard; the run advances to write
    complete(
        root, "plan:api", run / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "api",
                "pages": [plan_page("api/architecture.md", "api", finding_ids=["api-entry"])],
                "exclusions": [],
            }
        ),
    )
    assert _state.status(root)["current_phase"] == "write"


# --- review reopen ---------------------------------------------------------


def concept(title: str, resource: str, link: str = "") -> str:
    return f"""---
type: Architecture
title: {title}
description: Open before changing this boundary.
coverage: full
sources:
  - id: code
    resource: {resource}
---

## Responsibility

The entry point defines this boundary.[^code] {link}

[^code]: Entry point
"""


def to_review_phase(tmp_path) -> tuple[pathlib.Path, pathlib.Path, dict]:
    root, run = to_plan_phase(tmp_path)
    complete(
        root, "plan:api", run / "drafts/plan/api.json",
        json.dumps(
            {
                "source": "api",
                "pages": [plan_page("api/architecture.md", "api", finding_ids=["api-entry"])],
                "exclusions": [],
            }
        ),
    )
    complete(
        root, "plan:web", run / "drafts/plan/web.json",
        json.dumps(
            {
                "source": "web",
                "pages": [plan_page("web/architecture.md", "web", finding_ids=["web-entry"])],
                "exclusions": [],
            }
        ),
    )
    complete(
        root, "plan:workspace", run / "drafts/plan/workspace.json",
        json.dumps(workspace_plan()),
    )
    pages = {
        "overview.md": concept("Overview", "api/app.py#L1", "[a](/architecture.md)"),
        "architecture.md": concept(
            "Architecture",
            "api/app.py#L1",
            "[api](/api/architecture.md) [web](/web/architecture.md)",
        ),
        "api/architecture.md": concept("API", "api/app.py#L1", "[root](/architecture.md)"),
        "web/architecture.md": concept("Web", "web/app.py#L1", "[root](/architecture.md)"),
    }
    for rel, text in pages.items():
        complete(root, f"write:{rel}", run / "candidate" / rel, text)
    packet = _state.review_start(root, "repo-wiki/reviewer", "reviewer-2")
    return root, run, packet


def test_review_gate_rejects_unknown_plan_shard_target(tmp_path):
    root, run, packet = to_review_phase(tmp_path)
    _state.task_start(root, "review:workspace")
    write(
        run / "drafts/review/workspace.json",
        json.dumps(
            {
                "batch": "workspace",
                "candidate_digest": packet["candidate_digest"],
                "verdict": "changes_requested",
                "issues": [
                    {
                        "category": "routing",
                        "target": "nonexistent",
                        "claim": "bad routing",
                        "resolution": "restructure",
                        "reopen": "plan",
                    }
                ],
            }
        ),
    )
    result = _state.task_complete(root, "review:workspace")
    assert not result["ok"]
    assert "review-target-invalid" in {item["code"] for item in result["issues"]}


def test_mixed_review_reopens_both_plan_shard_and_pages(tmp_path):
    root, run, packet = to_review_phase(tmp_path)
    _state.task_start(root, "review:workspace")
    write(
        run / "drafts/review/workspace.json",
        json.dumps(
            {
                "batch": "workspace",
                "candidate_digest": packet["candidate_digest"],
                "verdict": "changes_requested",
                "issues": [
                    {
                        "category": "routing",
                        "target": "api",
                        "claim": "api pages are misrouted",
                        "resolution": "replan",
                        "reopen": "plan",
                    },
                    {
                        "category": "unsupported-claim",
                        "target": "overview.md",
                        "claim": "unsupported claim",
                        "resolution": "add evidence",
                        "reopen": "page",
                    },
                ],
            }
        ),
    )
    result = _state.task_complete(root, "review:workspace")
    assert result["ok"] and result["verdict"] == "changes_requested"
    state = _state.read(root)
    # plan issue reopened the api shard and removed its page task
    assert state["tasks"]["plan:api"]["status"] == "pending"
    assert "write:api/architecture.md" not in state["tasks"]
    # the page issue was NOT dropped: overview reopened too
    assert state["tasks"]["write:overview.md"]["status"] == "pending"


# --- previous-run reuse ----------------------------------------------------


def test_previous_state_with_other_version_is_not_reused(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(root / "src", {"app.py": "VALUE = 1\n"})
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    raw = json.loads(
        (_state.run_dir(root, state["run_id"]) / "state.json").read_text()
    )
    raw["version"] = 1
    write(
        _state.run_dir(root, state["run_id"]) / "state.json",
        json.dumps(raw),
    )
    fake = {"previous_run_id": state["run_id"]}
    assert _state._previous_state(root, fake) is None
