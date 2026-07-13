import json
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

from okf_wiki.gateway_profiles import GatewayApplication, GatewayProfileRegistry
from okf_wiki.workspace import WorkspaceApplication


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def source_repository(root: Path) -> tuple[Path, str]:
    repository = root / "source"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "fixture@example.test")
    git(repository, "config", "user.name", "Fixture")
    (repository / "README.md").write_text(
        "# Catalog\n\nSecurity credential handling MUST remain deterministic.\n"
    )
    git(repository, "add", "README.md")
    git(repository, "commit", "-m", "fixture")
    return repository, git(repository, "rev-parse", "HEAD")


def wait_for_state(application: WorkspaceApplication, run_id: str, expected: str) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = application.run_status(run_id)
        if status["state"] == expected:
            return status
        time.sleep(0.05)
    raise AssertionError(f"Run {run_id} did not reach {expected}: {status}")


def configure_gateway(workspace: Path, config_root: Path) -> dict:
    registry = GatewayProfileRegistry(config_root)
    registry.save(
        {
            "id": "enterprise",
            "name": "Enterprise Gateway",
            "gateway_id": "corp-openai",
            "base_url": "http://127.0.0.1:8765/v1",
            "headers": {"X-Tenant": "private-tenant-value"},
        },
        credential="never-persist-this-secret",
    )
    payload = json.loads(registry.path.read_text())
    payload["profiles"][0]["models"] = ["model-a", "model-b"]
    payload["profiles"][0]["capabilities"] = {
        model: {
            "authentication": True,
            "concurrency": True,
            "error_mapping": True,
            "model_discovery": True,
            "structured_output": True,
            "tool_calling": True,
            "usage_reporting": True,
        }
        for model in ("model-a", "model-b")
    }
    registry.path.write_text(json.dumps(payload))
    GatewayApplication(config_root).select_workspace(
        workspace,
        profile_id="enterprise",
        default_model="model-a",
        role_overrides={"verifier": "model-b"},
        concurrency=2,
        budgets={"total_tokens": 5000},
    )
    return payload["profiles"][0]


def semantic_workspace(tmp_path: Path) -> tuple[WorkspaceApplication, Path, dict]:
    repository, _revision = source_repository(tmp_path)
    workspace = tmp_path / "workspace"
    config_root = tmp_path / "machine"
    application = WorkspaceApplication(workspace, config_root=config_root)
    application.initialize("catalog")
    application.link_source({"id": "code", "role": "implementation", "checkout": str(repository)})
    profile = configure_gateway(workspace, config_root)
    return application, config_root, profile


def test_semantic_start_records_exact_nonsecret_gateway_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application, config_root, profile = semantic_workspace(tmp_path)
    launched: list[tuple[str, str]] = []
    monkeypatch.setattr(
        application,
        "_launch_run_worker",
        lambda run_id, mode: launched.append((run_id, mode)),
    )
    preflight = application.run_preflight()

    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
        }
    )

    assert launched == [(started["run_id"], "gateway_semantic")]
    with sqlite3.connect(application.database_path) as connection:
        source_set = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (started["run_id"],)
            ).fetchone()[0]
        )
    resolved = source_set["workspace_configuration"]["resolved_models"]
    assert source_set["execution"] == {"mode": "gateway_semantic"}
    assert resolved["profile"] == {
        "id": "enterprise",
        "name": "Enterprise Gateway",
        "gateway_id": "corp-openai",
        "base_url": "http://127.0.0.1:8765/v1",
        "header_names": ["X-Tenant"],
        "revision": profile["revision"],
        "registered": True,
    }
    assert resolved["assignments"]["planner"] == "model-a"
    assert resolved["assignments"]["worker"] == "model-a"
    assert resolved["assignments"]["verifier"] == "model-b"
    assert resolved["concurrency"] == 2
    assert resolved["budgets"] == {"total_tokens": 5000}
    assert resolved["runtime_limits"] == {"per_agent_call_total_tokens": 5000}
    encoded = json.dumps(source_set)
    assert "never-persist-this-secret" not in encoded
    assert "private-tenant-value" not in encoded
    assert str(config_root) not in encoded
    assert started["models"] == resolved


def test_semantic_start_requires_known_budget_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application, _config_root, _profile = semantic_workspace(tmp_path)
    settings = application.settings()
    settings["local_settings"]["models"]["budgets"] = {"imaginary_limit": 1}
    application.update_settings(
        settings["definition"],
        settings["local_settings"],
        settings["configuration_digest"],
    )
    preflight = application.run_preflight()
    monkeypatch.setattr(application, "_launch_run_worker", lambda *_args: None)

    with pytest.raises(ValueError, match="unknown semantic budget"):
        application.start_run(
            {
                "configuration_digest": preflight["configuration_digest"],
                "source_set_digest": preflight["source_set_digest"],
            }
        )


