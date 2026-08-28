import concurrent.futures
import json
import os
import pathlib
import shutil
import subprocess
import threading
import time

import _db
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


def complete_triage(root: pathlib.Path) -> pathlib.Path:
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    for revision in state["revisions"]:
        source = revision["name"]
        slug = source.lower()
        complete(
            root,
            f"triage:{slug}",
            run / f"drafts/triage/{slug}.json",
            json.dumps(
                {
                    "source": source,
                    "scopes": [{"paths": ["."], "tier": "deep"}],
                }
            ),
        )
    return run


def concept(title: str, link: str = "") -> str:
    return f"""---
type: Overview
title: {title}
description: Open this page before changing the answer flow.
coverage: full
sources:
  - id: code
    resource: src/app.py#L1-L2
---

## Responsibility

The answer is provided by the source entry point.[^code] {link}

[^code]: Answer entry point
"""


def test_full_lifecycle_publish_export_verify_and_incremental_reuse(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "source")
    _workspace.init(root, "en", 30)
    _workspace.add_git_link(root, str(source), "src")

    _state.start_run(root, "repo-wiki/test", "writer-1")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    complete_triage(root)
    survey = json.dumps(
        {
            "source": "src",
            "target": "src",
            "findings": [
                {
                    "id": "answer",
                    "claim": "answer entry point",
                    "evidence": ["src/app.py#L1-L2"],
                    "domain": "core",
                }
            ],
            "gaps": [],
        }
    )
    complete(root, "survey:src", run / "drafts/survey/src.json", survey)
    write(run / "drafts/survey/src.json", survey + "\n")
    with pytest.raises(_state.StateError, match="completed artifact changed"):
        _state.task_start(root, "plan:src")
    write(run / "drafts/survey/src.json", survey)
    complete(
        root,
        "plan:src",
        run / "drafts/plan/src.json",
        json.dumps({"source": "src", "pages": [], "exclusions": []}),
    )
    valid_plan = {
        "source": None,
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
    _state.task_start(root, "plan:workspace")
    write(run / "drafts/plan/workspace.json", json.dumps(invalid_plan))
    rejected = _state.task_complete(root, "plan:workspace")
    assert not rejected["ok"]
    assert "finding-reassigned" in {item["code"] for item in rejected["issues"]}
    write(run / "drafts/plan/workspace.json", json.dumps(valid_plan))
    assert _state.task_complete(root, "plan:workspace")["ok"]
    complete(
        root,
        "write:overview.md",
        run / "candidate/overview.md",
        concept("ignored", "[Architecture](/architecture.md)"),
    )
    complete(
        root,
        "write:architecture.md",
        run / "candidate/architecture.md",
        concept("ignored", "[Overview](/overview.md)"),
    )
    packet = _state.review_start(root, "repo-wiki/reviewer", "reviewer-2")
    assert pathlib.Path(packet["reference"]).name == "review.md"
    assert pathlib.Path(packet["candidate"]) == run / "candidate"
    pin = root / ".okf-wiki" / "pins" / packet["run_id"] / "src"
    assert packet["sources"] == {"src": str(pin)}
    complete(
        root,
        "review:workspace",
        run / "drafts/review/workspace.json",
        json.dumps(
            {
                "batch": "workspace",
                "candidate_digest": packet["candidate_digest"],
                "verdict": "approved",
                "issues": [],
            }
        ),
    )

    published = _publish.publish(root)
    generation = pathlib.Path(published["path"])
    assert _validate.validate_bundle(generation) == []
    assert (
        (generation / "index.md").read_text().startswith('---\nokf_version: "0.2"\n---')
    )
    assert (generation / "log.md").is_file()
    tampered = tmp_path / "tampered"
    shutil.copytree(generation, tampered)
    manifest_path = tampered / ".okf-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["catalogs"] = [{"content_hash": 7}]
    write(manifest_path, json.dumps(manifest))
    write(
        tampered / "overview.md", (tampered / "overview.md").read_text() + "changed\n"
    )
    tamper_codes = {
        item.code for item in _validate.validate_publication(root, tampered)
    }
    assert {"manifest-digest", "catalog-invalid"} <= tamper_codes
    exported = _publish.export(root, root / "wiki")
    assert exported["generation"] == published["generation"]
    verified = _publish.verify(root, "human:qa@example.test", ["overview.md"])
    assert verified["generation"] != published["generation"]

    second = _state.start_run(root, "repo-wiki/test", "writer-3")
    assert second["status"] == "awaiting_review"
    second_state = _state.read(root)
    second_run = _state.run_dir(root, second_state["run_id"])
    cache = json.loads((second_run / "drafts/evidence/src.json").read_text())
    assert cache["pin"] == second_state["revisions"][0]["commit"]


def test_dirty_source_and_windows_incompatible_paths_are_rejected(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "source")
    _workspace.init(root)
    registered = _workspace.add_git_link(root, str(source), "src")
    write(source / "路径.py", "VALUE = 1\n")
    subprocess.run(["git", "-C", str(source), "add", "路径.py"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "unicode"], check=True)
    assert _workspace.capture_git_revision(root, registered)["commit"]
    write(source / "dirty.txt", "not committed")
    _state.start_run(root, "repo-wiki/test", "writer")


def test_workspace_init_requires_explicit_git_sources(tmp_path):
    root = git_source(tmp_path / "workspace")
    linked = git_source(root / "linked")
    outside = git_source(tmp_path / "outside")

    workspace = _workspace.init(root)
    assert workspace.sources == {}

    link = _workspace.add_git_link(root, str(linked), "LinkedAPI")
    clone = _workspace.add_git_clone(root, linked.as_uri(), "RemoteWEB", "HEAD")
    assert link.path == pathlib.Path(os.path.abspath(root / "LinkedAPI"))
    assert clone.origin == linked.as_uri() and clone.ref == "HEAD"
    assert clone.path == pathlib.Path(os.path.abspath(root / "RemoteWEB"))
    with pytest.raises(_workspace.WorkspaceError, match="already exists"):
        _workspace.add_git_link(root, str(linked), "linkedapi")
    with pytest.raises(_workspace.WorkspaceError, match="reserved on Windows"):
        _workspace.add_git_link(root, str(linked), "CON")
    mounted = _workspace.add_git_link(root, str(outside), "Outside")
    mount_point = root / "Outside"
    assert mounted.path == mount_point
    assert (mount_point / "app.py").is_file()
    assert _workspace.capture_git_revision(root, mounted)["commit"]
    assert (
        _workspace._safe_origin("https://user:secret@example.test/repo.git")
        == "https://example.test/repo.git"
    )


def test_run_uses_workspace_git_revision_without_snapshot(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "SourceA")
    _workspace.init(root)

    registered = _workspace.add_git_link(root, str(source), "SourceA")
    assert registered.path == source.resolve()
    config = json.loads((root / "workspace.json").read_text())
    assert config["sources"][0]["path"] == "SourceA"

    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    assert state["revisions"] == [
        {
            "name": "SourceA",
            "commit": subprocess.run(
                ["git", "-C", str(source), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip(),
            "origin": "SourceA",
            "kind": "git",
        }
    ]
    assert "snapshots" not in state
    assert not (root / ".okf-wiki/snapshots").exists()


def test_status_is_compact_and_source_drift_blocks_task_start(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "SourceA")
    _workspace.init(root)
    _workspace.add_git_link(root, str(source), "SourceA")
    _state.start_run(root, "repo-wiki/test", "writer")

    status = _state.status(root)
    assert set(status) == {
        "run_id",
        "status",
        "current_phase",
        "tasks",
        "next_actions",
        "run_dir",
    }
    assert status["tasks"] == [{"id": "triage:sourcea", "status": "pending"}]
    complete_triage(root)

    write(source / "app.py", "def answer():\n    return 43\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "change"], check=True)
    packet = _state.task_start(root, "survey:sourcea")
    assert pathlib.Path(packet["sources"]["SourceA"]).is_dir()


def test_task_start_returns_path_only_worker_dispatch(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "SourceA")
    _workspace.init(root)
    _workspace.add_git_link(root, str(source), "SourceA")
    _state.start_run(root, "repo-wiki/test", "writer")
    complete_triage(root)

    packet = _state.task_start(root, "survey:sourcea")
    assert set(packet) == {
        "run_id",
        "task",
        "language",
        "reference",
        "artifact",
        "sources",
        "inputs",
        "ls_command",
        "complete_command",
        "workdir",
    }
    assert packet["language"] == "en"
    assert packet["task"] == {
        "id": "survey:sourcea",
        "phase": "survey",
        "spec": {
            "source": "SourceA",
            "scope": ["."],
            "tier": "deep",
            "orientation": None,
            "themes": [],
        },
    }
    assert pathlib.Path(packet["reference"]).name == "survey.md"
    assert pathlib.Path(packet["artifact"]).name == "sourcea.json"
    pin = root / ".okf-wiki" / "pins" / packet["run_id"] / "SourceA"
    assert packet["sources"] == {"SourceA": str(pin)}
    assert packet["inputs"] == []
    assert packet["ls_command"].endswith("task ls survey:sourcea")
    assert packet["complete_command"].endswith("task complete survey:sourcea --json")
    assert packet["workdir"] == str(root)


def test_parallel_task_starts_do_not_lose_state(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    for name in ("SourceA", "SourceB"):
        git_source(root / name)
    _workspace.init(root)
    for name in ("SourceA", "SourceB"):
        _workspace.add_git_link(root, str(root / name), name)
    _state.start_run(root, "repo-wiki/test", "writer")
    complete_triage(root)

    original = _state.atomic_json
    write_count = 0
    guard = threading.Lock()

    def delayed_write(path, data):
        nonlocal write_count
        in_progress = sum(
            task["status"] == "in_progress" for task in data.get("tasks", {}).values()
        )
        if path.name == "state.json" and in_progress == 1:
            with guard:
                write_count += 1
                first = write_count == 1
            if first:
                time.sleep(0.1)
        original(path, data)

    monkeypatch.setattr(_state, "atomic_json", delayed_write)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(_state.task_start, root, f"survey:{name.lower()}")
            for name in ("SourceA", "SourceB")
        ]
        for future in futures:
            future.result()

    state = _state.read(root)
    assert {
        task_id: state["tasks"][task_id]["status"]
        for task_id in ("survey:sourcea", "survey:sourceb")
    } == {"survey:sourcea": "in_progress", "survey:sourceb": "in_progress"}


def test_survey_artifact_byte_budget_is_enforced(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "SourceA")
    _workspace.init(root)
    _workspace.add_git_link(root, str(source), "SourceA")
    _state.start_run(root, "repo-wiki/test", "writer")
    complete_triage(root)
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    _state.task_start(root, "survey:sourcea")
    artifact = run / "drafts/survey/sourcea.json"
    write(
        artifact,
        json.dumps(
            {
                "source": "SourceA",
                "target": "sourcea",
                "findings": [],
                "gaps": [],
            }
        )
        + " " * (64 * 1024),
    )
    result = _state.task_complete(root, "survey:sourcea")
    assert not result["ok"]
    assert {item["code"] for item in result["issues"]} == {"survey-too-large"}


def test_files_source_and_refresh_keep_the_run_alive(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = git_source(root / "SourceA")
    contracts = tmp_path / "contracts"
    contracts.mkdir()
    write(contracts / "openapi.yaml", "openapi: 3.0.0\n")
    _workspace.init(root)
    _workspace.add_git_link(root, str(source), "SourceA")
    _workspace.add_files_source(root, str(contracts), "contracts")
    first = _state.start_run(root, "repo-wiki/test", "writer")
    complete_triage(root)
    write(source / "app.py", "def answer():\n    return 43\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "move"], check=True)
    _state.task_start(root, "survey:sourcea")
    refreshed = _state.refresh_source(root, "SourceA")
    assert refreshed["status"] == "active"
    assert {item["id"]: item["status"] for item in refreshed["tasks"]} == {
        "triage:sourcea": "pending",
        "triage:contracts": "complete",
    }
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    complete(
        root,
        "triage:sourcea",
        run / "drafts/triage/sourcea.json",
        json.dumps(
            {
                "source": "SourceA",
                "scopes": [{"paths": ["."], "tier": "deep"}],
            }
        ),
    )
    assert {item["id"] for item in _state.status(root)["tasks"]} == {
        "survey:sourcea",
        "survey:contracts",
    }
    _state.task_start(root, "survey:sourcea")


def test_opengauss_catalog_is_slim_in_state_and_sharded_for_workers(
    tmp_path, monkeypatch
):
    root = tmp_path / "workspace"
    root.mkdir()
    _workspace.init(root)
    _workspace.add_opengauss_source(
        root, "appdb", "DB_URL", "public", ["orders"]
    )
    monkeypatch.setenv("DB_URL", "postgresql://secret:token@db.example:5432/app")

    def fake_tables(url, schema):
        return [{"name": "orders", "comment": "customer orders"}]

    def fake_describe(url, table, schema):
        return {
            "name": table,
            "comment": "customer orders",
            "columns": [
                {
                    "name": "id",
                    "type": "integer",
                    "nullable": False,
                    "default": None,
                    "comment": "primary key",
                }
            ],
            "primary_key": ["id"],
            "foreign_keys": [],
        }

    real_capture = _db.capture_catalog

    def capture(root, source, **kwargs):
        kwargs.setdefault("tables", fake_tables)
        kwargs.setdefault("describe", fake_describe)
        return real_capture(root, source, **kwargs)

    monkeypatch.setattr(_db, "capture_catalog", capture)

    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    record = state["catalogs"][0]
    assert "columns" not in record["tables"][0]
    assert "comment" not in record["tables"][0]
    raw_state = (root / ".okf-wiki" / "runs" / state["run_id"] / "state.json").read_text()
    assert "primary key" not in raw_state
    assert "customer orders" not in raw_state

    slug = record["tables"][0]["page_slug"]
    table_path = f"data/appdb/{slug}.md"
    plan_packet = _state.task_start(root, "plan:appdb")
    assert plan_packet["catalogs"] == [
        str(_db.catalog_index_path(root, record["content_hash"]))
    ]
    index = json.loads(pathlib.Path(plan_packet["catalogs"][0]).read_text())
    assert index["tables"][0]["comment"] == "customer orders"
    assert "columns" not in index["tables"][0]

    run = _state.run_dir(root, state["run_id"])
    write(
        run / "drafts/plan/appdb.json",
        json.dumps(
            {
                "source": "appdb",
                "pages": [
                    {
                        "path": table_path,
                        "type": "Table",
                        "owner": "appdb",
                        "title": "orders",
                        "description": "Open before changing order rows.",
                        "tags": ["data-model", "table"],
                    }
                ],
                "exclusions": [],
            }
        ),
    )
    assert _state.task_complete(root, "plan:appdb")["ok"]
    complete(
        root,
        "plan:workspace",
        run / "drafts/plan/workspace.json",
        json.dumps(
            {
                "source": None,
                "pages": [
                    {
                        "path": "overview.md",
                        "type": "Overview",
                        "owner": "workspace",
                        "title": "Overview",
                        "description": "Open first.",
                        "tags": ["overview"],
                    },
                    {
                        "path": "architecture.md",
                        "type": "Architecture",
                        "owner": "workspace",
                        "title": "Architecture",
                        "description": "Open before structural changes.",
                        "tags": ["architecture"],
                    },
                    {
                        "path": "data-model.md",
                        "type": "DataModel",
                        "owner": "workspace",
                        "title": "Data model",
                        "description": "Open to route selected tables.",
                        "tags": ["data-model"],
                    },
                ],
                "exclusions": [],
            }
        ),
    )

    write_packet = _state.task_start(root, f"write:{table_path}")
    assert write_packet["catalogs"] == [
        str(_db.catalog_table_path(root, record["content_hash"], slug))
    ]
    shard = json.loads(pathlib.Path(write_packet["catalogs"][0]).read_text())
    assert shard["comment"] == "customer orders"
    assert shard["columns"][0]["comment"] == "primary key"
    assert write_packet["task"]["spec"]["catalog_hash"] == record["content_hash"]

    model_packet = _state.task_start(root, "write:data-model.md")
    assert model_packet["catalogs"] == [
        str(_db.catalog_index_path(root, record["content_hash"]))
    ]

    resource = record["tables"][0]["resource"]
    write(
        run / "candidate" / table_path,
        f"""---
type: Table
title: orders
description: Open before changing order rows.
coverage: full
resource: {resource}
tags: [data-model, table]
sources: []
---

customer orders

# Schema

| Column | Type | Nullable | Default | Comment |
| --- | --- | --- | --- | --- |
| id | integer | no |  | primary key |

## Keys and relationships

Primary key: id.

## Usage

No application owner recorded.
""",
    )
    assert _state.task_complete(root, f"write:{table_path}")["ok"]
    write(
        run / "candidate/data-model.md",
        f"""---
type: DataModel
title: Data model
description: Open to route selected tables.
coverage: full
tags: [data-model]
sources: []
---

## Ownership and boundaries

Selected OpenGauss tables.

## Selected tables

[orders](/{table_path})

## Relationships

Primary key id on orders.
""",
    )
    assert _state.task_complete(root, "write:data-model.md")["ok"]
    complete(
        root,
        "write:overview.md",
        run / "candidate/overview.md",
        """---
type: Overview
title: Overview
description: Open first.
coverage: full
sources: []
---

## Responsibility

Route through [Architecture](/architecture.md) and [Data model](/data-model.md).
""",
    )
    complete(
        root,
        "write:architecture.md",
        run / "candidate/architecture.md",
        """---
type: Architecture
title: Architecture
description: Open before structural changes.
coverage: full
sources: []
---

## Responsibility

See [Overview](/overview.md) and [Data model](/data-model.md).
""",
    )
    packet = _state.review_start(root, "repo-wiki/reviewer", "reviewer-2")
    for batch in packet["batches"]:
        complete(
            root,
            batch["id"],
            run / "drafts" / "review" / f"{batch['id'].split(':', 1)[1]}.json",
            json.dumps(
                {
                    "batch": batch["owner"],
                    "candidate_digest": packet["candidate_digest"],
                    "verdict": "approved",
                    "issues": [],
                }
            ),
        )
    published = _publish.publish(root)
    generation = pathlib.Path(published["path"])
    assert _validate.validate_publication(root, generation) == []
    manifest = json.loads((generation / ".okf-manifest.json").read_text())
    assert "columns" not in manifest["catalogs"][0]["tables"][0]


def test_git_revision_evidence_does_not_depend_on_current_worktree(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source_path = git_source(root / "SourceA")
    _workspace.init(root)
    source = _workspace.add_git_link(root, str(source_path), "SourceA")
    revision = _workspace.capture_git_revision(root, source)

    subprocess.run(["git", "-C", str(source_path), "rm", "-q", "app.py"], check=True)
    subprocess.run(["git", "-C", str(source_path), "commit", "-qm", "remove"], check=True)

    assert _workspace.git_blob(source, revision["commit"], "app.py") == (
        b"def answer():\n    return 42\n"
    )


def test_index_log_and_root_relative_links_conform(tmp_path):
    bundle = tmp_path / "bundle"
    write(
        bundle / "one.md",
        "---\ntype: Note\ntitle: One\nstatus: stable\nstale_after: 2099-01-01\n"
        "generated: {by: repo-wiki/test, at: 2026-01-01T00:00:00Z}\n"
        "verified: [{by: repo-wiki/reviewer, at: 2026-01-01T00:00:00Z}]\n---\nBody\n",
    )
    indexes = _publish.render_indexes(bundle, "en")
    log_files = _publish.render_log(bundle, None, "run-1")
    for relative, content in {**indexes, **log_files}.items():
        write(bundle / relative, content)
    assert not [
        item
        for item in _validate.validate_bundle(bundle)
        if item.severity == "error"
    ]
    root = indexes["index.md"]
    assert "type: Index" not in root and "# Concepts" in root and "##" not in root


def test_publication_lock_is_process_scoped_not_stale_file_scoped(tmp_path):
    with _publish.publication_lock(tmp_path):
        with pytest.raises(_publish.PublishError, match="locked"):
            with _publish.publication_lock(tmp_path):
                pass
        assert (tmp_path / ".okf-wiki/publication/publish.lock").is_file()
    assert (tmp_path / ".okf-wiki/publication/publish.lock").is_file()
    with _publish.publication_lock(tmp_path):
        pass


def test_corrupt_pointers_and_windows_reserved_page_are_rejected(tmp_path):
    write(
        tmp_path / ".okf-wiki/publication/current.json",
        json.dumps({"version": 99, "generation": "../../outside", "run_id": "bad"}),
    )
    with pytest.raises(_publish.PublishError, match="invalid current"):
        _publish.current(tmp_path)
    write(
        tmp_path / ".okf-wiki/current-run.json",
        json.dumps({"version": 99, "run_id": "../../outside"}),
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
