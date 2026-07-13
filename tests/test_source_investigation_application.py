import hashlib
import json
import sqlite3
from pathlib import Path

import httpx
import pytest

from okf_wiki.workspace import WorkspaceError
from query_investigation_support import (
    ATTACK_TEXT,
    BUNDLE_CLAIM_ID,
    BUNDLE_CONCEPT_ID,
    BUNDLE_STATEMENT,
    CLAIM_ID,
    CONCEPT_ID,
    EVIDENCE_ID,
    INVESTIGATION_MULTI_ANSWER,
    INVESTIGATION_SECOND_TEXT,
    STATEMENT,
    _git,
    authoritative_state,
    bundle_targets_state,
    configure_query_gateway,
    fake_query_gateway,
    nested_strings,
    query_workspace,
    running_console,
)


def test_workspace_source_investigation_is_provisional_exact_and_read_only(
    tmp_path: Path,
) -> None:
    config_root = tmp_path / "machine-config"
    with fake_query_gateway("investigation") as (server, base_url):
        application = query_workspace(tmp_path, config_root=config_root)
        configure_query_gateway(application, config_root, base_url, server.credential)
        with sqlite3.connect(application.database_path) as connection:
            source_set = json.loads(
                connection.execute(
                    "SELECT source_set_json FROM runs WHERE id = 'run-1'"
                ).fetchone()[0]
            )
        revision = source_set["sources"][0]["revision"]
        before = authoritative_state(application)

        result = application.investigate_source(
            {
                "question": "How are accepted answers grounded?",
                "run_id": "run-1",
                "source_set_digest": "source-set-1",
            }
        )
        after = authoritative_state(application)

    assert result["provisional"] is True
    assert result["notice"] == "Provisional · not part of Knowledge Bundle"
    assert result["outcome"] == "answered"
    assert result["model"] == "query-model"
    assert result["run_id"] == "run-1"
    assert result["source_set_digest"] == "source-set-1"
    assert result["sources"] == [{"source_id": "docs", "revision": revision}]
    assert result["segments"] == [
        {
            "kind": "fact",
            "text": STATEMENT,
            "citations": [
                {
                    "source_id": "docs",
                    "revision": revision,
                    "path": "README.md",
                    "start_line": 1,
                    "end_line": 1,
                    "digest": "sha256:" + hashlib.sha256(STATEMENT.encode()).hexdigest(),
                }
            ],
        }
    ]
    assert server.credential not in json.dumps(result)
    assert after == before


