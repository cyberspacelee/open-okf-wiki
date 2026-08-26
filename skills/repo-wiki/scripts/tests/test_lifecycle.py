import json
import pathlib
import shutil
import subprocess

import _publish
import _state
import _validate
import _workspace
import pytest
from _models import PagePlanEntry


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def git_source(path: pathlib.Path) -> pathlib.Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "qa@example.test"], check=True
    )
    subprocess.run(["git", "-C", str(path), "config", "user.name", "QA"], check=True)
    write(path / "app.py", "def answer():\n    return 42\n")
    subprocess.run(["git", "-C", str(path), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "initial"], check=True)
    return path


def complete(
    root: pathlib.Path, task_id: str, artifact: pathlib.Path, text: str
) -> None:
    _state.task_start(root, task_id)
    write(artifact, text)
    result = _state.task_complete(root, task_id)
    assert result["ok"], result


def concept(title: str, commit: str, link: str = "") -> str:
    return f"""---
type: Overview
title: {title}
description: Open this page before changing the answer flow.
coverage: full
sources:
  - id: code
    resource: okf-source://src/{commit}/app.py#L1-L2
---

## Responsibility

The answer is provided by the source entry point.[^code] {link}

[^code]: Answer entry point
"""


def test_full_lifecycle_publish_export_verify_and_incremental_reuse(tmp_path):
    source = git_source(tmp_path / "source")
    root = tmp_path / "workspace"
    root.mkdir()
    _workspace.init(root, "en", 30)
    _workspace.add_git_source(root, str(source), "src")

    _state.start_run(root, "repo-wiki/test", "writer-1")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    snapshot = state["snapshots"][0]
    commit = snapshot["commit"]
    inspection = json.dumps(
        {
            "source": "src",
            "survey_targets": [
                {"id": "src-core", "source": "src", "scope": ["app.py"]}
            ],
        }
    )
    complete(
        root,
        "inspect:src",
        run / "drafts/inspect/src.json",
        inspection,
    )
    write(run / "drafts/inspect/src.json", inspection + "\n")
    with pytest.raises(_state.StateError, match="completed artifact changed"):
        _state.task_start(root, "survey:src-core")
    write(run / "drafts/inspect/src.json", inspection)
    complete(
        root,
        "survey:src-core",
        run / "drafts/survey/src-core.json",
        json.dumps(
            {
                "source": "src",
                "target": "src-core",
                "snapshot": snapshot["content_hash"],
                "findings": [
                    {
                        "id": "answer",
                        "claim": "answer entry point",
                        "evidence": ["src/app.py#L1-L2"],
                        "domain": "core",
                    }
                ],
                "gaps": [],
                "remaining": [],
            }
        ),
    )
    valid_plan = {
        "pages": [
            {
                "path": "overview.md",
                "type": "Overview",
                "owner": "workspace",
                "title": "Overview",
                "description": "Open first.",
                "tags": ["routing"],
                "finding_ids": ["answer"],
            },
            {
                "path": "architecture.md",
                "type": "Architecture",
                "owner": "workspace",
                "title": "Architecture",
                "description": "Open before structural changes.",
                "tags": ["architecture"],
            },
        ],
        "exclusions": [],
    }
    invalid_plan = json.loads(json.dumps(valid_plan))
    invalid_plan["pages"][1]["finding_ids"] = ["answer"]
    _state.task_start(root, "plan:wiki")
    write(run / "drafts/plan.json", json.dumps(invalid_plan))
    assert not _state.task_complete(root, "plan:wiki")["ok"]
    write(run / "drafts/plan.json", json.dumps(valid_plan))
    assert _state.task_complete(root, "plan:wiki")["ok"]
    complete(
        root,
        "write:overview.md",
        run / "candidate/overview.md",
        concept("ignored", commit, "[Architecture](/architecture.md)"),
    )
    complete(
        root,
        "write:architecture.md",
        run / "candidate/architecture.md",
        concept("ignored", commit, "[Overview](/overview.md)"),
    )
    complete(
        root,
        "derive:proposals",
        run / "proposals/agents-block-src.md",
        "<!-- okf-wiki:begin run=test -->\n- Read the Wiki before changes.\n<!-- okf-wiki:end -->\n",
    )
    packet = _state.review_start(root, "repo-wiki/reviewer", "reviewer-2")
    report = run / "review.json"
    write(
        report,
        json.dumps(
            {
                "candidate_digest": packet["candidate_digest"],
                "verdict": "approved",
                "issues": [],
            }
        ),
    )
    _state.review_submit(root, report)

    published = _publish.publish(root)
    generation = pathlib.Path(published["path"])
    assert _validate.validate_bundle(generation) == []
    assert (
        (generation / "index.md").read_text().startswith('---\nokf_version: "0.2"\n---')
    )
    assert (generation / "log.md").is_file()
    tampered = tmp_path / "tampered"
    shutil.copytree(generation, tampered)
    write(
        tampered / "overview.md", (tampered / "overview.md").read_text() + "changed\n"
    )
    assert any(
        item["code"] == "manifest-digest"
        for item in _validate.validate_publication(root, tampered)
    )
    exported = _publish.export(root, root / "wiki")
    assert exported["generation"] == published["generation"]
    verified = _publish.verify(root, "human:qa@example.test", ["overview.md"])
    assert verified["generation"] != published["generation"]

    second = _state.start_run(root, "repo-wiki/test", "writer-3")
    assert second["current_phase"] == "derive"
    reused = [task for task in second["tasks"].values() if task.get("reused_from")]
    assert {task["phase"] for task in reused} == {"inspect", "survey", "plan", "write"}


