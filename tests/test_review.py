import hashlib
import json
import sqlite3
import subprocess
import time
from pathlib import Path

from okf_wiki.verification import VerificationFinding, VerificationStore
from okf_wiki.workspace import WorkspaceApplication


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def review_application(tmp_path: Path) -> tuple[WorkspaceApplication, str, str, str]:
    repository = tmp_path / "source"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "fixture@example.test")
    git(repository, "config", "user.name", "Fixture")
    (repository / "README.md").write_text("# Base\n")
    git(repository, "add", "README.md")
    git(repository, "commit", "-m", "base")
    base_revision = git(repository, "rev-parse", "HEAD")
    (repository / "README.md").write_text(
        "# Current\n\nSecurity credential handling MUST remain deterministic.\n"
    )
    git(repository, "add", "README.md")
    git(repository, "commit", "-m", "current")
    current_revision = git(repository, "rev-parse", "HEAD")

    application = WorkspaceApplication(tmp_path / "workspace")
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
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if application.run_status(started["run_id"])["state"] == "review_required":
            return application, started["run_id"], base_revision, current_revision
        time.sleep(0.05)
    raise AssertionError("Production Run did not reach Review Required")


def add_base_run(
    application: WorkspaceApplication,
    run_id: str,
    base_revision: str,
) -> str:
    base_run_id = "base-run"
    with sqlite3.connect(application.database_path) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        assert row is not None
        current_source_set = json.loads(row["source_set_json"])
        current_source_set["base_run_id"] = base_run_id
        base_source_set = json.loads(row["source_set_json"])
        base_source_set["base_run_id"] = None
        base_source_set["sources"][0]["revision"] = base_revision
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = ?",
            (json.dumps(current_source_set, sort_keys=True), run_id),
        )
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                coverage_json, error, created_at, updated_at, source_set_json)
               VALUES (?, ?, ?, ?, ?, ?, 'published', ?, NULL, ?, ?, ?)""",
            (
                base_run_id,
                row["project_id"],
                row["repository"],
                base_revision,
                row["publish_dir"],
                row["staging_dir"],
                row["coverage_json"],
                row["created_at"],
                row["updated_at"],
                json.dumps(base_source_set, sort_keys=True),
            ),
        )
    return base_run_id


def insert_claim(
    connection: sqlite3.Connection,
    run_id: str,
    claim_id: str,
    *,
    statement: str | None = None,
    status: str = "supported",
) -> None:
    connection.execute(
        "INSERT INTO accepted_claims VALUES (?, ?, ?, ?, ?, 'must', '[]', ?)",
        (run_id, claim_id, claim_id, "describes", statement or claim_id, status),
    )


def insert_concept(
    connection: sqlite3.Connection,
    run_id: str,
    concept_id: str,
    defining_claim_ids: tuple[str, ...],
    *,
    description: str | None = None,
    status: str = "active",
) -> None:
    connection.execute(
        "INSERT INTO accepted_concepts VALUES (?, ?, ?, '[]', ?, ?)",
        (run_id, concept_id, concept_id, description or concept_id, status),
    )
    connection.executemany(
        "INSERT INTO concept_claims VALUES (?, ?, ?, 'defining')",
        [(run_id, concept_id, claim_id) for claim_id in defining_claim_ids],
    )
    connection.execute(
        "INSERT INTO page_plans VALUES (?, ?, ?, ?)",
        (run_id, concept_id, f"concepts/{concept_id}.md", concept_id),
    )


def test_review_snapshot_uses_all_accepted_evidence_and_opens_it_by_id(tmp_path: Path) -> None:
    application, run_id, base_revision, current_revision = review_application(tmp_path)
    base_run_id = add_base_run(application, run_id, base_revision)
    records = (
        (base_run_id, "evidence:base-unclaimed", base_revision, "# Base"),
        (run_id, "evidence:current-unclaimed", current_revision, "# Current"),
    )
    with sqlite3.connect(application.database_path) as connection:
        for evidence_run_id, evidence_id, revision, text in records:
            connection.execute(
                """INSERT INTO accepted_evidence
                   VALUES (?, ?, 'code', ?, 'README.md', 'README.md#heading:1',
                           1, 1, ?, 'source', 'primary')""",
                (
                    evidence_run_id,
                    evidence_id,
                    revision,
                    f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                ),
            )
    store = VerificationStore(application.database_path)
    store.stage(
        run_id,
        "candidate-unclaimed-evidence",
        "task-unclaimed-evidence",
        {
            "evidence": [
                {
                    "id": "proposal-evidence",
                    "source_id": "code",
                    "revision": current_revision,
                    "path": "README.md",
                    "start_line": 1,
                    "end_line": 1,
                    "digest": f"sha256:{hashlib.sha256(b'# Current').hexdigest()}",
                }
            ]
        },
    )
    store.record_findings(
        run_id,
        "candidate-unclaimed-evidence",
        (
            VerificationFinding(
                target_id="candidate-unclaimed-evidence",
                perspective="evidence_entailment",
                verdict="pass",
                severity="info",
                evidence=("proposal-evidence",),
                rationale="The fixed-revision evidence is accepted independently of Claims.",
            ),
        ),
    )

    snapshot = application.review_snapshot(run_id)
    finding = next(
        item
        for item in snapshot["verification_findings"]
        if item["candidate_id"] == "candidate-unclaimed-evidence"
    )

    assert {item["id"] for item in snapshot["evidence_references"]} >= {
        "evidence:base-unclaimed",
        "evidence:current-unclaimed",
    }
    assert finding["evidence_reference_ids"] == ["evidence:current-unclaimed"]
    assert application.review_evidence(run_id, "evidence:base-unclaimed")["text"] == "# Base"
    assert application.review_evidence(run_id, "evidence:current-unclaimed")["text"] == (
        "# Current"
    )


def test_review_change_groups_are_relation_based_and_mutually_exclusive(tmp_path: Path) -> None:
    application, run_id, base_revision, _current_revision = review_application(tmp_path)
    base_run_id = add_base_run(application, run_id, base_revision)
    base_claims = {
        "claim:merge-a",
        "claim:merge-b",
        "claim:split",
        "claim:stale-a",
        "claim:stale-b",
        "claim:cross-a",
        "claim:cross-b",
        "claim:disputed",
        "claim:changed",
        "claim:removed",
        "claim:excluded",
    }
    current_claims = {
        *base_claims - {"claim:removed", "claim:excluded"},
        "claim:merged",
        "claim:split-a",
        "claim:split-b",
        "claim:stale-merged",
        "claim:cross-merged",
        "claim:cross-peer",
        "claim:added",
    }
    with sqlite3.connect(application.database_path) as connection:
        for table in (
            "page_plans",
            "concept_claims",
            "accepted_concepts",
            "claim_links",
            "obligation_claims",
            "claim_evidence",
            "accepted_claims",
        ):
            connection.execute(f"DELETE FROM {table} WHERE run_id IN (?, ?)", (run_id, base_run_id))
        for claim_id in sorted(base_claims):
            insert_claim(connection, base_run_id, claim_id)
        for claim_id in sorted(current_claims):
            insert_claim(
                connection,
                run_id,
                claim_id,
                statement="changed" if claim_id == "claim:changed" else None,
                status=(
                    "disputed"
                    if claim_id == "claim:disputed"
                    else "stale"
                    if claim_id == "claim:stale-merged"
                    else "supported"
                ),
            )
        connection.executemany(
            "INSERT INTO claim_links VALUES (?, ?, 'supersedes', ?)",
            [
                (run_id, "claim:merged", "claim:merge-a"),
                (run_id, "claim:merged", "claim:merge-b"),
                (run_id, "claim:split-a", "claim:split"),
                (run_id, "claim:split-b", "claim:split"),
                (run_id, "claim:stale-merged", "claim:stale-a"),
                (run_id, "claim:stale-merged", "claim:stale-b"),
                (run_id, "claim:cross-merged", "claim:cross-a"),
                (run_id, "claim:cross-merged", "claim:cross-b"),
                (run_id, "claim:cross-peer", "claim:cross-a"),
            ],
        )
        connection.execute(
            """INSERT INTO coverage_obligations
               (id, run_id, source, role, path, source_unit, kind, priority,
                disposition, reason, span, text)
               VALUES ('obligation:excluded', ?, 'code', 'implementation', 'README.md',
                       'README.md#heading:1', 'normative_statement', 'major', 'covered',
                       NULL, '{"start_line":1,"end_line":1}', 'Excluded requirement')""",
            (base_run_id,),
        )
        connection.execute(
            """INSERT INTO coverage_obligations
               (id, run_id, source, role, path, source_unit, kind, priority,
                disposition, reason, span, text)
               VALUES ('obligation:excluded', ?, 'code', 'implementation', 'README.md',
                       'README.md#heading:1', 'normative_statement', 'major', 'excluded',
                       'Explicitly out of scope', '{"start_line":1,"end_line":1}',
                       'Excluded requirement')""",
            (run_id,),
        )
        connection.execute(
            "INSERT INTO obligation_claims VALUES (?, 'obligation:excluded', 'claim:excluded')",
            (base_run_id,),
        )

        insert_concept(connection, base_run_id, "concept:merge-a", ("claim:merge-a",))
        insert_concept(connection, base_run_id, "concept:merge-b", ("claim:merge-b",))
        insert_concept(connection, base_run_id, "concept:split", ("claim:split",))
        insert_concept(connection, base_run_id, "concept:stale-a", ("claim:stale-a",))
        insert_concept(connection, base_run_id, "concept:stale-b", ("claim:stale-b",))
        insert_concept(connection, base_run_id, "concept:disputed", ("claim:disputed",))
        insert_concept(connection, base_run_id, "concept:changed", ("claim:changed",))
        insert_concept(connection, base_run_id, "concept:removed", ("claim:removed",))
        insert_concept(connection, base_run_id, "concept:excluded", ("claim:excluded",))

        insert_concept(
            connection,
            run_id,
            "concept:merged",
            ("claim:merge-a", "claim:merge-b"),
        )
        insert_concept(connection, run_id, "concept:split-a", ("claim:split",))
        insert_concept(connection, run_id, "concept:split-b", ("claim:split",))
        insert_concept(
            connection,
            run_id,
            "concept:stale-merged",
            ("claim:stale-a", "claim:stale-b"),
            status="stale",
        )
        insert_concept(
            connection,
            run_id,
            "concept:disputed",
            ("claim:disputed",),
            status="disputed",
        )
        insert_concept(
            connection,
            run_id,
            "concept:changed",
            ("claim:changed",),
            description="changed",
        )
        insert_concept(connection, run_id, "concept:added", ("claim:added",))

    changes = application.review_snapshot(run_id)["knowledge_changes"]

    def buckets_for(kind: str, item_id: str) -> list[str]:
        return [
            bucket
            for bucket, items in changes[kind].items()
            if item_id in {item["id"] for item in items}
        ]

    expected_claims = {
        "claim:disputed": "disputed",
        "claim:stale-merged": "stale",
        "claim:merged": "merged",
        "claim:cross-merged": "merged",
        "claim:cross-peer": "split",
        "claim:split-a": "split",
        "claim:split-b": "split",
        "claim:excluded": "excluded",
        "claim:added": "added",
        "claim:changed": "changed",
        "claim:removed": "removed",
    }
    expected_concepts = {
        "concept:disputed": "disputed",
        "concept:stale-merged": "stale",
        "concept:merged": "merged",
        "concept:split-a": "split",
        "concept:split-b": "split",
        "concept:excluded": "excluded",
        "concept:added": "added",
        "concept:changed": "changed",
        "concept:removed": "removed",
    }
    for item_id, bucket in expected_claims.items():
        assert buckets_for("claims", item_id) == [bucket]
    for item_id, bucket in expected_concepts.items():
        assert buckets_for("concepts", item_id) == [bucket]
    for kind in ("claims", "concepts"):
        grouped_ids = [item["id"] for items in changes[kind].values() for item in items]
        assert len(grouped_ids) == len(set(grouped_ids))