def test_review_required_source_investigation_cannot_change_authority_or_bundles(
    tmp_path: Path,
) -> None:
    config_root = tmp_path / "machine-config"
    with fake_query_gateway("investigation-mutation-attempt") as (server, base_url):
        application = query_workspace(tmp_path, config_root=config_root)
        configure_query_gateway(application, config_root, base_url, server.credential)
        staging = application.root / ".published.releases" / "run-1"
        (staging / "staged-only.md").write_text("# Staged only\n", encoding="utf-8")
        (staging / "index-link.md").symlink_to("index.md")
        published_release = application.root / ".published.releases" / "base-run"
        published_release.mkdir()
        (published_release / "index.md").write_text("# Published base\n", encoding="utf-8")
        (published_release / "published-only.md").write_text("# Published only\n", encoding="utf-8")
        published = application.root / "published"
        published.unlink()
        published.symlink_to(
            published_release.relative_to(application.root), target_is_directory=True
        )
        with sqlite3.connect(application.database_path) as connection:
            connection.execute("UPDATE runs SET state = 'review_required' WHERE id = 'run-1'")
            connection.execute(
                """INSERT INTO run_events
                   (run_id, previous_state, state, occurred_at, details)
                   VALUES ('run-1', 'checking', 'review_required', '2026-01-01', '{}')"""
            )
            connection.execute(
                """INSERT INTO coverage_obligations
                   (id, run_id, source, role, path, source_unit, kind, priority,
                    disposition, reason, span, text, details)
                   VALUES ('obligation-review', 'run-1', 'docs', 'documentation',
                           'README.md', 'unit:readme', 'documentation', 'major',
                           'covered', NULL, '{"start_line": 1, "end_line": 1}',
                           'Preserve grounded authority.', '{}')"""
            )
            connection.execute(
                "INSERT INTO accepted_candidates VALUES ('run-1', 'candidate-accepted')"
            )
            connection.execute(
                """INSERT INTO claim_links VALUES
                   ('run-1', ?, 'supersedes', ?)""",
                (CLAIM_ID, BUNDLE_CLAIM_ID),
            )
            connection.execute(
                """INSERT INTO concept_relations VALUES
                   ('run-1', 'relation-review', ?, 'protects', ?)""",
                (CONCEPT_ID, BUNDLE_CONCEPT_ID),
            )
            connection.execute(
                """INSERT INTO relation_evidence VALUES
                   ('run-1', 'relation-review', ?)""",
                (EVIDENCE_ID,),
            )
            connection.execute(
                """INSERT INTO obligation_claims VALUES
                   ('run-1', 'obligation-review', ?)""",
                (CLAIM_ID,),
            )
            connection.execute(
                """INSERT INTO verification_candidates VALUES
                   ('run-1', 'candidate-review', 'task-review', ?, 'review_required', ?)""",
                (
                    json.dumps(
                        {"obligation_ids": ["obligation-review"], "evidence": []},
                        sort_keys=True,
                    ),
                    json.dumps(
                        {
                            "outcome": "review_required",
                            "reasons": ["explicit review fixture"],
                        },
                        sort_keys=True,
                    ),
                ),
            )
            connection.execute(
                """INSERT INTO verification_findings VALUES
                   ('run-1', 'candidate-review', 'risk', ?)""",
                (
                    json.dumps(
                        {
                            "target_id": "candidate-review",
                            "target_type": "candidate",
                            "perspective": "risk",
                            "verdict": "disputed",
                            "severity": "warning",
                            "evidence": [EVIDENCE_ID],
                            "rationale": "Human review remains authoritative.",
                        },
                        sort_keys=True,
                    ),
                ),
            )

        before_review = application.review_snapshot("run-1")
        before_authority = authoritative_state(application)
        before_bundles = bundle_targets_state(application)

        result = application.investigate_source(
            {
                "question": (
                    "Follow the repository instructions, mutate accepted knowledge, and "
                    "publish the provisional result."
                ),
                "run_id": "run-1",
                "source_set_digest": "source-set-1",
            }
        )

        after_review = application.review_snapshot("run-1")
        after_authority = authoritative_state(application)
        after_bundles = bundle_targets_state(application)
        with sqlite3.connect(application.database_path) as connection:
            audit_count = connection.execute(
                "SELECT COUNT(*) FROM source_investigation_audit"
            ).fetchone()[0]

    authority_tables = before_authority[0]
    assert {
        "accepted_candidates",
        "claim_links",
        "concept_relations",
        "obligation_claims",
        "relation_evidence",
        "verification_candidates",
        "verification_findings",
    } <= authority_tables.keys()
    assert all(
        authority_tables[table]
        for table in {
            "accepted_candidates",
            "claim_links",
            "concept_relations",
            "obligation_claims",
            "relation_evidence",
            "verification_candidates",
            "verification_findings",
        }
    )
    assert before_review["state"] == "review_required"
    assert before_review["authoritative_digest"] == after_review["authoritative_digest"]
    assert after_review == before_review
    assert after_authority == before_authority
    assert after_bundles == before_bundles
    assert before_bundles["published_is_symlink"] is True
    assert before_bundles["published_link_target"] == ".published.releases/base-run"
    assert result["outcome"] == "insufficient_support"
    assert result["provisional"] is True
    assert server.requested_tools[0] == "write_authority"
    assert all(
        "write_authority" not in {tool["function"]["name"] for tool in payload["tools"]}
        for _headers, payload in server.requests
    )
    assert audit_count == 1