def test_start_run_pins_preflight_inputs_and_worker_reaches_review_without_gateway(
    tmp_path: Path,
) -> None:
    repository, revision = source_repository(tmp_path)
    workspace = tmp_path / "workspace"
    application = WorkspaceApplication(workspace)
    application.initialize("catalog")
    application.link_source({"id": "code", "role": "implementation", "checkout": str(repository)})
    settings = application.settings()
    settings["definition"]["profile"]["dispositions"]["major"] = {
        "disposition": "open",
        "reason": None,
    }
    application.update_settings(
        settings["definition"],
        settings["local_settings"],
        settings["configuration_digest"],
    )
    preflight = application.run_preflight()

    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
            "fixture": "success",
        }
    )
    (repository / "README.md").write_text("# Catalog\n\nA later change.\n")
    git(repository, "add", "README.md")
    git(repository, "commit", "-m", "later")

    status = wait_for_state(application, started["run_id"], "review_required")

    assert [event["state"] for event in status["events"]] == [
        "preparing",
        "exploring",
        "verifying",
        "rendering",
        "checking",
        "review_required",
    ]
    assert status["source_set_digest"] == preflight["source_set_digest"]
    assert status["sources"] == [
        {
            "id": "code",
            "role": "implementation",
            "revision": revision,
            "tree_digest": preflight["sources"][0]["tree_digest"],
        }
    ]
    assert status["outcome"] == "review_required"
    assert status["execution"] == {
        "mode": "deterministic_fixture",
        "requested_outcome": "success",
    }
    assert status["tasks"]["active"] == []
    assert status["tasks"]["failed"] == []
    assert [task["state"] for task in status["tasks"]["completed"]] == ["accepted"]
    task = status["tasks"]["completed"][0]
    assert task["source_id"] == "code"
    assert task["path_scope"] == ["README.md"]
    assert task["agent_role"] == "extraction"
    assert task["budgets"]["total_tokens_limit"] == 60_000
    assert set(task["receipt"]) == {"accepted_ids", "unresolved_ids", "warnings"}
    assert status["coverage_obligations"][0]["source"] == "code"
    assert status["coverage_obligations"][0]["role"]
    assert status["coverage_obligations"][0]["priority"] == "major"
    assert status["coverage_obligations"][0]["disposition"] == "covered"
    assert [change["state"] for change in status["coverage_obligations"][0]["state_changes"]] == [
        "assigned",
        "covered",
    ]
    assert status["audit"] == {
        "failures": 0,
        "latency_ms": 0,
        "models": [],
        "retries": 0,
        "tokens": 0,
        "tool_calls": 0,
    }
    assert status["models"] is None


def test_failure_fixture_preserves_recorded_progress_and_actionable_error(
    tmp_path: Path,
) -> None:
    repository, _revision = source_repository(tmp_path)
    workspace = tmp_path / "workspace"
    application = WorkspaceApplication(workspace)
    application.initialize("catalog")
    application.link_source({"id": "code", "role": "implementation", "checkout": str(repository)})
    preflight = application.run_preflight()

    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
            "fixture": "failure",
        }
    )
    status = wait_for_state(application, started["run_id"], "failed")

    assert [event["state"] for event in status["events"]] == [
        "preparing",
        "exploring",
        "failed",
    ]
    assert status["outcome"] == "failed"
    assert status["actionable_errors"] == ["Deterministic failure fixture stopped during Exploring"]


def test_run_worker_ignores_workspace_package_and_stdlib_import_shadows(
    tmp_path: Path,
) -> None:
    repository, _revision = source_repository(tmp_path)
    workspace = tmp_path / "workspace"
    application = WorkspaceApplication(workspace)
    application.initialize("catalog")
    application.link_source({"id": "code", "role": "implementation", "checkout": str(repository)})
    package_marker = workspace / "package-shadow-ran"
    stdlib_marker = workspace / "stdlib-shadow-ran"
    (workspace / "okf_wiki").mkdir()
    (workspace / "okf_wiki" / "__init__.py").write_text("")
    (workspace / "okf_wiki" / "run_worker.py").write_text(
        f"from pathlib import Path\nPath({str(package_marker)!r}).write_text('unsafe')\n"
    )
    (workspace / "hashlib.py").write_text(
        f"from pathlib import Path\nPath({str(stdlib_marker)!r}).write_text('unsafe')\n"
    )
    preflight = application.run_preflight()

    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
            "fixture": "success",
        }
    )
    status = wait_for_state(application, started["run_id"], "review_required")

    assert status["state"] == "review_required"
    assert not package_marker.exists()
    assert not stdlib_marker.exists()


def test_historical_legacy_runs_and_typed_entity_events_are_safe_to_reload(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    application = WorkspaceApplication(workspace)
    application.initialize("catalog")
    with sqlite3.connect(workspace / ".okf-wiki" / "runs.db") as connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES ('run-2', 'catalog', '/legacy/source', 'abc123', '/legacy/published',
                       '/legacy/staging', 'exploring', NULL, '2026-01-01T00:00:00+00:00',
                       '2026-01-01T00:01:00+00:00')"""
        )
        connection.execute(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES ('run-2', NULL, 'planned', '2026-01-01T00:00:30+00:00', ?)""",
            (
                json.dumps(
                    {
                        "entity_type": "analysis_task",
                        "entity_id": "task-1",
                        "prompt": "hidden fixture prompt",
                        "reasoning": "hidden fixture reasoning",
                    }
                ),
            ),
        )

    listed = application.list_runs()
    status = application.run_status("run-2")

    assert listed["runs"][0]["run_id"] == "run-2"
    assert listed["runs"][0]["source_set_digest"]
    assert status["sources"] == [
        {
            "id": "source",
            "revision": "abc123",
            "role": "implementation",
            "tree_digest": None,
        }
    ]
    assert status["entity_events"] == [
        {
            "entity_id": "task-1",
            "entity_type": "analysis_task",
            "occurred_at": "2026-01-01T00:00:30+00:00",
            "previous_state": None,
            "sequence": 1,
            "state": "planned",
        }
    ]
    assert "hidden fixture" not in json.dumps(status)
