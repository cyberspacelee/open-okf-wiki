import asyncio
import json
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

from okf_wiki import run_worker
from okf_wiki.accepted_knowledge import AcceptedKnowledgeStore
from okf_wiki.cli import advance_preparation, advance_rendering
from okf_wiki.gateway_profiles import GatewayApplication, GatewayProfileRegistry
from okf_wiki.scheduler import Scheduler, SchedulerOutcome
from okf_wiki.state_schema import migrate_worker_audit
from okf_wiki.verification import REQUIRED_PERSPECTIVES, VerificationStore
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


def test_semantic_worker_fails_before_connecting_when_profile_revision_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application, config_root, profile = semantic_workspace(tmp_path)
    monkeypatch.setattr(application, "_launch_run_worker", lambda *_args: None)
    preflight = application.run_preflight()
    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
        }
    )
    GatewayProfileRegistry(config_root).save(
        {
            "id": "enterprise",
            "name": "Renamed Gateway",
            "gateway_id": "corp-openai",
            "base_url": "http://127.0.0.1:8765/v1",
            "headers": {"X-Tenant": "private-tenant-value"},
        },
        expected_revision=profile["revision"],
    )
    monkeypatch.setenv("OKF_WIKI_CONFIG_HOME", str(config_root))
    monkeypatch.setattr(
        "sys.argv",
        ["okf_wiki.run_worker", str(application.root), started["run_id"], "gateway_semantic"],
    )

    assert run_worker.main() == 1

    status = application.run_status(started["run_id"])
    assert status["state"] == "failed"
    assert status["actionable_errors"] == [
        "Gateway Profile changed after the Production Run started; start a new Run"
    ]


def test_semantic_worker_terminalizes_noncomplete_scheduler_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application, config_root, _profile = semantic_workspace(tmp_path)
    monkeypatch.setattr(application, "_launch_run_worker", lambda *_args: None)
    preflight = application.run_preflight()
    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
        }
    )
    monkeypatch.setenv("OKF_WIKI_CONFIG_HOME", str(config_root))
    monkeypatch.setattr(
        run_worker,
        "execute_semantic_run",
        lambda *_args, **_kwargs: SchedulerOutcome(
            status="failed",
            warnings=("Gateway authentication failed; update the Gateway Profile credential",),
        ),
    )

    run_worker.run(application.root, started["run_id"], "gateway_semantic")

    status = application.run_status(started["run_id"])
    assert status["state"] == "failed"
    assert status["actionable_errors"] == [
        "Gateway authentication failed; update the Gateway Profile credential"
    ]


def test_run_audit_aggregates_real_records_by_role_and_response_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application, _config_root, _profile = semantic_workspace(tmp_path)
    monkeypatch.setattr(application, "_launch_run_worker", lambda *_args: None)
    preflight = application.run_preflight()
    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
        }
    )
    audit = application.root / ".okf-wiki" / "runs" / started["run_id"] / "worker.db"
    audit.parent.mkdir(parents=True)
    with sqlite3.connect(audit) as connection:
        migrate_worker_audit(connection)
        connection.execute(
            """INSERT INTO worker_candidates
               (id, task_id, obligation_ids_json, source_id, revision, status,
                proposal_json, errors_json, error_type, trajectory_json, retry_count,
                usage_json, latency_ms, gateway_id, model, prompt_version, tool_version,
                schema_version, response_model, provider_url)
               VALUES ('work', 'task', '[]', 'code', 'revision', 'accepted', NULL, '[]',
                       NULL, '[]', 0, '{"total_tokens":200,"tool_calls":3}', 20,
                       'gateway', 'assigned-worker', 'prompt', 'tool', 'schema',
                       'work-model', NULL)"""
        )
        connection.executemany(
            """INSERT INTO agent_invocations
               (id, role, status, usage_json, latency_ms, retry_count, model, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    "plan",
                    "planner",
                    "accepted",
                    '{"total_tokens":100,"tool_calls":0}',
                    10,
                    1,
                    "plan-model",
                    None,
                ),
                (
                    "verify",
                    "verifier",
                    "failed",
                    '{"total_tokens":300,"tool_calls":1}',
                    30,
                    2,
                    "verify-model",
                    "safe failure",
                ),
            ],
        )

    assert application.run_status(started["run_id"])["audit"] == {
        "failures": 1,
        "latency_ms": 60,
        "models": ["plan-model", "verify-model", "work-model"],
        "retries": 3,
        "tokens": 600,
        "tool_calls": 4,
        "by_role_model": [
            {
                "role": "planner",
                "model": "plan-model",
                "calls": 1,
                "failures": 0,
                "latency_ms": 10,
                "retries": 1,
                "tokens": 100,
                "tool_calls": 0,
            },
            {
                "role": "verifier",
                "model": "verify-model",
                "calls": 1,
                "failures": 1,
                "latency_ms": 30,
                "retries": 2,
                "tokens": 300,
                "tool_calls": 1,
            },
            {
                "role": "worker",
                "model": "work-model",
                "calls": 1,
                "failures": 0,
                "latency_ms": 20,
                "retries": 0,
                "tokens": 200,
                "tool_calls": 3,
            },
        ],
    }


def test_review_required_semantic_candidate_reaches_run_review_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    application, _config_root, _profile = semantic_workspace(tmp_path)
    monkeypatch.setattr(application, "_launch_run_worker", lambda *_args: None)
    preflight = application.run_preflight()
    started = application.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
        }
    )
    run_id = started["run_id"]
    monkeypatch.chdir(application.root)
    with sqlite3.connect(application.database_path) as connection:
        connection.row_factory = sqlite3.Row
        state, _coverage = advance_preparation(connection, run_id)
    assert state == "exploring"
    scheduler = Scheduler(
        application.database_path,
        run_worker.FixturePlanner(),
        run_worker.FixtureWorker(application.database_path, run_id),
        verifier=run_worker.FixtureVerifier(),
    )

    outcome = asyncio.run(scheduler.advance(run_id))

    assert outcome.status == "complete"
    with sqlite3.connect(application.database_path) as connection:
        connection.row_factory = sqlite3.Row
        candidate_id, candidate_status = connection.execute(
            "SELECT candidate_id, status FROM verification_candidates WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        assert candidate_status == "review_required"
        assert (
            connection.execute("SELECT state FROM runs WHERE id = ?", (run_id,)).fetchone()[0]
            == "verifying"
        )
        advance_rendering(connection, run_id)

    decision = VerificationStore(application.database_path).get_decision(run_id, candidate_id)
    assert decision is not None and decision.outcome == "review_required"
    assert len(
        VerificationStore(application.database_path).get_findings(run_id, candidate_id)
    ) == len(REQUIRED_PERSPECTIVES)
    assert AcceptedKnowledgeStore(application.database_path).get_coverage_summary(run_id) == {
        "covered": 1
    }
    status = application.run_status(run_id)
    assert status["state"] == "review_required"
    assert [task["state"] for task in status["tasks"]["completed"]] == ["accepted"]
    with sqlite3.connect(application.database_path) as connection:
        source_set = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()[0]
        )
    assert source_set["review"]["blocking_findings"] == [
        f"{candidate_id}:acceptance_policy:high-risk knowledge: security"
    ]


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
        "by_role_model": [],
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