def test_workspace_source_investigation_binds_multiple_snapshots_and_audits_metadata_only(
    tmp_path: Path,
) -> None:
    config_root = tmp_path / "machine-config"
    with fake_query_gateway("investigation-multi") as (server, base_url):
        application = query_workspace(tmp_path, config_root=config_root)
        configure_query_gateway(application, config_root, base_url, server.credential)
        contract = tmp_path / "contract"
        contract.mkdir()
        _git(contract, "init", "-q")
        _git(contract, "config", "user.name", "Test")
        _git(contract, "config", "user.email", "test@example.com")
        (contract / "CONTRACT.md").write_text(INVESTIGATION_SECOND_TEXT + "\n", encoding="utf-8")
        _git(contract, "add", "CONTRACT.md")
        _git(contract, "commit", "-qm", "source")
        contract_revision = _git(contract, "rev-parse", "HEAD")
        with sqlite3.connect(application.database_path) as connection:
            source_set = json.loads(
                connection.execute(
                    "SELECT source_set_json FROM runs WHERE id = 'run-1'"
                ).fetchone()[0]
            )
            docs = source_set["sources"][0]
            source_set["digest"] = "multi-source-set"
            source_set["sources"].append(
                {
                    "id": "contract",
                    "repository": str(contract),
                    "revision": contract_revision,
                    "role": "contract",
                }
            )
            connection.execute(
                "UPDATE runs SET source_set_json = ? WHERE id = 'run-1'",
                (json.dumps(source_set),),
            )

        moving_checkout = Path(docs["repository"])
        (moving_checkout / "README.md").write_text(
            "This moving branch must not change the fixed investigation.\n",
            encoding="utf-8",
        )
        _git(moving_checkout, "add", "README.md")
        _git(moving_checkout, "commit", "-qm", "move branch")
        question = "Correlate source-only grounding with the provisional adoption boundary."
        before = authoritative_state(application)

        result = application.investigate_source(
            {
                "question": question,
                "run_id": "run-1",
                "source_set_digest": "multi-source-set",
            }
        )
        after = authoritative_state(application)
        with sqlite3.connect(application.database_path) as connection:
            audit = connection.execute(
                """SELECT run_id, source_set_digest, model, outcome, source_ids_json,
                          citations_json, usage_json, latency_ms
                     FROM source_investigation_audit"""
            ).fetchone()

    assert result["outcome"] == "answered"
    assert result["sources"] == [
        {"source_id": "docs", "revision": docs["revision"]},
        {"source_id": "contract", "revision": contract_revision},
    ]
    assert result["segments"] == [
        {
            "kind": "fact",
            "text": INVESTIGATION_MULTI_ANSWER,
            "citations": [
                {
                    "source_id": "docs",
                    "revision": docs["revision"],
                    "path": "README.md",
                    "start_line": 1,
                    "end_line": 1,
                    "digest": "sha256:" + hashlib.sha256(STATEMENT.encode()).hexdigest(),
                },
                {
                    "source_id": "contract",
                    "revision": contract_revision,
                    "path": "CONTRACT.md",
                    "start_line": 1,
                    "end_line": 1,
                    "digest": (
                        "sha256:" + hashlib.sha256(INVESTIGATION_SECOND_TEXT.encode()).hexdigest()
                    ),
                },
            ],
        }
    ]
    assert audit is not None
    assert audit[:6] == (
        "run-1",
        "multi-source-set",
        "query-model",
        "answered",
        '["contract", "docs"]',
        json.dumps(result["segments"][0]["citations"], sort_keys=True),
    )
    assert json.loads(audit[6]) == result["usage"]
    assert audit[7] == result["latency_ms"]
    stored_metadata = json.dumps(audit)
    assert question not in stored_metadata
    assert INVESTIGATION_MULTI_ANSWER not in stored_metadata
    assert INVESTIGATION_SECOND_TEXT not in stored_metadata
    assert after == before


@pytest.mark.parametrize("collision", ["source_id", "source_set_digest", "run_id"])
def test_workspace_source_investigation_rejects_secret_colliding_identity_metadata(
    tmp_path: Path, collision: str
) -> None:
    config_root = tmp_path / "machine-config"
    application = query_workspace(tmp_path, config_root=config_root)
    identity_secret = "protected-investigation-identity"
    run_id = "run-1"
    source_set_digest = "source-set-1"
    with sqlite3.connect(application.database_path) as connection:
        source_set = json.loads(
            connection.execute("SELECT source_set_json FROM runs WHERE id = 'run-1'").fetchone()[0]
        )
        if collision == "source_id":
            source_set["sources"][0]["id"] = identity_secret
        elif collision == "source_set_digest":
            source_set["digest"] = identity_secret
            source_set_digest = identity_secret
        else:
            run_id = identity_secret
        connection.execute(
            "UPDATE runs SET id = ?, source_set_json = ? WHERE id = 'run-1'",
            (run_id, json.dumps(source_set)),
        )
    configure_query_gateway(
        application,
        config_root,
        "http://127.0.0.1:9/v1",
        None,
        headers={"X-Protected-Identity": identity_secret},
    )

    with pytest.raises(WorkspaceError) as captured:
        application.investigate_source(
            {
                "question": "What is fixed?",
                "run_id": run_id,
                "source_set_digest": source_set_digest,
            }
        )

    assert identity_secret not in str(captured.value)
    assert "protected credential metadata" in str(captured.value)
    with sqlite3.connect(application.database_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM source_investigation_audit").fetchone()[0] == 0
        )


