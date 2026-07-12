import concurrent.futures
import json
import os
import sqlite3
import subprocess
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest

import okf_wiki.workspace as workspace_module
from okf_wiki.state_schema import (
    MIGRATIONS,
    WORKER_AUDIT_MIGRATIONS,
    migrate_state,
    migrate_worker_audit,
)
from okf_wiki.workspace import WorkspaceApplication, WorkspaceError, WorkspaceStaleError


def cli(command: list[str], cwd: Path, expected: int = 0) -> dict:
    result = subprocess.run(
        [sys.executable, "-m", "okf_wiki", *command],
        cwd=cwd,
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == expected, result.stderr or result.stdout
    return json.loads(result.stdout)


def make_source(path: Path) -> str:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    (path / "README.md").write_text("Fixed source knowledge.\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, check=True, text=True, capture_output=True
    ).stdout.strip()


def test_workspace_application_initializes_reopens_and_cli_inspects(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    snapshot = WorkspaceApplication(workspace).initialize("catalog", "Catalog Service")

    assert snapshot.project.model_dump() == {"id": "catalog", "name": "Catalog Service"}
    assert snapshot.sources == ()
    assert (workspace / "workspace.toml").is_file()
    assert (workspace / ".okf-wiki" / "settings.toml").is_file()

    reopened = WorkspaceApplication(workspace).open()
    assert reopened == snapshot
    inspected = cli(["workspace", "inspect", str(workspace)], tmp_path)
    assert inspected["project"] == {"id": "catalog", "name": "Catalog Service"}
    assert inspected["publication"]["path"] == str(workspace / "published")
    assert inspected["models"] == {
        "budgets": {},
        "concurrency": 4,
        "default_model": None,
        "gateway_profile": None,
        "role_overrides": {},
    }


def test_cli_invalid_workspace_init_returns_machine_readable_error(tmp_path: Path) -> None:
    result = cli(["workspace", "init", "   ", "--root", str(tmp_path)], tmp_path, expected=1)
    assert result["ok"] is False
    assert "workspace.toml: invalid field 'project.id'" in result["errors"][0]


def test_workspace_keeps_one_producer_project_identity(tmp_path: Path) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    before = (tmp_path / "workspace.toml").read_bytes()

    with pytest.raises(WorkspaceError, match=r"Producer Project identity is immutable \(catalog\)"):
        app.update(
            {"schema_version": 1, "project": {"id": "other", "name": "Other"}},
            {"schema_version": 1},
        )

    assert (tmp_path / "workspace.toml").read_bytes() == before


def test_settings_use_case_reads_and_atomically_updates_shared_and_local_layers(
    tmp_path: Path,
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog", "Catalog")
    before = app.settings()

    updated = app.update_settings(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog Platform"},
            "publication": {"path": "dist/wiki", "bundle_name": "Catalog Knowledge"},
            "sources": [],
            "profile": {
                "java_excluded_paths": ["generated/**"],
                "priorities": {"data_contract": "major"},
                "dispositions": {
                    "supporting": {
                        "disposition": "deferred",
                        "reason": "Reviewed in the next release",
                    }
                },
            },
        },
        {
            "schema_version": 1,
            "checkouts": {},
            "models": {
                "gateway_profile": "enterprise",
                "default_model": "model-v1",
                "role_overrides": {"worker": "model-worker"},
                "concurrency": 3,
                "budgets": {"total_tokens": 12000},
            },
            "ui": {"compact_navigation": True},
        },
        before["configuration_digest"],
    )

    assert updated["definition"]["project"] == {
        "id": "catalog",
        "name": "Catalog Platform",
    }
    assert updated["definition"]["profile"]["priorities"] == {"data_contract": "major"}
    assert updated["local_settings"]["models"]["role_overrides"] == {"worker": "model-worker"}
    assert updated["local_settings"]["ui"] == {"compact_navigation": True}
    assert updated["configuration_digest"] != before["configuration_digest"]
    assert 'name = "Catalog Platform"' in app.definition_path.read_text(encoding="utf-8")
    local_text = app.settings_path.read_text(encoding="utf-8")
    assert "compact_navigation = true" in local_text
    assert "Catalog Platform" not in local_text


def test_settings_use_case_rejects_invalid_stale_and_removed_fields_without_writes(
    tmp_path: Path,
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog", "Catalog")
    current = app.settings()
    definition_before = app.definition_path.read_bytes()
    settings_before = app.settings_path.read_bytes()

    with pytest.raises(WorkspaceError, match="Producer Project identity is immutable"):
        app.update_settings(
            {**current["definition"], "project": {"id": "other", "name": "Other"}},
            current["local_settings"],
            current["configuration_digest"],
        )
    with pytest.raises(WorkspaceError, match="removed field 'models.api_key'.*Gateway Profile"):
        app.update_settings(
            current["definition"],
            {**current["local_settings"], "models": {"api_key": "secret"}},
            current["configuration_digest"],
        )
    with pytest.raises(WorkspaceStaleError, match="settings changed after they were loaded"):
        app.update_settings(
            {**current["definition"], "project": {"id": "catalog", "name": "Stale"}},
            current["local_settings"],
            "0" * 64,
        )

    assert app.definition_path.read_bytes() == definition_before
    assert app.settings_path.read_bytes() == settings_before


def test_settings_payload_requires_the_complete_update_contract(tmp_path: Path) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")

    with pytest.raises(
        WorkspaceError,
        match="must contain definition, local_settings, and configuration_digest",
    ):
        app.update_settings_payload({"definition": {}})


def test_workspace_layers_shared_sources_with_local_checkouts(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    WorkspaceApplication(workspace).initialize("catalog")
    (workspace / "workspace.toml").write_text(
        """schema_version = 1

[project]
id = "catalog"
name = "Catalog"

[publication]
path = "dist/wiki"

[[sources]]
id = "code"
role = "implementation"
revision = "0123456789abcdef0123456789abcdef01234567"
""",
        encoding="utf-8",
    )
    (workspace / ".okf-wiki" / "settings.toml").write_text(
        """schema_version = 1

[checkouts]
code = "../catalog-source"

[models]
gateway_profile = "enterprise"
default_model = "gpt-example"
concurrency = 2

[models.budgets]
total_tokens = 12000
""",
        encoding="utf-8",
    )

    snapshot = WorkspaceApplication(workspace).open()

    assert snapshot.sources[0].checkout == (workspace / "../catalog-source").resolve()
    assert snapshot.publication.path == (workspace / "dist/wiki").resolve()
    assert snapshot.models.gateway_profile == "enterprise"
    assert snapshot.models.budgets == {"total_tokens": 12000}
    inspected = WorkspaceApplication(workspace).inspect()
    assert inspected["sources"][0]["id"] == "code"
    assert inspected["profile"] == {
        "java_excluded_paths": None,
        "priorities": {},
        "dispositions": {},
    }
    assert "api_key" not in json.dumps(inspected)


def test_build_uses_workspace_application_and_keeps_resolved_run_snapshot(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    source = tmp_path / "source"
    revision = make_source(source)
    app = WorkspaceApplication(workspace)
    app.initialize("catalog", "Catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "publication": {"path": "published", "bundle_name": "Catalog Wiki"},
            "sources": [
                {
                    "id": "code",
                    "role": "implementation",
                    "revision": revision,
                }
            ],
            "profile": {"priorities": {"normative_statement": "supporting"}},
        },
        {
            "schema_version": 1,
            "checkouts": {"code": str(source)},
            "models": {
                "gateway_profile": "enterprise",
                "default_model": "model-v1",
                "concurrency": 2,
            },
        },
    )

    built = cli(["build", "workspace.toml"], workspace)
    with sqlite3.connect(workspace / ".okf-wiki" / "runs.db") as connection:
        persisted = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (built["run_id"],)
            ).fetchone()[0]
        )["workspace_configuration"]

    assert persisted["project"] == {"id": "catalog", "name": "Catalog"}
    assert persisted["publication"]["bundle_name"] == "Catalog Wiki"
    assert persisted["sources"][0]["checkout"] == str(source)
    assert persisted["profile"]["priorities"] == {"normative_statement": "supporting"}
    assert persisted["models"]["default_model"] == "model-v1"
    assert "api_key" not in json.dumps(persisted)

    current = app.settings()
    app.update_settings(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Changed Later"},
            "publication": {"path": "published", "bundle_name": "Catalog Wiki"},
            "sources": [
                {
                    "id": "code",
                    "role": "implementation",
                    "revision": revision,
                }
            ],
            "profile": {"priorities": {"normative_statement": "supporting"}},
        },
        {
            "schema_version": 1,
            "checkouts": {"code": str(source)},
            "models": {"default_model": "model-v2"},
        },
        current["configuration_digest"],
    )
    with sqlite3.connect(workspace / ".okf-wiki" / "runs.db") as connection:
        unchanged = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (built["run_id"],)
            ).fetchone()[0]
        )["workspace_configuration"]
    assert unchanged == persisted


