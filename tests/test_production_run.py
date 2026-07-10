import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from okf_wiki.cli import UserError, transition


def run(command: list[str], cwd: Path, expected: int = 0) -> dict:
    result = subprocess.run(
        [sys.executable, "-m", "okf_wiki", *command],
        cwd=cwd,
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == expected, result.stderr or result.stdout
    return json.loads(result.stdout)


def head_revision(source: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()


def make_source(path: Path, text: str = "# Example\n\nFixed source knowledge.\n") -> str:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    (path / "README.md").write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    return head_revision(path)


def write_config(workspace: Path, source: Path, revision: str) -> Path:
    config = workspace / "project.toml"
    config.write_text(
        "\n".join(
            [
                'project_id = "example"',
                f'repository = "{source}"',
                f'revision = "{revision}"',
                'publish_dir = "published"',
                "",
            ]
        ),
        encoding="utf-8",
    )
    return config


def build_run(workspace: Path, source: Path, revision: str, expected: int = 0) -> dict:
    return run(["build", str(write_config(workspace, source, revision))], workspace, expected)


def write_source_set_config(workspace: Path, sources: list[dict[str, str]]) -> Path:
    config = workspace / "source-set.toml"
    lines = ['project_id = "combined"', 'publish_dir = "published"', ""]
    for source in sources:
        lines.extend(
            [
                "[[sources]]",
                f'id = "{source["id"]}"',
                f'role = "{source["role"]}"',
                f'repository = "{source["repository"]}"',
                f'revision = "{source["revision"]}"',
                "",
            ]
        )
    config.write_text("\n".join(lines), encoding="utf-8")
    return config


def commit_source(source: Path, text: str | None) -> str:
    readme = source / "README.md"
    if text is None:
        readme.unlink()
    else:
        readme.write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "change"], cwd=source, check=True)
    return head_revision(source)