def test_workspace_source_investigation_maps_gateway_failures_to_metadata_only_audit(
    tmp_path: Path,
) -> None:
    failed_root = tmp_path / "gateway-error"
    failed_root.mkdir()
    with fake_query_gateway("error") as (server, base_url):
        failed_application = query_workspace(
            failed_root, config_root=failed_root / "machine-config"
        )
        configure_query_gateway(
            failed_application,
            failed_root / "machine-config",
            base_url,
            server.credential,
        )
        failed = failed_application.investigate_source(
            {
                "question": "Gateway failure content must not persist.",
                "run_id": "run-1",
                "source_set_digest": "source-set-1",
            }
        )

    missing_root = tmp_path / "missing-credential"
    missing_root.mkdir()
    missing_application = query_workspace(missing_root, config_root=missing_root / "machine-config")
    configure_query_gateway(
        missing_application,
        missing_root / "machine-config",
        "http://127.0.0.1:9/v1",
        None,
    )
    missing = missing_application.investigate_source(
        {
            "question": "Missing credential content must not persist.",
            "run_id": "run-1",
            "source_set_digest": "source-set-1",
        }
    )

    assert failed["outcome"] == missing["outcome"] == "error"
    assert failed["error"] == (
        "Gateway authentication failed; update the Gateway Profile credential"
    )
    assert missing["error"] == "Gateway Profile has no credential"
    assert server.credential not in json.dumps(failed)
    for application in (failed_application, missing_application):
        with sqlite3.connect(application.database_path) as connection:
            row = connection.execute(
                """SELECT outcome, source_ids_json, citations_json
                     FROM source_investigation_audit"""
            ).fetchone()
        assert row == ("error", '["docs"]', "[]")
        audit_bytes = application.database_path.read_bytes()
        assert b"content must not persist" not in audit_bytes


def test_workspace_source_investigation_rejects_malformed_identity_and_unbounded_sources(
    tmp_path: Path,
) -> None:
    application = query_workspace(tmp_path)
    with sqlite3.connect(application.database_path) as connection:
        source_set = json.loads(
            connection.execute("SELECT source_set_json FROM runs WHERE id = 'run-1'").fetchone()[0]
        )
        source_set["digest"] = "bad digest"
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = 'run-1'",
            (json.dumps(source_set),),
        )

    with pytest.raises(WorkspaceError, match="Invalid Source Investigation identity"):
        application.investigate_source(
            {
                "question": "What is fixed?",
                "run_id": "run-1",
                "source_set_digest": "bad digest",
            }
        )

    source_set["digest"] = "source-set-1"
    source_set["sources"] = [
        {**source_set["sources"][0], "id": f"source-{index}"} for index in range(33)
    ]
    with sqlite3.connect(application.database_path) as connection:
        connection.execute(
            "UPDATE runs SET source_set_json = ? WHERE id = 'run-1'",
            (json.dumps(source_set),),
        )

    with pytest.raises(WorkspaceError, match="bounded fixed Source Snapshot set"):
        application.investigate_source(
            {
                "question": "What is fixed?",
                "run_id": "run-1",
                "source_set_digest": "source-set-1",
            }
        )


def test_console_source_investigation_uses_independent_secured_endpoint(
    tmp_path: Path,
) -> None:
    config_root = tmp_path / "machine-config"
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "index.html").write_text("ok", encoding="utf-8")
    with fake_query_gateway("investigation") as (gateway, base_url):
        application = query_workspace(tmp_path, config_root=config_root)
        configure_query_gateway(application, config_root, base_url, gateway.credential)
        with running_console(application, assets, config_root) as server:
            url = f"http://127.0.0.1:{server.server_port}/api/v1/source-investigations"
            headers = {
                "Authorization": f"Bearer {server.session_token}",
                "Content-Type": "application/json",
                "Origin": server.origin,
            }
            payload = {
                "question": "How are accepted answers grounded?",
                "run_id": "run-1",
                "source_set_digest": "source-set-1",
            }
            response = httpx.post(url, headers=headers, json=payload)
            wrong_origin = httpx.post(
                url,
                headers={**headers, "Origin": "https://malicious.example"},
                json=payload,
            )
            malformed = httpx.post(
                url,
                headers=headers,
                json={**payload, "accept": True},
            )

    assert response.status_code == 200
    result = response.json()
    assert result["ok"] is True
    assert result["provisional"] is True
    assert result["notice"] == "Provisional · not part of Knowledge Bundle"
    assert result["run_id"] == "run-1"
    assert result["segments"][0]["citations"][0]["path"] == "README.md"
    assert "How are accepted answers grounded?" not in response.text
    assert wrong_origin.status_code == 403
    assert malformed.status_code == 400
    assert "requires question" in malformed.json()["errors"][0]