def test_build_rejects_noncanonical_versioned_config(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    WorkspaceApplication(workspace).initialize("catalog")
    alternate = workspace / "alternate.toml"
    alternate.write_text("schema_version = 1\n", encoding="utf-8")

    result = cli(["build", str(alternate)], workspace, expected=1)

    assert result["ok"] is False
    assert "must be named workspace.toml" in result["errors"][0]


@pytest.mark.parametrize(
    "remote",
    [
        "https://git@example.test/repo.git",
        "https://git:secret@example.test/repo.git",
        "ssh://git:secret@example.test/repo.git",
        "ssh://git@example.test/repo.git?token=secret",
        "ssh://git@example.test/repo.git#secret",
    ],
)
def test_workspace_rejects_remote_secrets_without_echoing_them(tmp_path: Path, remote: str) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")

    with pytest.raises(WorkspaceError) as caught:
        app.update(
            {
                "schema_version": 1,
                "project": {"id": "catalog", "name": "Catalog"},
                "sources": [
                    {
                        "id": "code",
                        "role": "implementation",
                        "revision": "abc",
                        "remote": remote,
                    }
                ],
            },
            {"schema_version": 1},
        )

    assert "secret" not in str(caught.value)


def test_inspect_and_build_do_not_leak_rejected_remote_credentials(tmp_path: Path) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    app.definition_path.write_text(
        """schema_version = 1
[project]
id = "catalog"
name = "Catalog"
[[sources]]
id = "code"
role = "implementation"
revision = "abc"
remote = "https://git:secret@example.test/catalog.git"
""",
        encoding="utf-8",
    )

    inspected = cli(["workspace", "inspect", str(tmp_path)], tmp_path, expected=1)
    built = cli(["build", "workspace.toml"], tmp_path, expected=1)

    assert "secret" not in json.dumps(inspected)
    assert "secret" not in json.dumps(built)
    with sqlite3.connect(app.database_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0


def test_ssh_user_remote_is_safe_in_inspection_and_run_snapshot(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    source = tmp_path / "source"
    revision = make_source(source)
    remote = "ssh://git@example.test/catalog.git"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [
                {
                    "id": "code",
                    "role": "implementation",
                    "revision": revision,
                    "remote": remote,
                }
            ],
        },
        {"schema_version": 1, "checkouts": {"code": str(source)}},
    )

    assert app.inspect()["sources"][0]["remote"] == remote
    built = cli(["build", "workspace.toml"], workspace)
    with sqlite3.connect(workspace / ".okf-wiki" / "runs.db") as connection:
        snapshot = connection.execute(
            "SELECT source_set_json FROM runs WHERE id = ?", (built["run_id"],)
        ).fetchone()[0]
    assert remote in snapshot
    assert "secret" not in snapshot


@pytest.mark.parametrize(
    ("relative_path", "content", "expected", "definition", "settings"),
    [
        (
            "workspace.toml",
            'schema_version = 1\nproject_id = "old"\n',
            "workspace.toml: removed field 'project_id'",
            {"schema_version": 1, "project_id": "old"},
            {"schema_version": 1},
        ),
        (
            ".okf-wiki/settings.toml",
            'schema_version = 1\n[models]\napi_key = "secret"\n',
            "settings.toml: removed field 'models.api_key'",
            {
                "schema_version": 1,
                "project": {"id": "catalog", "name": "Catalog"},
            },
            {"schema_version": 1, "models": {"api_key": "secret"}},
        ),
    ],
)
def test_invalid_configuration_is_source_located_and_preserves_previous_files(
    tmp_path: Path,
    relative_path: str,
    content: str,
    expected: str,
    definition: dict,
    settings: dict,
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    definition_before = (tmp_path / "workspace.toml").read_bytes()
    settings_before = (tmp_path / ".okf-wiki" / "settings.toml").read_bytes()

    with pytest.raises(WorkspaceError, match=expected):
        app.update(definition, settings)

    assert (tmp_path / "workspace.toml").read_bytes() == definition_before
    assert (tmp_path / ".okf-wiki" / "settings.toml").read_bytes() == settings_before

    (tmp_path / relative_path).write_text(content, encoding="utf-8")
    with pytest.raises(WorkspaceError, match=expected):
        app.open()


@pytest.mark.parametrize(
    ("path", "content", "expected"),
    [
        (
            "workspace.toml",
            'schema_version = 1\n[project]\nid = "catalog"\nname = "Catalog"\nextra = true\n',
            "unknown field 'project.extra'",
        ),
        ("workspace.toml", 'schema_version = "', "malformed TOML"),
        (
            "workspace.toml",
            'schema_version = 1\n[project]\nid = "catalog"\nname = "Catalog"\n'
            '[[sources]]\nid = "code"\nrole = "implementation"\nrevision = "abc"\n'
            'remote = "https://alice:secret@example.test/repo.git"\n',
            "must not contain credentials",
        ),
        (
            ".okf-wiki/settings.toml",
            'schema_version = 1\n[checkouts]\nmissing = "../missing"\n',
            "checkout bindings reference unknown Sources: missing",
        ),
        (
            ".okf-wiki/settings.toml",
            'schema_version = 1\n[models]\nconcurrency = "2"\n',
            "invalid field 'models.concurrency'",
        ),
    ],
)
def test_unknown_malformed_and_conflicting_configuration_fails(
    tmp_path: Path, path: str, content: str, expected: str
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    (tmp_path / path).write_text(content, encoding="utf-8")
    with pytest.raises(WorkspaceError, match=expected):
        app.open()


@pytest.mark.parametrize("legacy_name", ["project.toml", "workspace.toml"])
def test_legacy_project_migration_preserves_configuration_and_runs(
    tmp_path: Path, legacy_name: str
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    legacy = tmp_path / legacy_name
    legacy.write_text(
        f"""project_id = "catalog"
publish_dir = "published"

[[sources]]
id = "code"
role = "implementation"
repository = "{source}"
revision = "0123456789abcdef0123456789abcdef01234567"

[profile.priorities]
normative_statement = "supporting"
""",
        encoding="utf-8",
    )
    state = tmp_path / ".okf-wiki"
    state.mkdir()
    with sqlite3.connect(state / "runs.db") as connection:
        connection.execute(
            """CREATE TABLE runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                repository TEXT NOT NULL,
                revision TEXT NOT NULL,
                publish_dir TEXT NOT NULL,
                staging_dir TEXT NOT NULL,
                state TEXT NOT NULL,
                coverage_json TEXT,
                source_set_json TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        source_set = {"sources": [{"id": "code"}], "review": {"decision": "pending"}}
        connection.execute(
            "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "run-1",
                "catalog",
                str(source),
                "0123456789abcdef0123456789abcdef01234567",
                str(tmp_path / "published"),
                str(state / "runs" / "run-1" / "staging"),
                "review_required",
                "{}",
                json.dumps(source_set),
                None,
                datetime.now(UTC).isoformat(),
                datetime.now(UTC).isoformat(),
            ),
        )

    caller = tmp_path / "caller"
    caller.mkdir()
    migrated = cli(["workspace", "migrate", str(legacy)], caller)
    snapshot = WorkspaceApplication(tmp_path).open()

    assert migrated["workspace"] == str(tmp_path)
    assert snapshot.project.id == "catalog"
    assert snapshot.sources[0].checkout == source
    assert snapshot.profile.priorities == {"normative_statement": "supporting"}
    definition_before = (tmp_path / "workspace.toml").read_bytes()
    settings_before = (state / "settings.toml").read_bytes()
    with pytest.raises(WorkspaceError, match="Workspace is already initialized"):
        WorkspaceApplication(tmp_path).migrate_legacy(legacy)
    assert (tmp_path / "workspace.toml").read_bytes() == definition_before
    assert (state / "settings.toml").read_bytes() == settings_before
    with sqlite3.connect(state / "runs.db") as connection:
        row = connection.execute(
            "SELECT state, source_set_json FROM runs WHERE id = 'run-1'"
        ).fetchone()
        assert row == ("review_required", json.dumps(source_set))


def test_legacy_migration_rejects_a_different_workspace_root(tmp_path: Path) -> None:
    legacy = tmp_path / "project.toml"
    legacy.write_text(
        'project_id = "catalog"\npublish_dir = "published"\n'
        'repository = "source"\nrevision = "abc"\n',
        encoding="utf-8",
    )

    result = cli(
        ["workspace", "migrate", str(legacy), "--root", str(tmp_path / "other")],
        tmp_path,
        expected=1,
    )

    assert "must be migrated in place" in result["errors"][0]


def test_state_schema_migrations_are_ordered_and_reject_future_versions(tmp_path: Path) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    database = tmp_path / ".okf-wiki" / "runs.db"
    with sqlite3.connect(database) as connection:
        assert [row[0] for row in connection.execute("SELECT version FROM schema_migrations")] == [
            1,
            2,
            3,
            4,
            5,
        ]
        connection.execute("INSERT INTO schema_migrations VALUES (99, 'future')")
        before = list(connection.execute("SELECT version, applied_at FROM schema_migrations"))

    with pytest.raises(WorkspaceError, match="newer schema version 99"):
        app.open()

    with sqlite3.connect(database) as connection:
        assert (
            list(connection.execute("SELECT version, applied_at FROM schema_migrations")) == before
        )


def test_failed_state_migration_rolls_back_schema(tmp_path: Path) -> None:
    database = tmp_path / "runs.db"

    def fail(connection: sqlite3.Connection) -> None:
        connection.execute("CREATE TABLE must_rollback (value TEXT)")
        raise RuntimeError("injected migration failure")

    with sqlite3.connect(database) as connection:
        with pytest.raises(RuntimeError, match="injected migration failure"):
            migrate_state(connection, (*MIGRATIONS, fail))
        assert list(connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")) == []


def test_configuration_temp_files_ignore_old_predictable_symlinks(tmp_path: Path) -> None:
    target = tmp_path / "unrelated"
    target.write_text("keep", encoding="utf-8")
    (tmp_path / f".workspace.toml.{os.getpid()}.tmp").symlink_to(target)

    WorkspaceApplication(tmp_path).initialize("catalog")

    assert target.read_text(encoding="utf-8") == "keep"


def test_worker_audit_uses_versioned_migration_and_rolls_back_failure(tmp_path: Path) -> None:
    database = tmp_path / "worker.db"
    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TABLE worker_candidates (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL, obligation_ids_json TEXT NOT NULL,
                source_id TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL,
                proposal_json TEXT, errors_json TEXT NOT NULL, error_type TEXT,
                trajectory_json TEXT NOT NULL, retry_count INTEGER NOT NULL,
                usage_json TEXT NOT NULL, latency_ms INTEGER NOT NULL, gateway_id TEXT NOT NULL,
                model TEXT NOT NULL, response_model TEXT NOT NULL, provider_url TEXT,
                prompt_version TEXT NOT NULL, tool_version TEXT NOT NULL,
                schema_version TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        migrate_worker_audit(connection)
        assert connection.execute("SELECT version FROM schema_migrations").fetchone()[0] == 1

        def fail(database_connection: sqlite3.Connection) -> None:
            database_connection.execute("CREATE TABLE worker_must_rollback (value TEXT)")
            raise RuntimeError("worker migration failure")

        with pytest.raises(RuntimeError, match="worker migration failure"):
            migrate_worker_audit(connection, (*WORKER_AUDIT_MIGRATIONS, fail))
        assert (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE name = 'worker_must_rollback'"
            ).fetchone()
            is None
        )
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 1


def test_failed_state_open_rolls_back_configuration_update(tmp_path: Path) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    definition_before = (tmp_path / "workspace.toml").read_bytes()
    settings_before = (tmp_path / ".okf-wiki" / "settings.toml").read_bytes()
    with sqlite3.connect(tmp_path / ".okf-wiki" / "runs.db") as connection:
        connection.execute("INSERT INTO schema_migrations VALUES (99, 'future')")

    with pytest.raises(WorkspaceError, match="configuration update failed"):
        app.update(
            {
                "schema_version": 1,
                "project": {"id": "catalog", "name": "Changed"},
            },
            {"schema_version": 1},
        )

    assert (tmp_path / "workspace.toml").read_bytes() == definition_before
    assert (tmp_path / ".okf-wiki" / "settings.toml").read_bytes() == settings_before


def test_runtime_error_during_update_restores_previous_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    definition_before = app.definition_path.read_bytes()
    settings_before = app.settings_path.read_bytes()

    def fail(_connection: sqlite3.Connection) -> int:
        raise RuntimeError("injected state migration failure")

    monkeypatch.setattr(workspace_module, "migrate_state", fail)
    with pytest.raises(WorkspaceError, match="configuration update failed"):
        app.update(
            {"schema_version": 1, "project": {"id": "catalog", "name": "Changed"}},
            {"schema_version": 1},
        )

    assert app.definition_path.read_bytes() == definition_before
    assert app.settings_path.read_bytes() == settings_before


def test_open_recovers_old_configuration_after_interrupted_pair_replace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog", "Before")
    definition_before = app.definition_path.read_bytes()
    settings_before = app.settings_path.read_bytes()
    real_replace = os.replace

    def interrupt_after_definition(source: Path | str, target: Path | str) -> None:
        real_replace(source, target)
        if Path(target) == app.definition_path:
            raise KeyboardInterrupt

    monkeypatch.setattr(workspace_module.os, "replace", interrupt_after_definition)
    with pytest.raises(KeyboardInterrupt):
        app.update(
            {"schema_version": 1, "project": {"id": "catalog", "name": "After"}},
            {"schema_version": 1, "models": {"concurrency": 2}},
        )
    monkeypatch.setattr(workspace_module.os, "replace", real_replace)

    recovered = app.open()

    assert recovered.project.name == "Before"
    assert app.definition_path.read_bytes() == definition_before
    assert app.settings_path.read_bytes() == settings_before
    assert not app.update_journal_path.exists()


@pytest.mark.parametrize("journal", ['["definition", "settings"]', '"definition"'])
def test_open_rejects_non_object_update_journal(tmp_path: Path, journal: str) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    app.update_journal_path.write_text(journal, encoding="utf-8")

    with pytest.raises(WorkspaceError, match="cannot recover.*invalid update journal"):
        app.open()


def test_failed_same_name_legacy_migration_restores_original_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = WorkspaceApplication(tmp_path)
    legacy = app.definition_path
    legacy.write_text(
        'project_id = "catalog"\npublish_dir = "published"\n'
        'repository = "source"\nrevision = "abc"\n',
        encoding="utf-8",
    )
    before = legacy.read_bytes()
    real_replace = workspace_module._replace_durable
    failed = False

    def fail_settings_once(source: Path, target: Path) -> None:
        nonlocal failed
        if target == app.settings_path and not failed:
            failed = True
            raise OSError("injected settings replace failure")
        real_replace(source, target)

    monkeypatch.setattr(workspace_module, "_replace_durable", fail_settings_once)
    with pytest.raises(WorkspaceError, match="configuration update failed"):
        app.migrate_legacy(legacy)

    assert legacy.read_bytes() == before
    assert not app.settings_path.exists()
    assert not app.update_journal_path.exists()


def test_concurrent_updates_never_enter_replacement_together_or_mix_pairs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    WorkspaceApplication(tmp_path).initialize("catalog")
    real_replace = workspace_module._replace_durable
    rendezvous = threading.Barrier(2)
    state_lock = threading.Lock()
    active = 0
    maximum_active = 0

    def interleave(source: Path, target: Path) -> None:
        nonlocal active, maximum_active
        if target == tmp_path / "workspace.toml":
            with state_lock:
                active += 1
                maximum_active = max(maximum_active, active)
            try:
                rendezvous.wait(timeout=0.2)
            except threading.BrokenBarrierError:
                pass
            finally:
                with state_lock:
                    active -= 1
        real_replace(source, target)

    monkeypatch.setattr(workspace_module, "_replace_durable", interleave)

    def update(name: str, concurrency: int) -> None:
        WorkspaceApplication(tmp_path).update(
            {"schema_version": 1, "project": {"id": "catalog", "name": name}},
            {"schema_version": 1, "models": {"concurrency": concurrency}},
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(update, "A", 1), executor.submit(update, "B", 2)]
        for future in futures:
            future.result()

    snapshot = WorkspaceApplication(tmp_path).open()
    assert maximum_active == 1
    assert (snapshot.project.name, snapshot.models.concurrency) in {("A", 1), ("B", 2)}


def test_concurrent_digest_updates_allow_one_writer_and_reject_the_stale_writer(
    tmp_path: Path,
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    current = app.settings()

    def update(name: str) -> str:
        return WorkspaceApplication(tmp_path).update_settings(
            {**current["definition"], "project": {"id": "catalog", "name": name}},
            current["local_settings"],
            current["configuration_digest"],
        )["definition"]["project"]["name"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(update, "A"), executor.submit(update, "B")]
    outcomes = []
    for future in futures:
        try:
            outcomes.append(future.result())
        except WorkspaceStaleError:
            outcomes.append("stale")

    assert sorted(outcomes) in (["A", "stale"], ["B", "stale"])


@pytest.mark.parametrize(
    "legacy_body, expected",
    [
        (
            'project_id = "catalog"\npublish_dir = "published"\n'
            'repository = "source"\nrevision = "abc"\n'
            '[[sources]]\nid = "code"\nrole = "implementation"\n'
            'repository = "source"\nrevision = "abc"\n',
            "use either sources or repository/revision",
        ),
        (
            'project_id = "catalog"\npublish_dir = "published"\n'
            '[[sources]]\nid = "code"\nrole = "implementation"\n'
            'repository = "source"\nrevision = "abc"\nignored = true\n',
            "sources.0 has unknown fields: ignored",
        ),
    ],
)
def test_legacy_migration_rejects_conflicting_and_unknown_fields(
    tmp_path: Path, legacy_body: str, expected: str
) -> None:
    legacy = tmp_path / "project.toml"
    legacy.write_text(legacy_body, encoding="utf-8")
    with pytest.raises(WorkspaceError, match=expected):
        WorkspaceApplication(tmp_path).migrate_legacy(legacy)