def test_build_check_and_approve_a_fixed_revision(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    assert built["ok"] is True
    run_id = built["run_id"]

    status_before = run(["status", run_id], workspace)
    assert status_before["state"] == "review_required"
    assert status_before["source"] == {"repository": str(source), "revision": revision}
    assert status_before["coverage"] == {"covered": 1, "major": 1, "open": 0}
    assert [event["state"] for event in status_before["events"]] == [
        "preparing",
        "rendering",
        "checking",
        "review_required",
    ]

    staging = Path(status_before["staging_bundle"])
    assert {path.relative_to(staging).as_posix() for path in staging.rglob("*.md")} == {
        "index.md",
        "log.md",
        "overview.md",
        "reports/coverage.md",
    }
    assert revision in (staging / "overview.md").read_text(encoding="utf-8")

    checked = run(["check", run_id], workspace)
    assert checked == {"errors": [], "ok": True, "target": run_id}
    assert run(["status", run_id], workspace)["events"] == status_before["events"]

    approved = run(["review", run_id, "--approve"], workspace)
    assert approved["ok"] is True
    assert approved["state"] == "published"
    assert (workspace / "published" / "overview.md").read_text(encoding="utf-8") == (
        staging / "overview.md"
    ).read_text(encoding="utf-8")
    assert run(["check", str(workspace / "published")], workspace)["ok"] is True


def test_reject_cancel_and_failure_leave_the_published_bundle_unchanged(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    first_revision = make_source(source)
    first = build_run(workspace, source, first_revision)
    run(["review", first["run_id"], "--approve"], workspace)
    published = workspace / "published"
    original_release = published.resolve()
    original_overview = (published / "overview.md").read_bytes()

    second_revision = commit_source(source, "# Example\n\nChanged source knowledge.\n")
    rejected = build_run(workspace, source, second_revision)
    rejection = run(["review", rejected["run_id"], "--reject"], workspace)
    assert rejection == {
        "decision": "rejected",
        "ok": True,
        "run_id": rejected["run_id"],
        "state": "cancelled",
    }
    rejected_status = run(["status", rejected["run_id"]], workspace)
    assert rejected_status["state"] == "cancelled"
    assert rejected_status["events"][-1]["details"] == {"decision": "rejected"}
    assert published.resolve() == original_release
    assert (published / "overview.md").read_bytes() == original_overview

    cancelled = build_run(workspace, source, second_revision)
    run(["cancel", cancelled["run_id"]], workspace)
    assert run(["status", cancelled["run_id"]], workspace)["state"] == "cancelled"
    assert published.resolve() == original_release

    no_markdown_revision = commit_source(source, None)
    failed = build_run(workspace, source, no_markdown_revision, expected=1)
    assert failed["state"] == "failed"
    assert run(["status", failed["run_id"]], workspace)["state"] == "failed"
    assert published.resolve() == original_release


def test_final_check_failure_does_not_publish_and_success_atomically_replaces_bundle(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    first_revision = make_source(source)
    first = build_run(workspace, source, first_revision)
    run(["review", first["run_id"], "--approve"], workspace)
    published = workspace / "published"
    original_release = published.resolve()

    second_revision = commit_source(source, "# Example\n\nSecond revision.\n")
    invalid = build_run(workspace, source, second_revision)
    invalid_status = run(["status", invalid["run_id"]], workspace)
    coverage = Path(invalid_status["staging_bundle"]) / "reports" / "coverage.md"
    coverage.write_text(
        coverage.read_text(encoding="utf-8").replace("open_obligations: 0", "open_obligations: 1")
        + "\n# open_obligations: 0\n",
        encoding="utf-8",
    )
    checked = run(["check", invalid["run_id"]], workspace, expected=1)
    assert checked["ok"] is False
    run(["review", invalid["run_id"], "--approve"], workspace, expected=1)
    assert run(["status", invalid["run_id"]], workspace)["state"] == "failed"
    assert published.resolve() == original_release

    valid = build_run(workspace, source, second_revision)
    run(["review", valid["run_id"], "--approve"], workspace)
    new_release = published.resolve()
    assert new_release != original_release
    assert original_release.is_dir()
    assert second_revision in (new_release / "overview.md").read_text(encoding="utf-8")
    assert run(["check", str(new_release)], workspace)["ok"] is True


def test_state_transition_and_run_event_roll_back_together(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    before = run(["status", built["run_id"]], workspace)
    database = workspace / ".okf-wiki" / "runs.db"

    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TRIGGER reject_cancel_event BEFORE INSERT ON run_events
               WHEN NEW.state = 'cancelled'
               BEGIN SELECT RAISE(ABORT, 'seeded event failure'); END"""
        )
    result = subprocess.run(
        [sys.executable, "-m", "okf_wiki", "cancel", built["run_id"]],
        cwd=workspace,
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode != 0
    after = run(["status", built["run_id"]], workspace)
    assert after["state"] == "review_required"
    assert after["events"] == before["events"]

    with sqlite3.connect(database) as connection:
        try:
            connection.execute("UPDATE run_events SET state = 'failed'")
        except sqlite3.IntegrityError as error:
            assert "immutable" in str(error)
        else:
            raise AssertionError("Run Events must be immutable")


def test_status_reads_an_issue01_ledger_without_source_set_columns(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    database = workspace / ".okf-wiki" / "runs.db"
    database.parent.mkdir(parents=True)
    revision = "a" * 40
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                repository TEXT NOT NULL,
                revision TEXT NOT NULL,
                publish_dir TEXT NOT NULL,
                staging_dir TEXT NOT NULL,
                state TEXT NOT NULL,
                coverage_json TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE run_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL REFERENCES runs(id),
                previous_state TEXT,
                state TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '{}'
            );
            """
        )
        connection.execute(
            """INSERT INTO runs VALUES
               ('old-run', 'old-project', '/gone/repository', ?, '/published', '/staging',
                'review_required', '{"covered": 1, "major": 1, "open": 0}', NULL,
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')""",
            (revision,),
        )
        connection.execute(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES ('old-run', NULL, 'review_required', '2026-01-01T00:00:00Z', '{}')"""
        )

    status = run(["status", "old-run"], workspace)
    assert status["source"] == {"repository": "/gone/repository", "revision": revision}
    assert status["sources"] == [
        {
            "id": "source",
            "repository": "/gone/repository",
            "revision": revision,
            "role": "implementation",
        }
    ]
    assert re.fullmatch(r"[0-9a-f]{64}", status["source_set_digest"])
    assert status["source_universe"] == []
    assert status["evidence"] == []


def test_illegal_transition_and_publishing_cancellation_are_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    database = workspace / ".okf-wiki" / "runs.db"

    with sqlite3.connect(database) as connection:
        with pytest.raises(UserError, match="review_required -> rendering"):
            transition(connection, built["run_id"], "review_required", "rendering")
        transition(connection, built["run_id"], "review_required", "publishing")

    for _ in range(3):
        cancelled = run(["cancel", built["run_id"]], workspace, expected=1)
        assert "publishing -> cancelled" in cancelled["errors"][0]
    status = run(["status", built["run_id"]], workspace)
    assert status["state"] == "publishing"
    assert "cancelled" not in [event["state"] for event in status["events"]]
    assert not (workspace / "published").exists()


def test_staged_source_revision_must_match_the_run_and_bundle(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    staging = Path(status["staging_bundle"])
    overview = staging / "overview.md"
    overview.write_text(
        overview.read_text(encoding="utf-8").replace(revision, "0" * len(revision)),
        encoding="utf-8",
    )

    assert run(["check", built["run_id"]], workspace, expected=1)["ok"] is False
    assert run(["check", str(staging)], workspace, expected=1)["ok"] is False
    approval = run(["review", built["run_id"], "--approve"], workspace, expected=1)
    assert approval["state"] == "failed"
    assert not (workspace / "published").exists()


@pytest.mark.parametrize("reserved_file", ["index.md", "log.md"])
def test_reserved_files_reject_unstructured_text(tmp_path: Path, reserved_file: str) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    (Path(status["staging_bundle"]) / reserved_file).write_text("# x\njunk\n", encoding="utf-8")

    checked = run(["check", built["run_id"]], workspace, expected=1)
    assert checked["ok"] is False
    assert any(reserved_file in error for error in checked["errors"])


def test_index_accepts_multiple_sections_with_link_bullets(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    (Path(status["staging_bundle"]) / "index.md").write_text(
        "# Start\n\n"
        "* [Overview](overview.md) - Source overview.\n\n"
        "# Reports\n\n"
        "* [Coverage](reports/coverage.md) - Coverage report.\n",
        encoding="utf-8",
    )

    assert run(["check", built["run_id"]], workspace)["ok"] is True


def test_coverage_counts_must_be_nonnegative_and_complete(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    coverage = Path(status["staging_bundle"]) / "reports" / "coverage.md"
    coverage.write_text(
        coverage.read_text(encoding="utf-8")
        .replace("major_obligations: 1", "major_obligations: 9")
        .replace("covered_obligations: 1", "covered_obligations: 9"),
        encoding="utf-8",
    )

    assert run(["check", built["run_id"]], workspace, expected=1)["ok"] is False
    approval = run(["review", built["run_id"], "--approve"], workspace, expected=1)
    assert approval["state"] == "failed"
    assert not (workspace / "published").exists()


def test_failed_published_event_restores_the_previous_bundle(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    first_revision = make_source(source)
    first = build_run(workspace, source, first_revision)
    run(["review", first["run_id"], "--approve"], workspace)
    published = workspace / "published"
    previous_target = os.readlink(published)
    previous_overview = (published / "overview.md").read_bytes()

    second_revision = commit_source(source, "# Example\n\nSecond revision.\n")
    second = build_run(workspace, source, second_revision)
    database = workspace / ".okf-wiki" / "runs.db"
    with sqlite3.connect(database) as connection:
        connection.execute(
            """CREATE TRIGGER reject_published_event BEFORE INSERT ON run_events
               WHEN NEW.state = 'published'
               BEGIN SELECT RAISE(ABORT, 'seeded published event failure'); END"""
        )

    approval = run(["review", second["run_id"], "--approve"], workspace, expected=1)
    assert approval["state"] == "failed"
    status = run(["status", second["run_id"]], workspace)
    assert status["state"] == "failed"
    assert "published" not in [event["state"] for event in status["events"]]
    assert os.readlink(published) == previous_target
    assert (published / "overview.md").read_bytes() == previous_overview


def test_two_named_sources_build_and_publish_one_bundle(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    implementation = tmp_path / "implementation"
    requirements = tmp_path / "requirements"
    implementation_revision = make_source(
        implementation, "# Service\n\nImplementation knowledge.\n"
    )
    requirements_revision = make_source(requirements, "# Requirements\n\nRequired behavior.\n")
    config = write_source_set_config(
        workspace,
        [
            {
                "id": "service",
                "role": "implementation",
                "repository": str(implementation),
                "revision": implementation_revision,
            },
            {
                "id": "requirements",
                "role": "requirements",
                "repository": str(requirements),
                "revision": requirements_revision,
            },
        ],
    )

    built = run(["build", str(config)], workspace)
    status = run(["status", built["run_id"]], workspace)
    assert status["state"] == "review_required"
    assert status["coverage"] == {"covered": 2, "major": 2, "open": 0}
    assert [source["id"] for source in status["sources"]] == ["requirements", "service"]
    assert {source["role"] for source in status["sources"]} == {
        "implementation",
        "requirements",
    }
    assert {source["revision"] for source in status["sources"]} == {
        implementation_revision,
        requirements_revision,
    }
    assert all(re.fullmatch(r"[0-9a-f]{64}", source["digest"]) for source in status["sources"])
    assert re.fullmatch(r"[0-9a-f]{64}", status["source_set_digest"])
    assert {(entry["source_id"], entry["path"]) for entry in status["source_universe"]} == {
        ("service", "README.md"),
        ("requirements", "README.md"),
    }
    assert {evidence["source_id"] for evidence in status["evidence"]} == {
        "service",
        "requirements",
    }
    assert len({evidence["source_unit"] for evidence in status["evidence"]}) == 2
    for evidence in status["evidence"]:
        assert re.fullmatch(r"file:[0-9a-f]{64}", evidence["source_unit"])
        assert evidence["source_unit_kind"] == "file"
        assert evidence["span"] == {"end_line": 3, "start_line": 1}
        assert evidence["revision"] in {implementation_revision, requirements_revision}
        assert re.fullmatch(r"[0-9a-f]{64}", evidence["content_digest"])

    staging = Path(status["staging_bundle"])
    coverage = (staging / "reports" / "coverage.md").read_text(encoding="utf-8")
    assert "service" in coverage and implementation_revision in coverage
    assert "requirements" in coverage and requirements_revision in coverage
    run(["review", built["run_id"], "--approve"], workspace)
    assert run(["check", str(workspace / "published")], workspace)["ok"] is True


def test_java_only_source_can_join_a_source_set_with_markdown(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    implementation = tmp_path / "implementation"
    requirements = tmp_path / "requirements"
    make_source(implementation)
    (implementation / "README.md").unlink()
    (implementation / "Service.java").write_text("final class Service {}\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=implementation, check=True)
    subprocess.run(["git", "commit", "-qm", "java only"], cwd=implementation, check=True)
    implementation_revision = head_revision(implementation)
    requirements_revision = make_source(requirements)
    config = write_source_set_config(
        workspace,
        [
            {
                "id": "service",
                "role": "implementation",
                "repository": str(implementation),
                "revision": implementation_revision,
            },
            {
                "id": "requirements",
                "role": "requirements",
                "repository": str(requirements),
                "revision": requirements_revision,
            },
        ],
    )

    built = run(["build", str(config)], workspace)
    status = run(["status", built["run_id"]], workspace)
    assert status["coverage"] == {"covered": 1, "major": 1, "open": 0}
    assert {source["id"]: source["coverage"]["major"] for source in status["sources"]} == {
        "requirements": 1,
        "service": 0,
    }
    assert {(entry["source_id"], entry["path"]) for entry in status["source_universe"]} == {
        ("requirements", "README.md"),
        ("service", "Service.java"),
    }
    assert [item["source_id"] for item in status["evidence"]] == ["requirements"]
    run(["review", built["run_id"], "--approve"], workspace)
    assert run(["check", str(workspace / "published")], workspace)["ok"] is True


def test_fixed_snapshots_ignore_worktree_content_but_keep_tracked_ignored_files(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    committed = b"# Example\n\nFixed source knowledge.\n"
    make_source(source, committed.decode())
    (source / ".gitignore").write_text("README.md\nignored.md\n", encoding="utf-8")
    subprocess.run(["git", "add", ".gitignore"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "ignore tracked file later"], cwd=source, check=True)
    revision = head_revision(source)

    (source / "README.md").write_text("# Dirty\n\nNot in the snapshot.\n", encoding="utf-8")
    (source / "untracked.md").write_text("# Untracked\n", encoding="utf-8")
    (source / "ignored.md").write_text("# Ignored and untracked\n", encoding="utf-8")

    first = build_run(workspace, source, revision)
    first_status = run(["status", first["run_id"]], workspace)
    assert [(entry["source_id"], entry["path"]) for entry in first_status["source_universe"]] == [
        ("source", ".gitignore"),
        ("source", "README.md"),
    ]
    assert first_status["coverage"] == {"covered": 1, "major": 1, "open": 0}
    evidence = first_status["evidence"]
    assert len(evidence) == 1
    assert evidence[0]["content_digest"] == hashlib.sha256(committed).hexdigest()
    assert evidence[0]["span"] == {"end_line": 3, "start_line": 1}

    (source / "README.md").write_text("# Dirtier\n", encoding="utf-8")
    (source / "another-untracked.md").write_text("# Also absent\n", encoding="utf-8")
    second = build_run(workspace, source, revision.upper())
    second_status = run(["status", second["run_id"]], workspace)
    assert second_status["sources"] == first_status["sources"]
    assert second_status["source_set_digest"] == first_status["source_set_digest"]
    assert second_status["source_universe"] == first_status["source_universe"]
    assert second_status["evidence"] == first_status["evidence"]


def test_non_utf8_git_path_is_percent_encoded_in_the_source_universe(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    make_source(source)
    raw_path = os.path.join(os.fsencode(source), b"\xff.bin")
    descriptor = os.open(raw_path, os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        os.write(descriptor, b"binary source\n")
    finally:
        os.close(descriptor)
    (source / "%FF.bin").write_bytes(b"literal percent source\n")
    subprocess.run(
        [b"git", b"add", b"--", b"\xff.bin", b"%FF.bin"],
        cwd=os.fsencode(source),
        check=True,
    )
    subprocess.run(["git", "commit", "-qm", "byte path"], cwd=source, check=True)
    revision = head_revision(source)

    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    assert {(entry["source_id"], entry["path"]) for entry in status["source_universe"]} == {
        ("source", "%25FF.bin"),
        ("source", "%FF.bin"),
        ("source", "README.md"),
    }
