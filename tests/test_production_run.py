import json
import sqlite3
import subprocess
import sys
from pathlib import Path


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


def make_source(path: Path) -> str:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    (path / "README.md").write_text("# Example\n\nFixed source knowledge.\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()


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


def commit_source(source: Path, text: str | None) -> str:
    readme = source / "README.md"
    if text is None:
        readme.unlink()
    else:
        readme.write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "change"], cwd=source, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()


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
    assert approved["state"] == "succeeded"
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
    run(["review", rejected["run_id"], "--reject"], workspace)
    assert run(["status", rejected["run_id"]], workspace)["state"] == "rejected"
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
        coverage.read_text(encoding="utf-8").replace("open_obligations: 0", "open_obligations: 1"),
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