def test_dirty_source_and_windows_incompatible_paths_are_rejected(tmp_path):
    source = git_source(tmp_path / "source")
    root = tmp_path / "workspace"
    root.mkdir()
    _workspace.init(root)
    _workspace.add_git_source(root, str(source), "src")
    write(source / "dirty.txt", "not committed")
    with pytest.raises(_workspace.WorkspaceError, match="uncommitted"):
        _state.start_run(root, "repo-wiki/test", "writer")
    with pytest.raises(_workspace.WorkspaceError, match="Windows reserved"):
        _workspace._portable_path("docs/CON.md", {})


def test_index_log_and_root_relative_links_conform(tmp_path):
    bundle = tmp_path / "bundle"
    write(
        bundle / "one.md",
        "---\ntype: Note\ntitle: One\nstatus: stable\nstale_after: 2099-01-01\n"
        "generated: {by: repo-wiki/test, at: 2026-01-01T00:00:00Z}\n"
        "verified: [{by: repo-wiki/reviewer, at: 2026-01-01T00:00:00Z}]\n---\nBody\n",
    )
    _publish.generate_indexes(bundle, "en")
    _publish.generate_log(bundle, None, "run-1")
    assert not [
        item
        for item in _validate.validate_bundle(bundle)
        if item["severity"] == "error"
    ]
    root = (bundle / "index.md").read_text()
    assert "type: Index" not in root and "# Concepts" in root and "##" not in root


def test_publication_lock_is_process_scoped_not_stale_file_scoped(tmp_path):
    first = _publish._lock(tmp_path)
    with pytest.raises(_publish.PublishError, match="locked"):
        _publish._lock(tmp_path)
    _publish._unlock(tmp_path, first)
    assert (tmp_path / ".okf-wiki/publication/publish.lock").is_file()
    second = _publish._lock(tmp_path)
    _publish._unlock(tmp_path, second)


def test_corrupt_pointers_and_windows_reserved_page_are_rejected(tmp_path):
    write(
        tmp_path / ".okf-wiki/publication/current.json",
        json.dumps({"version": 3, "generation": "../../outside", "run_id": "bad"}),
    )
    with pytest.raises(_publish.PublishError, match="invalid current"):
        _publish.current(tmp_path)
    write(
        tmp_path / ".okf-wiki/current-run.json",
        json.dumps({"version": 3, "run_id": "../../outside"}),
    )
    with pytest.raises(_state.StateError, match="corrupt current-run"):
        _state.status(tmp_path)
    with pytest.raises(ValueError, match="Windows"):
        PagePlanEntry(
            path="con.md",
            type="Domain",
            owner="workspace",
            title="Bad",
            description="Bad Windows path",
        )
