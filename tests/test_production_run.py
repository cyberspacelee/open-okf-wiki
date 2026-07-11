import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import okf_wiki.cli as cli
from okf_wiki.accepted_knowledge import AcceptedKnowledgeStore
from okf_wiki.cli import UserError, transition
from okf_wiki.coverage import refresh_run_coverage
from okf_wiki.verification import (
    AcceptanceDecision,
    VerificationFinding,
    VerificationStore,
)


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


def write_source_set_config(
    workspace: Path, sources: list[dict[str, str]], profile: str = ""
) -> Path:
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
    config.write_text("\n".join(lines) + profile, encoding="utf-8")
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


def make_java_source(path: Path) -> str:
    make_source(path, "# Orders\n")
    (path / "src").mkdir()
    (path / "src" / "OrderController.java").write_text(
        "public class OrderController { OrderRequest create(OrderRequest request) { return request; } }\n",
        encoding="utf-8",
    )
    (path / "src" / "OrderRequest.java").write_text(
        "public record OrderRequest(String id) {}\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "src"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "java source"], cwd=path, check=True)
    return head_revision(path)


def move_java_evidence(source: Path) -> str:
    (source / "src" / "api").mkdir()
    subprocess.run(
        ["git", "mv", "src/OrderRequest.java", "src/api/OrderRequest.java"],
        cwd=source,
        check=True,
    )
    subprocess.run(["git", "commit", "-qm", "move request"], cwd=source, check=True)
    return head_revision(source)


def remove_java_evidence(source: Path) -> str:
    subprocess.run(["git", "rm", "src/OrderRequest.java"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "remove request"], cwd=source, check=True)
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
    assert status_before["coverage"]["total"] == 0
    assert status_before["coverage"]["covered"] == 0
    assert status_before["coverage"]["major"] == 0
    assert status_before["coverage"]["open"] == 0
    assert status_before["obligations"] == []
    assert [event["state"] for event in status_before["events"]] == [
        "preparing",
        "exploring",
        "verifying",
        "rendering",
        "checking",
        "review_required",
    ]
    with sqlite3.connect(workspace / ".okf-wiki" / "runs.db") as connection:
        connection.executemany(
            """INSERT INTO run_events
               (run_id, previous_state, state, occurred_at, details)
               VALUES (?, 'open', ?, '2026-01-01T00:00:00Z', ?)""",
            [
                (run_id, "assigned", '{"entity_type":"coverage_obligation"}'),
                (run_id, "planned", '{"entity_type":"analysis_task"}'),
            ],
        )
    assert run(["status", run_id], workspace)["events"] == status_before["events"]

    staging = Path(status_before["staging_bundle"])
    assert {path.relative_to(staging).as_posix() for path in staging.rglob("*.md")} == {
        "architecture/index.md",
        "concepts/index.md",
        "decisions/index.md",
        "flows/index.md",
        "guides/index.md",
        "index.md",
        "log.md",
        "modules/index.md",
        "overview.md",
        "reports/coverage.md",
        "reports/index.md",
        "reports/review.md",
        "requirements/index.md",
        "references/index.md",
    }
    assert revision in (staging / "overview.md").read_text(encoding="utf-8")
    document_ids = [
        next(
            line.removeprefix("id: ")
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.startswith("id: ")
        )
        for path in staging.rglob("*.md")
        if path.name not in {"index.md", "log.md"}
    ]
    assert len(document_ids) == len(set(document_ids))
    review_report = (staging / "reports" / "review.md").read_text(encoding="utf-8")
    assert all(
        heading in review_report
        for heading in (
            "# Review Report",
            "## Coverage",
            "## Exclusions",
            "## Changed Claims",
            "## Concept Changes",
            "## Verification Findings",
            "## Bundle Diff",
        )
    )
    assert status_before["review"]["state"] == "review_required"
    assert status_before["review"]["report"] == "reports/review.md"
    assert status_before["review"]["blocking_findings"] == []
    assert status_before["review"]["knowledge_changes"] == {
        "claims": {"added": [], "changed": [], "excluded": [], "removed": []},
        "concepts": {"added": [], "changed": [], "excluded": [], "removed": []},
    }

    checked = run(["check", run_id], workspace)
    assert checked["errors"] == []
    assert checked["ok"] is True
    assert checked["target"] == run_id
    assert checked["review"] == status_before["review"]
    assert run(["status", run_id], workspace)["events"] == status_before["events"]

    approved = run(["review", run_id, "--approve"], workspace)
    assert approved["ok"] is True
    assert approved["state"] == "published"
    assert (workspace / "published" / "overview.md").read_text(encoding="utf-8") == (
        staging / "overview.md"
    ).read_text(encoding="utf-8")
    assert run(["check", str(workspace / "published")], workspace)["ok"] is True


def test_published_revision_refresh_relocates_unchanged_knowledge(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    first_revision = make_java_source(source)
    first = build_run(workspace, source, first_revision)
    first_status = run(["status", first["run_id"]], workspace)
    run(["review", first["run_id"], "--approve"], workspace)

    second_revision = move_java_evidence(source)
    second = build_run(workspace, source, second_revision)
    second_status = run(["status", second["run_id"]], workspace)

    assert second_status["base_run_id"] == first["run_id"]
    assert second_status["refresh"]["mode"] == "incremental"
    assert second_status["refresh"]["fallback_reason"] is None
    assert any(
        item["before"]["path"] == "src/OrderRequest.java"
        and item["after"]["path"] == "src/api/OrderRequest.java"
        for item in second_status["refresh"]["diff"]["moved"]
    )
    assert [item["id"] for item in second_status["accepted_knowledge"]] == [
        item["id"] for item in first_status["accepted_knowledge"]
    ]
    assert [item["page"] for item in second_status["accepted_knowledge"]] == [
        item["page"] for item in first_status["accepted_knowledge"]
    ]
    rendered = Path(
        second_status["staging_bundle"], second_status["accepted_knowledge"][0]["page"]
    ).read_text(encoding="utf-8")
    assert "src/api/OrderRequest.java" in rendered
    assert second_revision in rendered
    assert second_status["review"]["knowledge_changes"]["claims"]["removed"] == []
    assert second_status["review"]["knowledge_changes"]["concepts"]["removed"] == []
    assert run(["check", second["run_id"]], workspace)["ok"] is True
    assert run(["review", second["run_id"], "--approve"], workspace)["state"] == "published"
    assert second_revision in (workspace / "published" / "overview.md").read_text(encoding="utf-8")


def test_refresh_keeps_removed_evidence_knowledge_stale_for_review(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    first_revision = make_java_source(source)
    first = build_run(workspace, source, first_revision)
    run(["review", first["run_id"], "--approve"], workspace)

    removed_revision = remove_java_evidence(source)
    refreshed = build_run(workspace, source, removed_revision, expected=1)
    status = run(["status", refreshed["run_id"]], workspace)

    assert status["state"] == "exploring"
    assert status["refresh"]["reverify_claims"]
    assert status["refresh"]["reverify_concepts"]
    assert status["accepted_knowledge"][0]["status"] == "stale"
    reverify = next(
        item for item in status["obligations"] if item["kind"] == "impact_reverification"
    )
    assert reverify["disposition"] == "open"
    assert reverify["reverify_claim_ids"] == status["refresh"]["reverify_claims"]
    assert removed_revision not in (workspace / "published" / "overview.md").read_text(
        encoding="utf-8"
    )


def test_new_source_units_create_open_obligations(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    first_revision = make_source(source)
    first = build_run(workspace, source, first_revision)
    run(["review", first["run_id"], "--approve"], workspace)
    (source / "requirements.md").write_text(
        "# Requirements\n\nREQ-1 Orders MUST be retained.\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "requirements.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "add requirement"], cwd=source, check=True)

    refreshed = build_run(workspace, source, head_revision(source), expected=1)
    status = run(["status", refreshed["run_id"]], workspace)

    assert status["state"] == "exploring"
    assert status["coverage"]["open"] == 3
    assert status["refresh"]["new_source_units"]
    assert {item["disposition"] for item in status["obligations"]} == {"open"}


def test_new_source_unit_in_covered_file_gets_its_own_obligation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    first_revision = make_source(source, "# Requirements\n\nREQ-1 Orders MUST be retained.\n")
    first = build_run(workspace, source, first_revision)
    run(["review", first["run_id"], "--approve"], workspace)
    (source / "README.md").write_text(
        "# Requirements\n\nREQ-1 Orders MUST be retained.\n\n# Notes\n\nBackground context.\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "add notes"], cwd=source, check=True)

    refreshed = build_run(workspace, source, head_revision(source), expected=1)
    status = run(["status", refreshed["run_id"]], workspace)
    notes = next(unit for unit in status["source_universe"] if unit.get("heading") == "Notes")
    added = [item for item in status["obligations"] if item["kind"] == "new_source_unit"]

    assert [item["source_unit"] for item in added] == [notes["source_unit"]]
    assert added[0]["disposition"] == "open"


def test_ambiguous_impact_uses_full_analysis_and_publication_gates(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    make_source(source)
    for name in ("one.txt", "two.txt"):
        (source / name).write_text("duplicate\n", encoding="utf-8")
    subprocess.run(["git", "add", "one.txt", "two.txt"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "duplicates"], cwd=source, check=True)
    first_revision = head_revision(source)
    first = build_run(workspace, source, first_revision)
    run(["review", first["run_id"], "--approve"], workspace)
    subprocess.run(["git", "mv", "one.txt", "three.txt"], cwd=source, check=True)
    subprocess.run(["git", "mv", "two.txt", "four.txt"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "ambiguous moves"], cwd=source, check=True)

    refreshed = build_run(workspace, source, head_revision(source), expected=1)
    status = run(["status", refreshed["run_id"]], workspace)

    assert status["refresh"]["mode"] == "full"
    assert status["refresh"]["fallback_reason"] == "Source Unit relocation is ambiguous"
    assert status["state"] == "exploring"
    assert status["coverage"]["open"]
    assert status["refresh"]["diff"]["by_source"]["source"]["added"]
    assert run(["review", refreshed["run_id"], "--approve"], workspace, expected=1)["ok"] is False


def test_full_fallback_preserves_prior_knowledge_stale_until_reverification(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_java_source(source)
    first = build_run(workspace, source, revision)
    first_status = run(["status", first["run_id"]], workspace)
    run(["review", first["run_id"], "--approve"], workspace)
    config = write_config(workspace, source, revision)
    config.write_text(
        config.read_text()
        + """
[profile.priorities]
java_type = "supporting"
""",
        encoding="utf-8",
    )

    refreshed = run(["build", str(config)], workspace, expected=1)
    status = run(["status", refreshed["run_id"]], workspace)

    assert status["refresh"]["mode"] == "full"
    assert status["refresh"]["fallback_reason"] == "Producer Profile changed"
    assert [item["id"] for item in status["accepted_knowledge"]] == [
        item["id"] for item in first_status["accepted_knowledge"]
    ]
    assert {item["status"] for item in status["accepted_knowledge"]} == {"stale"}
    assert any(item["kind"] == "impact_reverification" for item in status["obligations"])
    assert status["state"] == "exploring"


def test_incompatible_source_sets_still_report_added_and_removed_units(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    original = tmp_path / "original"
    replacement = tmp_path / "replacement"
    original_revision = make_source(original)
    first = build_run(workspace, original, original_revision)
    run(["review", first["run_id"], "--approve"], workspace)
    replacement_revision = make_source(replacement, "# Replacement\n\nNew source.\n")
    config = write_source_set_config(
        workspace,
        [
            {
                "id": "replacement",
                "role": "implementation",
                "repository": str(replacement),
                "revision": replacement_revision,
            }
        ],
    )

    refreshed = run(["build", str(config)], workspace, expected=1)
    status = run(["status", refreshed["run_id"]], workspace)

    assert status["refresh"]["fallback_reason"] == "Published Source Set is incompatible"
    assert status["refresh"]["diff"]["by_source"]["source"]["removed"]
    assert status["refresh"]["diff"]["by_source"]["replacement"]["added"]


def test_supporting_open_obligation_remains_in_exploration(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source, "# Reference\n\n| Name | Meaning |\n|---|---|\n| A | B |\n")
    config = write_config(workspace, source, revision)
    config.write_text(
        config.read_text()
        + """
[profile.dispositions.supporting]
disposition = "open"
""",
        encoding="utf-8",
    )

    built = run(["build", str(config)], workspace, expected=1)
    status = run(["status", built["run_id"]], workspace)

    assert status["coverage"]["supporting"] == 1
    assert status["coverage"]["open"] == 1
    assert status["state"] == "exploring"


def test_explore_command_dispatches_run_id(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(cli, "explore", lambda run_id: seen.append(run_id) or 7)
    monkeypatch.setattr(sys, "argv", ["okf-wiki", "explore", "run-7"])

    assert cli.main() == 7
    assert seen == ["run-7"]


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
        "state": "exploring",
    }
    rejected_status = run(["status", rejected["run_id"]], workspace)
    assert rejected_status["state"] == "exploring"
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


def test_review_rejects_edits_to_derived_markdown(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    overview = Path(status["staging_bundle"], "overview.md")
    overview.write_text(
        overview.read_text(encoding="utf-8") + "\nReviewer edit.\n", encoding="utf-8"
    )

    checked = run(["check", built["run_id"]], workspace, expected=1)
    assert any("authoritative rendering" in error for error in checked["errors"])
    approval = run(["review", built["run_id"], "--approve"], workspace, expected=1)
    assert approval["state"] == "failed"
    assert not (workspace / "published").exists()


def test_review_report_and_machine_state_include_persisted_verification_findings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    built = build_run(workspace, source, revision)
    run_id = built["run_id"]
    run(["review", run_id, "--reject"], workspace)
    database = workspace / ".okf-wiki" / "runs.db"
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        with connection:
            connection.execute(
                "UPDATE coverage_obligations SET disposition = 'covered' WHERE run_id = ?",
                (run_id,),
            )
            refresh_run_coverage(connection, run_id)
        transition(connection, run_id, "exploring", "verifying")
    store = VerificationStore(database)
    store.stage(run_id, "candidate-review", "task-review", {})
    finding = VerificationFinding(
        target_id="candidate-review",
        perspective="contradiction",
        verdict="disputed",
        severity="warning",
        evidence=("claim:one",),
        rationale="Requirements and implementation disagree.",
    )
    store.record_findings(run_id, "candidate-review", (finding,))
    store.record_decision(
        run_id,
        "candidate-review",
        AcceptanceDecision(outcome="review_required", reasons=("disputed knowledge",)),
    )
    monkeypatch.chdir(workspace)

    cli.finish_run(run_id)

    status = run(["status", run_id], workspace)
    assert status["review"]["verification_findings"][0]["rationale"] == finding.rationale
    assert status["review"]["blocking_findings"] == [
        "candidate-review:contradiction:disputed:warning"
    ]
    assert run(["check", run_id], workspace)["review"] == status["review"]
    report = Path(status["staging_bundle"], status["review"]["report"]).read_text(encoding="utf-8")
    assert finding.rationale in report
    approved = run(["review", run_id, "--approve"], workspace)
    assert approved["state"] == "published"
    published_status = run(["status", run_id], workspace)
    assert published_status["review"]["blocking_findings"] == []
    publishing_event = next(
        event for event in published_status["events"] if event["state"] == "publishing"
    )
    assert publishing_event["details"] == {
        "decision": "approved",
        "resolved_findings": ["candidate-review:contradiction:disputed:warning"],
    }


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

    assert run(["check", status["staging_bundle"]], workspace)["ok"] is True


def test_coverage_counts_must_be_nonnegative_and_complete(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source, "# Requirements\n\nREQ-1 Orders MUST be paid.\n")
    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    coverage = Path(status["staging_bundle"]) / "reports" / "coverage.md"
    coverage.write_text(
        coverage.read_text(encoding="utf-8")
        .replace("major_obligations: 2", "major_obligations: 9")
        .replace("covered_obligations: 2", "covered_obligations: 9"),
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


def test_markdown_obligations_are_durable_stable_and_gate_publication(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    implementation = tmp_path / "implementation"
    requirements = tmp_path / "requirements"
    implementation_revision = make_source(
        implementation, "Service | Notes\n---\n\nImplementation.\n"
    )
    requirements_revision = make_source(
        requirements,
        "# Glossary\n\n"
        "Order: A purchase request.\n\n"
        "REQ-1 Orders must be paid.\n\n"
        "## Acceptance Criteria\n\n"
        "- Payment is accepted.\n\n"
        "| State | Meaning |\n"
        "| --- | --- |\n"
        "| paid | Payment received |\n",
    )
    sources = [
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
    ]
    priorities = """
[profile.priorities]
numbered_requirement = "major"
acceptance_criterion = "major"
normative_statement = "major"
table = "supporting"
glossary_definition = "major"
"""
    config = write_source_set_config(
        workspace,
        sources,
        priorities
        + """
[profile.dispositions.major]
disposition = "covered"

[profile.dispositions.supporting]
disposition = "covered"
""",
    )

    built = run(["build", str(config)], workspace)
    status = run(["status", built["run_id"]], workspace)
    assert status["state"] == "review_required"
    assert {obligation["kind"] for obligation in status["obligations"]} == {
        "acceptance_criterion",
        "glossary_definition",
        "normative_statement",
        "numbered_requirement",
        "table",
    }
    assert status["coverage"]["total"] == 5
    assert status["coverage"]["by_source"] == {
        "requirements": {"dispositions": {"covered": 5}, "total": 5},
        "service": {"dispositions": {}, "total": 0},
    }
    assert status["coverage"]["by_role"] == {
        "implementation": {"dispositions": {}, "total": 0},
        "requirements": {"dispositions": {"covered": 5}, "total": 5},
    }
    assert status["coverage"]["by_priority"] == {
        "major": {"dispositions": {"covered": 4}, "total": 4},
        "supporting": {"dispositions": {"covered": 1}, "total": 1},
    }
    assert [source["id"] for source in status["sources"]] == ["requirements", "service"]
    sections = {
        unit["source_unit"]
        for unit in status["source_universe"]
        if unit["source_unit_kind"] == "markdown_section"
    }
    assert len(sections) == 3
    assert all(re.fullmatch(r"section:[0-9a-f]{64}", unit) for unit in sections)
    assert all(obligation["source_unit"] in sections for obligation in status["obligations"])

    database = workspace / ".okf-wiki" / "runs.db"
    with sqlite3.connect(database) as connection:
        durable = connection.execute(
            "SELECT id, source_unit, kind FROM coverage_obligations WHERE run_id = ? ORDER BY id",
            (built["run_id"],),
        ).fetchall()
    assert len(durable) == 5
    assert {row[2] for row in durable} == {item["kind"] for item in status["obligations"]}

    staging = Path(status["staging_bundle"])
    coverage = (staging / "reports" / "coverage.md").read_text(encoding="utf-8")
    assert "By Source" in coverage
    assert "By Role" in coverage
    assert "By Priority" in coverage
    assert "requirements" in coverage and "supporting" in coverage
    assert implementation_revision in coverage and requirements_revision in coverage

    repeated = run(["build", str(config)], workspace)
    repeated_status = run(["status", repeated["run_id"]], workspace)
    assert repeated_status["producer_profile_id"] == status["producer_profile_id"]
    assert {item["id"] for item in repeated_status["obligations"]} == {
        item["id"] for item in status["obligations"]
    }
    assert {
        unit["source_unit"]
        for unit in repeated_status["source_universe"]
        if unit["source_unit_kind"] == "markdown_section"
    } == sections

    run(["review", built["run_id"], "--approve"], workspace)
    assert run(["check", str(workspace / "published")], workspace)["ok"] is True

    blocked_config = write_source_set_config(
        workspace,
        sources,
        priorities
        + """
[profile.dispositions.major]
disposition = "open"

[profile.dispositions.supporting]
disposition = "covered"
""",
    )
    blocked = run(["build", str(blocked_config)], workspace, expected=1)
    blocked_status = run(["status", blocked["run_id"]], workspace)
    assert blocked["blocked"] is True
    assert blocked_status["state"] == "exploring"
    assert blocked_status["coverage"]["by_priority"]["major"] == {
        "dispositions": {"open": 4},
        "total": 4,
    }
    assert blocked_status["producer_profile_id"].startswith("profile:")
    assert blocked_status["producer_profile_id"] != status["producer_profile_id"]

    deferred_config = write_source_set_config(
        workspace,
        sources,
        priorities
        + """
[profile.dispositions.major]
disposition = "covered"

[profile.dispositions.supporting]
disposition = "deferred"
reason = "Document the table later"
""",
    )
    deferred = run(["build", str(deferred_config)], workspace)
    deferred_status = run(["status", deferred["run_id"]], workspace)
    assert deferred_status["coverage"]["by_priority"]["supporting"] == {
        "dispositions": {"deferred": 1},
        "total": 1,
    }
    assert "Document the table later" in Path(
        deferred_status["staging_bundle"], "reports", "coverage.md"
    ).read_text(encoding="utf-8")
    assert run(["review", deferred["run_id"], "--approve"], workspace)["state"] == "published"

    for disposition, priority, reason in [
        ("excluded", "major", ""),
        ("deferred", "supporting", ""),
        ("deferred", "major", "later"),
    ]:
        invalid = write_source_set_config(
            workspace,
            sources,
            priorities
            + f"""
[profile.dispositions.{priority}]
disposition = "{disposition}"
reason = "{reason}"
""",
        )
        result = run(["build", str(invalid)], workspace, expected=1)
        assert any("reason" in error or "Supporting" in error for error in result["errors"])


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
    assert status["coverage"]["total"] == 1
    assert status["coverage"]["covered"] == 1
    assert status["coverage"]["major"] == 1
    assert status["coverage"]["open"] == 0
    assert {source["id"]: source["coverage"]["major"] for source in status["sources"]} == {
        "requirements": 0,
        "service": 1,
    }
    assert {(entry["source_id"], entry["path"]) for entry in status["source_universe"]} == {
        ("requirements", "README.md"),
        ("service", "Service.java"),
    }
    assert [item["source_id"] for item in status["evidence"]] == ["requirements", "service"]
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
    assert [
        (entry["source_id"], entry["path"])
        for entry in first_status["source_universe"]
        if entry["source_unit_kind"] == "file"
    ] == [("source", ".gitignore"), ("source", "README.md")]
    assert first_status["coverage"]["total"] == 0
    assert first_status["coverage"]["open"] == 0
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


def test_java_data_carriers_are_aggregated_and_constraints_stay_visible(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    implementation = tmp_path / "implementation"
    requirements = tmp_path / "requirements"
    make_source(implementation)
    (implementation / "README.md").unlink()
    java = implementation / "src" / "main" / "java" / "example"
    java.mkdir(parents=True)
    (implementation / "pom.xml").write_text("<project><artifactId>orders</artifactId></project>\n")
    (java / "OrderController.java").write_text(
        "package example;\n"
        "@RestController\n"
        "final class OrderController {\n"
        '  @PostMapping("/orders")\n'
        "  OrderResponse create(@Valid CreateOrderRequest request, SecuredPayload auth, "
        "DomainRequest command, StatefulResponse state, BehaviorDto behavior, "
        "LegacyPayload legacy) { return null; }\n"
        "}\n"
    )
    for index in range(14):
        name = (
            "CreateOrderRequest"
            if index == 0
            else ("OrderResponse" if index == 1 else f"Line{index}Dto")
        )
        annotation = "  @NotBlank String customer;\n" if index == 0 else "  String value;\n"
        (java / f"{name}.java").write_text(
            f"package example;\nrecord {name}(String value) {{\n{annotation}}}\n"
        )
    (java / "SecuredPayload.java").write_text(
        "package example;\n"
        '@RolesAllowed("admin")\n'
        "record SecuredPayload(String token) {\n"
        '  @JsonProperty("access_token") String token() { return token; }\n'
        "}\n"
    )
    (java / "DomainRequest.java").write_text(
        "package example;\n"
        "record DomainRequest(String value) implements OrderCommand {}\n"
        "interface OrderCommand {}\n"
    )
    (java / "StatefulResponse.java").write_text(
        "package example;\n"
        "record StatefulResponse(Status status) { enum Status { OPEN, CLOSED } }\n"
    )
    (java / "BehaviorDto.java").write_text(
        "package example;\n"
        "final class BehaviorDto {\n"
        "  int amount;\n"
        "  int total() { return amount * 2; }\n"
        "}\n"
    )
    (java / "LegacyPayload.java").write_text(
        "package example;\nrecord LegacyPayload(String value) implements java.io.Serializable {}\n"
    )
    generated = implementation / "target" / "generated-sources"
    generated.mkdir(parents=True)
    (generated / "GeneratedDto.java").write_text("record GeneratedDto(String value) {}\n")
    subprocess.run(["git", "add", "-A"], cwd=implementation, check=True)
    subprocess.run(["git", "commit", "-qm", "java fixture"], cwd=implementation, check=True)
    implementation_revision = head_revision(implementation)
    requirements_revision = make_source(
        requirements, "# Orders\n\nREQ-1 Orders MUST accept a customer.\n"
    )
    config = write_source_set_config(
        workspace,
        [
            {
                "id": "orders",
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
    java_units = [
        unit for unit in status["source_universe"] if unit["source_unit_kind"].startswith("java_")
    ]
    assert {unit["source_unit_kind"] for unit in java_units} >= {
        "java_annotation",
        "java_manifest",
        "java_method",
        "java_package",
        "java_type",
    }
    controller = next(
        unit
        for unit in java_units
        if unit["source_unit_kind"] == "java_type" and unit.get("name") == "OrderController"
    )
    assert (controller["java_role"], controller["priority"]) == ("controller", "major")
    secured = next(
        unit
        for unit in java_units
        if unit["source_unit_kind"] == "java_type" and unit.get("name") == "SecuredPayload"
    )
    assert (secured["java_role"], secured["priority"], secured["promoted"]) == (
        "data_carrier",
        "major",
        True,
    )
    promoted = {
        unit["name"]: unit["promotion_reasons"]
        for unit in java_units
        if unit["source_unit_kind"] == "java_type" and unit.get("promoted")
    }
    assert "domain_interface" in promoted["DomainRequest"]
    assert "state" in promoted["StatefulResponse"]
    assert "non_trivial_behavior" in promoted["BehaviorDto"]
    assert promoted["LegacyPayload"] == ["serialization"]
    exclusion = next(
        obligation for obligation in status["obligations"] if obligation["kind"] == "java_exclusion"
    )
    assert exclusion["disposition"] == "excluded"
    assert "generated" in exclusion["reason"].casefold()

    java_types = [unit for unit in java_units if unit["source_unit_kind"] == "java_type"]
    java_major = [
        obligation
        for obligation in status["obligations"]
        if obligation["source"] == "orders" and obligation["priority"] == "major"
    ]
    assert len(java_major) < len(java_types) / 2
    contract = next(
        obligation for obligation in status["obligations"] if obligation["kind"] == "data_contract"
    )
    assert contract["data_carriers"] == [
        "BehaviorDto",
        "CreateOrderRequest",
        "DomainRequest",
        "LegacyPayload",
        "OrderResponse",
        "SecuredPayload",
        "StatefulResponse",
    ]
    assert "NotBlank" in contract["constraints"]
    assert {"JsonProperty", "RolesAllowed"} <= set(contract["constraints"])
    assert {"domain_interface", "state", "non_trivial_behavior"} <= set(
        contract["promotion_reasons"]
    )
    assert contract["carrier_promotion_reasons"]["LegacyPayload"] == ["serialization"]
    assert contract["data_contract_name"] == "OrderController Data Contract"
    assert not any(unit["source_unit_kind"] == "java_data_contract" for unit in java_units)
    assert [concept["canonical_name"] for concept in status["accepted_knowledge"]] == [
        "OrderController Data Contract"
    ]
    contract_page = next(
        concept["page"]
        for concept in status["accepted_knowledge"]
        if concept["canonical_name"] == "OrderController Data Contract"
    )
    page = Path(status["staging_bundle"], contract_page).read_text(encoding="utf-8")
    assert "CreateOrderRequest" in page
    assert "OrderResponse" in page
    assert "NotBlank" in page
    assert "RolesAllowed" in page
    assert "domain_interface" in page
    assert "state" in page
    assert "non_trivial_behavior" in page
    assert "id: concept:" in page
    for claim_id in status["accepted_knowledge"][0]["defining_claim_ids"]:
        assert f"<!-- claims: {claim_id} -->" in page
    review = status["review"]
    assert (
        review["knowledge_changes"]["claims"]["added"]
        == status["accepted_knowledge"][0]["defining_claim_ids"]
    )
    assert review["knowledge_changes"]["concepts"]["added"] == [
        status["accepted_knowledge"][0]["id"]
    ]
    assert contract_page in review["bundle_diff"]["added"]
    review_report = Path(status["staging_bundle"], review["report"]).read_text(encoding="utf-8")
    assert exclusion["id"] in review_report
    assert status["accepted_knowledge"][0]["id"] in review_report
    assert status["accepted_knowledge"][0]["defining_claim_ids"][0] in review_report
    assert contract_page in review_report
    markers = re.findall(r"<!-- claims: claim:[0-9a-f]{64} -->", page)
    without_markers = re.sub(r"\n\n<!-- claims: claim:[0-9a-f]{64} -->", "", page)
    tampered = without_markers + "\n\n" + "\n\n".join(markers) + "\n"
    Path(status["staging_bundle"], contract_page).write_text(tampered, encoding="utf-8")
    grounding = run(["check", status["staging_bundle"]], workspace, expected=1)
    assert any("factual paragraphs" in error for error in grounding["errors"])
    Path(status["staging_bundle"], contract_page).write_text(page, encoding="utf-8")
    overview = Path(status["staging_bundle"], "overview.md").read_text(encoding="utf-8")
    assert "tracked source file(s)" in overview

    universe = {unit["source_unit"]: unit for unit in status["source_universe"]}
    knowledge = AcceptedKnowledgeStore(workspace / ".okf-wiki" / "runs.db")
    for concept in status["accepted_knowledge"]:
        for claim_id in concept["defining_claim_ids"]:
            claim = knowledge.get_claim(built["run_id"], claim_id)
            assert claim is not None
            for evidence in claim["evidence"]:
                source_unit = universe[evidence["source_unit"]]
                assert evidence["digest"] == f"sha256:{source_unit['content_digest']}"
                assert source_unit["source_unit_kind"] != "java_data_contract"
    run(["review", built["run_id"], "--reject"], workspace)
    rejected = run(["status", built["run_id"]], workspace)
    assert rejected["accepted_knowledge"] == []
    assert {item["disposition"] for item in rejected["obligations"]} == {"open"}
    assert knowledge.list_claims(built["run_id"]) == []
    assert knowledge.list_concepts(built["run_id"]) == []


def test_java_exclusions_and_priorities_are_resolved_from_the_producer_profile(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    revision = make_source(source)
    (source / "README.md").unlink()
    (source / "pom.xml").write_text("<project/>\n")
    vendor = source / "third_party" / "acme"
    vendor.mkdir(parents=True)
    (vendor / "VendorDto.java").write_text("record VendorDto(String value) {}\n")
    generated = source / "target" / "generated-sources"
    generated.mkdir(parents=True)
    (generated / "GeneratedDto.java").write_text("record GeneratedDto(String value) {}\n")
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "profile rules"], cwd=source, check=True)
    revision = head_revision(source)
    config = write_source_set_config(
        workspace,
        [
            {
                "id": "source",
                "role": "implementation",
                "repository": str(source),
                "revision": revision,
            }
        ],
        """
[profile]
java_excluded_paths = ["third_party/**"]

[profile.priorities]
java_manifest = "supporting"
""",
    )

    built = run(["build", str(config)], workspace)
    status = run(["status", built["run_id"]], workspace)
    exclusion = next(item for item in status["obligations"] if item["kind"] == "java_exclusion")
    assert exclusion["matched_rule"] == "third_party/**"
    assert "third_party/**" in exclusion["reason"]
    assert not any(
        item["kind"] == "java_exclusion" and "GeneratedDto" in item["text"]
        for item in status["obligations"]
    )
    manifest = next(item for item in status["obligations"] if item["kind"] == "java_manifest")
    assert manifest["priority"] == "supporting"


def test_java_type_spans_ignore_braces_in_comments_and_literals(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    make_source(source)
    (source / "README.md").unlink()
    (source / "BraceController.java").write_text(
        "package example;\n"
        "@RestController\n"
        "final class BraceController {\n"
        '  String json = "}";\n'
        "  /* } is data, not structure */\n"
        "  @PostMapping\n"
        "  Response handle(Request request) { return null; }\n"
        "}\n"
        "record Request(String value) {}\n"
        "record Response(String value) {}\n"
    )
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "brace fixture"], cwd=source, check=True)
    revision = head_revision(source)

    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    units = status["source_universe"]
    controller = next(unit for unit in units if unit.get("name") == "BraceController")
    method = next(
        unit
        for unit in units
        if unit["source_unit_kind"] == "java_method" and unit["name"] == "handle"
    )
    annotation = next(
        unit
        for unit in units
        if unit["source_unit_kind"] == "java_annotation" and unit["name"] == "PostMapping"
    )
    assert controller["span"] == {"start_line": 2, "end_line": 8}
    assert (
        controller["span"]["start_line"]
        <= method["span"]["start_line"]
        <= controller["span"]["end_line"]
    )
    assert (
        controller["span"]["start_line"]
        <= annotation["span"]["start_line"]
        <= controller["span"]["end_line"]
    )


def test_java_inventory_covers_load_bearing_roles_and_declarations(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "source"
    make_source(source)
    (source / "README.md").unlink()
    files = {
        "src/main/java/module-info.java": "module example.orders { exports example; }\n",
        "src/main/java/example/OrderHandler.java": (
            "package example;\n@RestController\nfinal class OrderHandler {\n"
            "  @PostMapping void handle() {}\n}\n"
        ),
        "src/main/java/example/OrderService.java": (
            "package example;\n@Service\nfinal class OrderService { void place() {} }\n"
        ),
        "src/main/java/example/domain/Order.java": (
            "package example.domain;\nfinal class Order { void pay() {} }\n"
        ),
        "src/main/java/example/OrderState.java": (
            "package example;\nenum OrderState { OPEN, PAID }\n"
        ),
        "src/main/java/example/AccessSecurity.java": (
            "package example;\n@EnableWebSecurity\nfinal class AccessSecurity {}\n"
        ),
        "src/main/java/example/AppConfiguration.java": (
            "package example;\n@Configuration\nfinal class AppConfiguration {}\n"
        ),
        "src/main/java/example/OrderRepository.java": (
            "package example;\n@Repository\ninterface OrderRepository { Order load(); }\n"
        ),
    }
    for relative, content in files.items():
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "role fixture"], cwd=source, check=True)
    revision = head_revision(source)

    built = build_run(workspace, source, revision)
    status = run(["status", built["run_id"]], workspace)
    units = status["source_universe"]
    roles = {
        unit["name"]: unit["java_role"] for unit in units if unit["source_unit_kind"] == "java_type"
    }
    assert {
        "AccessSecurity": "security",
        "AppConfiguration": "configuration",
        "Order": "domain",
        "OrderHandler": "controller",
        "OrderRepository": "persistence",
        "OrderService": "service",
        "OrderState": "state_machine",
    }.items() <= roles.items()
    assert all(
        unit["priority"] == "major"
        for unit in units
        if unit["source_unit_kind"] == "java_type" and unit["name"] in roles
    )
    assert any(unit["source_unit_kind"] == "java_module" for unit in units)
    assert any(unit["source_unit_kind"] == "java_method" for unit in units)
    assert any(unit["source_unit_kind"] == "java_annotation" for unit in units)