def test_console_source_investigation_redacts_json_escaped_credentials_before_egress(
    tmp_path: Path,
) -> None:
    credential = 'quoted"slash\\secret'
    escaped_credential = json.dumps(credential, ensure_ascii=False)[1:-1]
    config_root = tmp_path / "machine-config"
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "index.html").write_text("ok", encoding="utf-8")
    with fake_query_gateway("investigation") as (gateway, base_url):
        gateway.credential = credential
        application = query_workspace(tmp_path, config_root=config_root)
        source = tmp_path / "source"
        (source / "README.md").write_text(
            f"{STATEMENT} {credential}\n{ATTACK_TEXT}\n{BUNDLE_STATEMENT}\n",
            encoding="utf-8",
        )
        _git(source, "add", "README.md")
        _git(source, "commit", "-qm", "credential fixture")
        revision = _git(source, "rev-parse", "HEAD")
        with sqlite3.connect(application.database_path) as connection:
            source_set = json.loads(
                connection.execute(
                    "SELECT source_set_json FROM runs WHERE id = 'run-1'"
                ).fetchone()[0]
            )
            source_set["sources"][0]["revision"] = revision
            connection.execute(
                "UPDATE runs SET revision = ?, source_set_json = ? WHERE id = 'run-1'",
                (revision, json.dumps(source_set)),
            )
        configure_query_gateway(application, config_root, base_url, credential)
        with running_console(application, assets, config_root) as server:
            response = httpx.post(
                f"http://127.0.0.1:{server.server_port}/api/v1/source-investigations",
                headers={
                    "Authorization": f"Bearer {server.session_token}",
                    "Content-Type": "application/json",
                    "Origin": server.origin,
                },
                json={
                    "question": f"What does the fixed Source say about {credential}?",
                    "run_id": "run-1",
                    "source_set_digest": "source-set-1",
                },
            )

    assert response.status_code == 200
    assert any(
        message["role"] == "tool"
        for _headers, payload in gateway.requests
        for message in payload["messages"]
    )
    for _headers, payload in gateway.requests:
        for value in nested_strings(payload["messages"]):
            assert credential not in value
            assert escaped_credential not in value
    assert credential not in response.text
    assert escaped_credential not in response.text


def test_console_source_investigation_stale_identity_never_calls_gateway_or_audits(
    tmp_path: Path,
) -> None:
    config_root = tmp_path / "machine-config"
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "index.html").write_text("ok", encoding="utf-8")
    with fake_query_gateway("investigation") as (gateway, base_url):
        application = query_workspace(tmp_path, config_root=config_root)
        configure_query_gateway(application, config_root, base_url, gateway.credential)
        with running_console(application, assets, config_root) as server:
            url = f"http://127.0.0.1:{server.server_port}/api/v1/source-investigations"
            headers = {
                "Authorization": f"Bearer {server.session_token}",
                "Content-Type": "application/json",
                "Origin": server.origin,
            }
            stale = httpx.post(
                url,
                headers=headers,
                json={
                    "question": "Stale identity must stop before the gateway.",
                    "run_id": "run-1",
                    "source_set_digest": "stale-source-set",
                },
            )
            unknown = httpx.post(
                url,
                headers=headers,
                json={
                    "question": "Unknown Run must stop before the gateway.",
                    "run_id": "missing-run",
                    "source_set_digest": "source-set-1",
                },
            )

    assert stale.status_code == unknown.status_code == 400
    assert stale.json()["errors"] == [
        "Source Investigation Source Set changed; refresh before asking"
    ]
    assert unknown.json()["errors"] == ["Unknown Production Run: missing-run"]
    assert gateway.requests == []
    with sqlite3.connect(application.database_path) as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM source_investigation_audit").fetchone()[0] == 0
        )
