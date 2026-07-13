import json
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest

import okf_wiki.console as console_module
from okf_wiki.console import MAX_JSON_BODY, create_console
from okf_wiki.cli import parser
from okf_wiki.gateway_probe import GatewayProbe
from okf_wiki.workspace import WorkspaceApplication, WorkspaceError


@contextmanager
def running_console(root: Path, assets: Path, config_root: Path | None = None):
    server, session_url = create_console(root, assets=assets, config_root=config_root)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server, session_url
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture
def assets(tmp_path: Path) -> Path:
    root = tmp_path / "assets"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text('<script src="/assets/app.js"></script>')
    (root / "assets" / "app.js").write_text("window.ok = true")
    return root


def authorization(server) -> dict[str, str]:
    return {"Authorization": f"Bearer {server.session_token}"}


def cli(command: list[str], cwd: Path) -> tuple[int, dict]:
    result = subprocess.run(
        [sys.executable, "-m", "okf_wiki", *command],
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode, json.loads(result.stdout)


def make_git_source(path: Path) -> None:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    (path / "README.md").write_text("Source knowledge.\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)


def review_workspace(root: Path) -> tuple[WorkspaceApplication, str]:
    root.mkdir(parents=True, exist_ok=True)
    source = root / "review-source"
    make_git_source(source)
    (source / "README.md").write_text(
        "# Review\n\nCredential handling MUST remain deterministic.\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "review knowledge"], cwd=source, check=True)
    workspace = root / "review-workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(source)})
    settings = app.settings()
    settings["definition"]["profile"]["dispositions"]["major"] = {
        "disposition": "open",
        "reason": None,
    }
    app.update_settings(
        settings["definition"],
        settings["local_settings"],
        settings["configuration_digest"],
    )
    preflight = app.run_preflight()
    started = app.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
            "fixture": "success",
        }
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if app.run_status(started["run_id"])["state"] == "review_required":
            return app, started["run_id"]
        time.sleep(0.05)
    raise AssertionError("Production Run did not reach Review Required")


def test_console_serves_offline_shell_on_loopback_with_security_headers(
    tmp_path: Path, assets: Path
) -> None:
    with running_console(tmp_path, assets) as (server, session_url):
        assert server.server_address[0] == "127.0.0.1"
        assert session_url.startswith(f"http://127.0.0.1:{server.server_port}/#token=")
        assert server.session_token not in session_url.split("#", 1)[0]

        response = httpx.get(session_url.split("#", 1)[0])
        script = httpx.get(f"http://127.0.0.1:{server.server_port}/assets/app.js")

    assert response.status_code == 200
    assert script.status_code == 200
    assert response.headers["content-security-policy"] == (
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "img-src 'self' data:; font-src 'self'; object-src 'none'; frame-src 'none'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cross-origin-opener-policy"] == "same-origin"
    assert response.headers["cross-origin-resource-policy"] == "same-origin"


def test_console_cli_exposes_only_loopback_launch_options(tmp_path: Path, assets: Path) -> None:
    arguments = parser().parse_args(
        ["workspace", "console", str(tmp_path), "--port", "4242", "--no-open"]
    )
    assert (arguments.root, arguments.port, arguments.no_open) == (str(tmp_path), 4242, True)
    with pytest.raises(SystemExit):
        parser().parse_args(["workspace", "console", "--host", "0.0.0.0"])
    with pytest.raises(WorkspaceError, match="port must be between"):
        create_console(tmp_path, -1, assets=assets)


def test_console_rejects_bad_host_traversal_and_unauthorized_api(
    tmp_path: Path, assets: Path
) -> None:
    WorkspaceApplication(tmp_path).initialize("catalog")
    with running_console(tmp_path, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        bad_host = httpx.get(base, headers={"Host": "localhost"})
        traversal = httpx.get(base + "/assets/%2e%2e/index.html")
        missing = httpx.get(base + "/api/v1/workspace")
        wrong = httpx.get(base + "/api/v1/workspace", headers={"Authorization": "Bearer wrong"})
        non_ascii = httpx.get(
            base + "/api/v1/workspace", headers=[(b"Authorization", b"Bearer \xff")]
        )

    assert bad_host.status_code == 400
    assert traversal.status_code == 404
    assert missing.status_code == wrong.status_code == non_ascii.status_code == 401


def test_console_workspace_api_matches_cli_success_and_error(tmp_path: Path, assets: Path) -> None:
    WorkspaceApplication(tmp_path).initialize("catalog", "Catalog")
    code, expected = cli(["workspace", "inspect", str(tmp_path)], tmp_path)
    assert code == 0
    with running_console(tmp_path, assets) as (server, _):
        response = httpx.get(
            f"http://127.0.0.1:{server.server_port}/api/v1/workspace",
            headers=authorization(server),
        )
    assert response.json() == expected

    (tmp_path / "workspace.toml").write_text("not = [valid")
    code, expected = cli(["workspace", "inspect", str(tmp_path)], tmp_path)
    assert code == 1
    with running_console(tmp_path, assets) as (server, _):
        response = httpx.get(
            f"http://127.0.0.1:{server.server_port}/api/v1/workspace",
            headers=authorization(server),
        )
        shell = httpx.get(f"http://127.0.0.1:{server.server_port}/")
    assert response.status_code == 400
    assert response.json() == expected
    assert shell.status_code == 200


def test_console_review_api_matches_cli_and_returns_refreshed_stale_snapshot(
    tmp_path: Path, assets: Path
) -> None:
    app, run_id = review_workspace(tmp_path)
    code, expected = cli(
        ["workspace", "review-snapshot", run_id, str(app.root)],
        app.root,
    )
    assert code == 0
    evidence_id = expected["evidence_references"][0]["id"]
    code, expected_evidence = cli(
        ["workspace", "review-evidence", run_id, evidence_id, str(app.root)],
        app.root,
    )
    assert code == 0
    bundle_path = expected["bundle_diff"]["added"][0]
    code, expected_bundle = cli(
        ["workspace", "review-bundle", run_id, bundle_path, str(app.root)],
        app.root,
    )
    assert code == 0
    with running_console(app.root, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = authorization(server)
        response = httpx.get(f"{base}/api/v1/reviews/{run_id}", headers=headers)
        evidence = httpx.get(
            f"{base}/api/v1/reviews/{run_id}/evidence/{evidence_id}",
            headers=headers,
        )
        bundle = httpx.get(
            f"{base}/api/v1/reviews/{run_id}/bundle/{quote(bundle_path, safe='')}",
            headers=headers,
        )
        assert response.json() == expected
        assert evidence.json() == expected_evidence
        assert bundle.json() == expected_bundle

        with sqlite3.connect(app.database_path) as connection:
            connection.execute(
                "UPDATE accepted_claims SET statement = statement || ' Changed.' WHERE run_id = ?",
                (run_id,),
            )
        stale = httpx.post(
            f"{base}/api/v1/reviews/{run_id}/decision",
            headers={**headers, "Origin": server.origin},
            json={
                "decision": "approve",
                "expected_digest": expected["authoritative_digest"],
            },
        )

    code, refreshed = cli(
        ["workspace", "review-snapshot", run_id, str(app.root)],
        app.root,
    )
    assert code == 0
    assert stale.status_code == 409
    assert stale.json()["review"] == refreshed
    assert app.run_status(run_id)["state"] == "review_required"


@pytest.mark.parametrize("decision", ["approve", "reject"])
def test_console_review_success_decisions_match_cli(
    tmp_path: Path, assets: Path, decision: str
) -> None:
    cli_app, cli_run_id = review_workspace(tmp_path / "cli")
    http_app, http_run_id = review_workspace(tmp_path / "http")
    cli_digest = cli_app.review_snapshot(cli_run_id)["authoritative_digest"]
    http_digest = http_app.review_snapshot(http_run_id)["authoritative_digest"]

    code, expected = cli(
        [
            "workspace",
            "review",
            cli_run_id,
            decision,
            str(cli_app.root),
            "--expected-digest",
            cli_digest,
        ],
        cli_app.root,
    )
    with running_console(http_app.root, assets) as (server, _):
        response = httpx.post(
            f"http://127.0.0.1:{server.server_port}/api/v1/reviews/{http_run_id}/decision",
            headers={**authorization(server), "Origin": server.origin},
            json={"decision": decision, "expected_digest": http_digest},
        )

    assert code == 0
    assert response.status_code == 200
    assert {**response.json(), "run_id": "<run>"} == {
        **expected,
        "run_id": "<run>",
    }


def test_console_review_final_check_failure_matches_cli(tmp_path: Path, assets: Path) -> None:
    cli_app, cli_run_id = review_workspace(tmp_path / "cli")
    http_app, http_run_id = review_workspace(tmp_path / "http")
    for app, run_id in ((cli_app, cli_run_id), (http_app, http_run_id)):
        staging = app.root / ".okf-wiki" / "runs" / run_id / "staging" / "overview.md"
        staging.write_text(staging.read_text() + "\nReviewer edit.\n")
    cli_digest = cli_app.review_snapshot(cli_run_id)["authoritative_digest"]
    http_digest = http_app.review_snapshot(http_run_id)["authoritative_digest"]

    code, expected = cli(
        [
            "workspace",
            "review",
            cli_run_id,
            "approve",
            str(cli_app.root),
            "--expected-digest",
            cli_digest,
        ],
        cli_app.root,
    )
    with running_console(http_app.root, assets) as (server, _):
        response = httpx.post(
            f"http://127.0.0.1:{server.server_port}/api/v1/reviews/{http_run_id}/decision",
            headers={**authorization(server), "Origin": server.origin},
            json={"decision": "approve", "expected_digest": http_digest},
        )

    assert code == 1
    assert response.status_code == 422
    assert {**response.json(), "run_id": "<run>"} == {
        **expected,
        "run_id": "<run>",
    }


def test_console_review_publication_rollback_matches_cli(tmp_path: Path, assets: Path) -> None:
    cli_app, cli_run_id = review_workspace(tmp_path / "cli")
    http_app, http_run_id = review_workspace(tmp_path / "http")
    for app in (cli_app, http_app):
        with sqlite3.connect(app.database_path) as connection:
            connection.execute(
                """CREATE TRIGGER fail_published_review_event
                   BEFORE INSERT ON run_events WHEN NEW.state = 'published'
                   BEGIN SELECT RAISE(FAIL, 'seeded published event failure'); END"""
            )
    cli_digest = cli_app.review_snapshot(cli_run_id)["authoritative_digest"]
    http_digest = http_app.review_snapshot(http_run_id)["authoritative_digest"]

    code, expected = cli(
        [
            "workspace",
            "review",
            cli_run_id,
            "approve",
            str(cli_app.root),
            "--expected-digest",
            cli_digest,
        ],
        cli_app.root,
    )
    with running_console(http_app.root, assets) as (server, _):
        response = httpx.post(
            f"http://127.0.0.1:{server.server_port}/api/v1/reviews/{http_run_id}/decision",
            headers={**authorization(server), "Origin": server.origin},
            json={"decision": "approve", "expected_digest": http_digest},
        )

    assert code == 1
    assert response.status_code == 422
    assert {**response.json(), "run_id": "<run>"} == {
        **expected,
        "run_id": "<run>",
    }
    assert cli_app.run_status(cli_run_id)["state"] == "failed"
    assert http_app.run_status(http_run_id)["state"] == "failed"
    assert not (cli_app.root / "published").exists()
    assert not (http_app.root / "published").exists()


def test_console_overview_is_produced_by_workspace_application(
    tmp_path: Path, assets: Path
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog", "Catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [{"id": "code", "role": "implementation", "revision": "a"}],
        },
        {"schema_version": 1, "checkouts": {"code": "/source"}},
    )
    with sqlite3.connect(app.database_path) as connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                coverage_json, error, created_at, updated_at)
               VALUES ('published-1', 'catalog', '/source', 'a', '/bundle', '/staging',
                       'published', NULL, NULL, '2026-01-01', '2026-01-01')"""
        )
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                coverage_json, error, created_at, updated_at)
               VALUES ('run-2', 'catalog', '/source', 'b', '/bundle', '/staging',
                       'exploring', ?, 'gateway unavailable', '2026-01-02', '2026-01-02')""",
            (json.dumps({"total": 2, "by_priority": {"major": {"dispositions": {"open": 1}}}}),),
        )

    expected = app.overview()
    with running_console(tmp_path, assets) as (server, _):
        response = httpx.get(
            f"http://127.0.0.1:{server.server_port}/api/v1/overview",
            headers=authorization(server),
        )
    assert response.json() == {"ok": True, **expected}
    assert expected["latest_bundle"]["run_id"] == "published-1"
    assert expected["active_run"]["run_id"] == "run-2"
    assert expected["blockers"] == ["gateway unavailable", "1 major obligations remain open"]


def test_console_concepts_query_uses_workspace_application_and_validates_bounds(
    tmp_path: Path, assets: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    WorkspaceApplication(tmp_path).initialize("catalog")
    received = []

    def provenance(_self, **query):
        received.append(query)
        return {
            "run_id": "run-1",
            "run_state": "review_required",
            "selected_concept_id": "concept:1",
            "concepts": [],
            "nodes": [],
            "edges": [],
            "bounds": {
                "limit": query["limit"],
                "offset": query["offset"],
                "previous_offset": None,
                "next_offset": None,
                "total_nodes": 0,
                "total_edges": 0,
                "filtered_total_nodes": 0,
                "filtered_total_edges": 0,
                "truncated": False,
            },
        }

    monkeypatch.setattr(WorkspaceApplication, "concept_provenance", provenance)
    with running_console(tmp_path, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        response = httpx.get(
            base
            + "/api/v1/concepts?run_id=run-1&concept_id=concept%3A1&limit=25"
            + "&offset=50&types=claim%2Cverification&states=stale%2Crejected",
            headers=authorization(server),
        )
        invalid = httpx.get(base + "/api/v1/concepts?limit=many", headers=authorization(server))
        invalid_filter = httpx.get(
            base + "/api/v1/concepts?types=claim%2C",
            headers=authorization(server),
        )

    assert response.status_code == 200
    assert response.json()["bounds"]["limit"] == 25
    assert received == [
        {
            "run_id": "run-1",
            "concept_id": "concept:1",
            "limit": 25,
            "offset": 50,
            "node_types": ("claim", "verification"),
            "states": ("stale", "rejected"),
        }
    ]
    assert invalid.status_code == 400
    assert invalid_filter.status_code == 400


def test_console_replay_query_uses_workspace_application_and_validates_bounds(
    tmp_path: Path, assets: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    WorkspaceApplication(tmp_path).initialize("catalog")
    received = []

    def replay(_self, **query):
        received.append(query)
        return {
            "run_id": "run-1",
            "run_state": "published",
            "lineage_run_ids": ["run-1"],
            "events": [],
            "located_event_sequence": None,
            "event_bounds": {
                "limit": query["event_limit"],
                "offset": query["event_offset"],
                "previous_offset": None,
                "next_offset": None,
                "total": 0,
                "truncated": False,
            },
            "impact": {
                "mode": "full",
                "fallback_reason": None,
                "summary": {},
                "nodes": [],
                "edges": [],
                "paths": [],
                "path_bounds": {
                    "limit": query["path_limit"],
                    "offset": query["path_offset"],
                    "previous_offset": None,
                    "next_offset": None,
                    "total": 0,
                    "truncated": False,
                },
                "bounds": {
                    "limit": query["impact_limit"],
                    "offset": query["impact_offset"],
                    "previous_offset": None,
                    "next_offset": None,
                    "total_nodes": 0,
                    "total_edges": 0,
                    "truncated": False,
                },
            },
        }

    monkeypatch.setattr(WorkspaceApplication, "concept_replay", replay)
    with running_console(tmp_path, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        response = httpx.get(
            base
            + "/api/v1/replay?run_id=run-1&event_limit=25&event_offset=50"
            + "&event_sequence=51&impact_limit=75&impact_offset=150"
            + "&path_limit=25&path_offset=75",
            headers=authorization(server),
        )
        invalid = httpx.get(base + "/api/v1/replay?event_limit=many", headers=authorization(server))
        duplicate = httpx.get(
            base + "/api/v1/replay?event_limit=10&event_limit=20",
            headers=authorization(server),
        )

    assert response.status_code == 200
    assert response.json()["impact"]["bounds"]["limit"] == 75
    assert received == [
        {
            "run_id": "run-1",
            "event_limit": 25,
            "event_offset": 50,
            "event_sequence": 51,
            "entity_id": None,
            "impact_limit": 75,
            "impact_offset": 150,
            "path_limit": 25,
            "path_offset": 75,
        }
    ]
    assert invalid.status_code == duplicate.status_code == 400


def test_console_overview_reports_source_setup_blockers(tmp_path: Path) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    empty = app.overview()
    assert empty["blockers"] == ["No Sources are configured"]
    assert empty["next_actions"] == ["configure_sources"]

    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "catalog"},
            "sources": [{"id": "docs", "role": "documentation", "revision": "a"}],
        },
        {"schema_version": 1},
    )
    missing_checkout = app.overview()
    assert missing_checkout["blockers"] == ["Source docs has no checkout binding"]
    assert missing_checkout["next_actions"] == ["configure_sources"]


def test_console_non_get_requires_token_and_exact_origin(tmp_path: Path, assets: Path) -> None:
    with running_console(tmp_path, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = authorization(server)
        missing_origin = httpx.post(base + "/api/v1/future", headers=headers)
        wrong_origin = httpx.post(
            base + "/api/v1/future", headers={**headers, "Origin": "http://evil.invalid"}
        )
        authorized = httpx.post(base + "/api/v1/future", headers={**headers, "Origin": base})

    assert missing_origin.status_code == wrong_origin.status_code == 403
    assert authorized.status_code == 404


def test_console_settings_update_matches_cli_and_rejects_stale_edits(
    tmp_path: Path, assets: Path
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog", "Catalog")
    current = app.settings()
    payload = {
        **current,
        "definition": {
            **current["definition"],
            "project": {"id": "catalog", "name": "Catalog Platform"},
            "publication": {"path": "dist/wiki", "bundle_name": "Catalog Knowledge"},
        },
        "local_settings": {
            **current["local_settings"],
            "models": {
                **current["local_settings"]["models"],
                "concurrency": 2,
                "budgets": {"total_tokens": 12000},
            },
            "ui": {"compact_navigation": True},
        },
    }

    with running_console(tmp_path, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {**authorization(server), "Origin": base}
        response = httpx.put(base + "/api/v1/settings", headers=headers, json=payload)
        stale = httpx.put(base + "/api/v1/settings", headers=headers, json=payload)

    assert response.status_code == 200
    assert response.json() == {"ok": True, **app.settings()}
    assert stale.status_code == 409
    assert stale.json()["ok"] is False
    assert "refresh and try again" in stale.json()["errors"][0]

    cli_payload = tmp_path / "settings-update.json"
    cli_current = app.settings()
    cli_payload.write_text(
        json.dumps(
            {
                **cli_current,
                "definition": {
                    **cli_current["definition"],
                    "project": {"id": "catalog", "name": "Catalog CLI"},
                },
            }
        ),
        encoding="utf-8",
    )
    code, cli_response = cli(
        ["workspace", "update-settings", str(cli_payload), str(tmp_path)], tmp_path
    )

    assert code == 0
    assert cli_response == {"ok": True, **app.settings()}
    assert cli_response["definition"]["publication"] == response.json()["definition"]["publication"]
    assert cli_response["local_settings"] == response.json()["local_settings"]


def test_console_settings_update_rejects_invalid_payload_without_writes(
    tmp_path: Path, assets: Path
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    before = (app.definition_path.read_bytes(), app.settings_path.read_bytes())

    with running_console(tmp_path, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {**authorization(server), "Origin": base}
        malformed = httpx.put(
            base + "/api/v1/settings",
            headers={**headers, "Content-Type": "application/json"},
            content=b"not-json",
        )
        incomplete = httpx.put(base + "/api/v1/settings", headers=headers, json={"definition": {}})
        wrong_type = httpx.put(
            base + "/api/v1/settings",
            headers={**headers, "Content-Type": "text/plain"},
            content=b"{}",
        )
        too_large = httpx.put(
            base + "/api/v1/settings",
            headers={**headers, "Content-Type": "application/json"},
            content=b" " * (MAX_JSON_BODY + 1),
        )

    assert malformed.status_code == incomplete.status_code == 400
    assert malformed.json() == {"errors": ["Invalid JSON request body"], "ok": False}
    assert "must contain definition" in incomplete.json()["errors"][0]
    assert wrong_type.status_code == 415
    assert wrong_type.json() == {"errors": ["Content-Type must be application/json"], "ok": False}
    assert too_large.status_code == 413
    assert too_large.json() == {"errors": ["JSON request body is too large"], "ok": False}
    assert (app.definition_path.read_bytes(), app.settings_path.read_bytes()) == before


def test_console_and_cli_settings_updates_return_the_same_domain_error(
    tmp_path: Path, assets: Path
) -> None:
    app = WorkspaceApplication(tmp_path)
    app.initialize("catalog")
    current = app.settings()
    payload = {
        **current,
        "local_settings": {
            **current["local_settings"],
            "models": {"api_key": "must-not-appear"},
        },
    }
    payload_path = tmp_path / "invalid-settings.json"
    payload_path.write_text(json.dumps(payload), encoding="utf-8")

    with running_console(tmp_path, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        response = httpx.put(
            base + "/api/v1/settings",
            headers={**authorization(server), "Origin": base},
            json=payload,
        )
    code, cli_response = cli(
        ["workspace", "update-settings", str(payload_path), str(tmp_path)], tmp_path
    )

    assert response.status_code == 400
    assert code == 1
    assert response.json() == cli_response
    assert "must-not-appear" not in response.text


def test_console_json_mutations_distinguish_media_type_size_and_syntax(
    tmp_path: Path, assets: Path
) -> None:
    WorkspaceApplication(tmp_path).initialize("catalog")
    with running_console(tmp_path, assets, tmp_path / "machine") as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {**authorization(server), "Origin": base}
        unsupported = httpx.post(
            base + "/api/v1/gateway-profiles",
            headers={**headers, "Content-Type": "text/plain"},
            content=b"{}",
        )
        invalid = httpx.post(
            base + "/api/v1/gateway-profiles",
            headers={**headers, "Content-Type": "application/json"},
            content=b"{",
        )
        oversized = httpx.post(
            base + "/api/v1/gateway-profiles",
            headers={**headers, "Content-Type": "application/json"},
            content=b" " * 1_048_577,
        )

    assert unsupported.status_code == 415
    assert oversized.status_code == 413
    assert invalid.status_code == 400
    assert unsupported.json()["errors"] == ["Content-Type must be application/json"]
    assert oversized.json()["errors"] == ["JSON request body is too large"]
    assert invalid.json()["errors"] == ["Invalid JSON request body"]


def test_console_configures_reuses_and_selects_secret_free_gateway_profile(
    tmp_path: Path, assets: Path, monkeypatch
) -> None:
    def probe(_client, model):
        return {
            "model": model,
            "models": ["model-a", "model-b"],
            "capabilities": {
                "authentication": True,
                "structured_output": True,
                "tool_calling": True,
            },
        }

    monkeypatch.setattr(GatewayProbe, "run", probe)
    WorkspaceApplication(tmp_path).initialize("catalog")
    config_root = tmp_path / "machine"
    with running_console(tmp_path, assets, config_root) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {**authorization(server), "Origin": base}
        created = httpx.post(
            base + "/api/v1/gateway-profiles",
            headers=headers,
            json={
                "profile": {
                    "id": "enterprise",
                    "name": "Enterprise",
                    "gateway_id": "corp",
                    "base_url": "https://gateway.example/v1",
                    "headers": {"X-Tenant": "docs"},
                },
                "credential": "http-secret",
            },
        )
        tested = [
            httpx.post(
                base + "/api/v1/gateway-profiles/enterprise/test",
                headers=headers,
                json={"model": model},
            )
            for model in ("model-a", "model-b")
        ]
        listed = httpx.get(
            base + "/api/v1/gateway-profiles",
            headers=authorization(server),
        )
        selected = httpx.put(
            base + "/api/v1/workspace/models",
            headers=headers,
            json={
                "profile_id": "enterprise",
                "default_model": "model-a",
                "concurrency": 2,
                "budgets": {"total_tokens": 1000},
                "role_overrides": {"verifier": "model-b"},
            },
        )
        snapshot = httpx.get(base + "/api/v1/workspace/run-snapshot", headers=authorization(server))

    assert created.status_code == listed.status_code == selected.status_code == 200
    assert all(response.status_code == 200 for response in tested)
    assert snapshot.status_code == 200
    combined = created.text + listed.text + selected.text + snapshot.text
    assert "http-secret" not in combined
    assert "docs" not in combined
    assert listed.json()["profiles"][0]["credential_configured"] is True
    assert snapshot.json()["models"]["assignments"]["verifier"] == "model-b"
    assert snapshot.json()["models"]["concurrency"] == 2


def test_console_redacts_unexpected_errors(tmp_path: Path, assets: Path, monkeypatch) -> None:
    WorkspaceApplication(tmp_path).initialize("catalog")

    def fail(_self):
        raise RuntimeError("secret database detail")

    monkeypatch.setattr(WorkspaceApplication, "inspect", fail)
    with running_console(tmp_path, assets) as (server, _):
        response = httpx.get(
            f"http://127.0.0.1:{server.server_port}/api/v1/workspace",
            headers=authorization(server),
        )
    assert response.status_code == 500
    assert response.json() == {"errors": ["Internal server error"], "ok": False}
    assert "secret" not in response.text


def test_cli_console_opens_browser_unless_disabled(
    tmp_path: Path, assets: Path, monkeypatch
) -> None:
    calls: list[str] = []

    class Stop(Exception):
        pass

    class Server:
        origin = "http://127.0.0.1:1234"

        def serve_forever(self):
            raise Stop

        def server_close(self):
            pass

    monkeypatch.setattr(console_module, "create_console", lambda *_args, **_kw: (Server(), "url"))
    monkeypatch.setattr(console_module.webbrowser, "open", lambda url: calls.append(url))

    with pytest.raises(Stop):
        console_module.run_console(tmp_path)
    assert calls == ["url"]
    calls.clear()
    with pytest.raises(Stop):
        console_module.run_console(tmp_path, open_browser=False)
    assert calls == []


def test_console_source_api_matches_cli_and_uses_the_application_seam(
    tmp_path: Path, assets: Path
) -> None:
    workspace = tmp_path / "workspace"
    source = tmp_path / "source"
    make_git_source(source)
    WorkspaceApplication(workspace).initialize("catalog")

    with running_console(workspace, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        mutation_headers = {**authorization(server), "Origin": base}
        linked = httpx.post(
            base + "/api/v1/sources/link",
            headers=mutation_headers,
            json={"id": "docs", "role": "documentation", "checkout": str(source)},
        )
        listed = httpx.get(base + "/api/v1/sources", headers=authorization(server))
        invalid = httpx.post(
            base + "/api/v1/sources/link",
            headers=mutation_headers,
            json={"id": "contracts", "role": "contracts", "checkout": str(source)},
        )
        removed = httpx.post(
            base + "/api/v1/sources/remove",
            headers=mutation_headers,
            json={"id": "docs"},
        )

    code, cli_listed = cli(["workspace", "sources", str(workspace)], tmp_path)
    code_invalid, cli_invalid = cli(
        ["workspace", "link-source", "contracts", "contracts", str(source), str(workspace)],
        tmp_path,
    )
    assert linked.status_code == listed.status_code == removed.status_code == 200
    assert listed.json()["sources"] == linked.json()["sources"]
    assert removed.json()["sources"] == cli_listed["sources"] == []
    assert code == 0
    assert invalid.status_code == 400
    assert code_invalid == 1
    assert invalid.json() == cli_invalid
    assert source.is_dir()


def test_console_can_bind_a_configured_source_without_rewriting_its_definition(
    tmp_path: Path, assets: Path
) -> None:
    workspace = tmp_path / "workspace"
    origin = tmp_path / "origin"
    make_git_source(origin)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=origin,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
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
                    "remote": str(origin),
                }
            ],
        },
        {"schema_version": 1},
    )
    definition_before = app.settings()["definition"]

    with running_console(workspace, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        response = httpx.post(
            base + "/api/v1/sources/clone",
            headers={**authorization(server), "Origin": base},
            json={"id": "code"},
        )

    code, listed = cli(["workspace", "sources", str(workspace)], tmp_path)
    assert response.status_code == 200
    assert code == 0
    assert response.json() == listed
    assert app.settings()["definition"] == definition_before


def test_console_and_cli_share_pull_revision_and_preflight_use_cases(
    tmp_path: Path, assets: Path
) -> None:
    upstream = tmp_path / "upstream"
    remote = tmp_path / "remote.git"
    checkout = tmp_path / "checkout"
    workspace = tmp_path / "workspace"
    make_git_source(upstream)
    subprocess.run(["git", "init", "--bare", "-q", remote], check=True)
    subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=upstream, check=True)
    subprocess.run(["git", "push", "-qu", "origin", "HEAD"], cwd=upstream, check=True)
    subprocess.run(["git", "clone", "-q", remote, checkout], check=True)
    branch = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=checkout,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    first = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=checkout,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(checkout)})

    with running_console(workspace, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {**authorization(server), "Origin": base}
        pinned = httpx.put(
            base + "/api/v1/sources/revision",
            headers=headers,
            json={
                "id": "code",
                "revision_policy": "pinned_commit",
                "revision": first,
                "configuration_digest": app.sources()["configuration_digest"],
            },
        )
        browser_preflight = httpx.get(
            base + "/api/v1/workspace/preflight", headers=authorization(server)
        )
        preflight_code, command_preflight = cli(
            ["workspace", "preflight", str(workspace)], tmp_path
        )

        (upstream / "REMOTE.md").write_text("remote\n", encoding="utf-8")
        subprocess.run(["git", "add", "REMOTE.md"], cwd=upstream, check=True)
        subprocess.run(["git", "commit", "-qm", "remote"], cwd=upstream, check=True)
        subprocess.run(["git", "push", "-q"], cwd=upstream, check=True)
        pulled = httpx.post(base + "/api/v1/sources/pull", headers=headers, json={"id": "code"})
        sources_code, command_sources = cli(["workspace", "sources", str(workspace)], tmp_path)

        (checkout / "LOCAL.md").write_text("local\n", encoding="utf-8")
        rejected = httpx.post(base + "/api/v1/sources/pull", headers=headers, json={"id": "code"})

    rejected_code, command_rejected = cli(
        ["workspace", "pull-source", "code", str(workspace)], tmp_path
    )

    assert pinned.status_code == 200
    assert preflight_code == sources_code == 0
    assert browser_preflight.json() == command_preflight
    assert pulled.status_code == 200
    assert pulled.json() == command_sources
    assert pulled.json()["sources"][0]["revision"] == first
    assert rejected.status_code == 400
    assert rejected_code == 1
    assert rejected.json() == command_rejected

    (checkout / "LOCAL.md").unlink()
    digest = app.sources()["configuration_digest"]
    follow_code, followed = cli(
        [
            "workspace",
            "set-source-revision",
            "code",
            str(workspace),
            "--follow-branch",
            branch,
            "--configuration-digest",
            digest,
        ],
        tmp_path,
    )
    assert follow_code == 0
    assert followed["sources"][0]["revision_policy"] == "follow_branch"


def test_console_and_cli_share_run_creation_status_and_stale_errors(
    tmp_path: Path, assets: Path
) -> None:
    workspace = tmp_path / "workspace"
    source = tmp_path / "source"
    make_git_source(source)
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(source)})
    preflight = app.run_preflight()
    payload = {
        "configuration_digest": preflight["configuration_digest"],
        "source_set_digest": preflight["source_set_digest"],
        "fixture": "failure",
    }

    with running_console(workspace, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        created = httpx.post(
            base + "/api/v1/runs",
            headers={**authorization(server), "Origin": base},
            json=payload,
        )
        deadline = time.monotonic() + 5
        while (
            time.monotonic() < deadline
            and app.run_status(created.json()["run_id"])["state"] != "failed"
        ):
            time.sleep(0.05)
        detail = httpx.get(
            base + f"/api/v1/runs/{created.json()['run_id']}",
            headers=authorization(server),
        )
        listed = httpx.get(base + "/api/v1/runs", headers=authorization(server))
        stale = httpx.post(
            base + "/api/v1/runs",
            headers={**authorization(server), "Origin": base},
            json={**payload, "source_set_digest": "0" * 64},
        )

    status_code, command_detail = cli(
        ["workspace", "run-status", created.json()["run_id"], str(workspace)], tmp_path
    )
    list_code, command_list = cli(["workspace", "runs", str(workspace)], tmp_path)
    stale_code, command_stale = cli(
        [
            "workspace",
            "start-run",
            str(workspace),
            "--configuration-digest",
            payload["configuration_digest"],
            "--source-set-digest",
            "0" * 64,
            "--fixture",
            "failure",
        ],
        tmp_path,
    )
    create_code, command_created = cli(
        [
            "workspace",
            "start-run",
            str(workspace),
            "--configuration-digest",
            payload["configuration_digest"],
            "--source-set-digest",
            payload["source_set_digest"],
            "--fixture",
            "failure",
        ],
        tmp_path,
    )

    assert created.status_code == detail.status_code == listed.status_code == 200
    assert created.json()["execution"]["mode"] == "deterministic_fixture"
    assert status_code == list_code == create_code == 0
    assert detail.json() == command_detail
    assert listed.json() == command_list
    assert stale.status_code == 409
    assert stale_code == 1
    assert stale.json() == command_stale
    assert command_created["run_id"] != created.json()["run_id"]
    assert set(command_created) == set(created.json())
    assert command_created["execution"] == created.json()["execution"]
    assert command_created["source_set_digest"] == created.json()["source_set_digest"]
    assert command_created["sources"] == created.json()["sources"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        command_status = app.run_status(command_created["run_id"])
        if command_status["state"] == "failed":
            break
        time.sleep(0.05)
    assert command_status["state"] == "failed"


def test_console_and_cli_share_cancel_recover_outcomes(
    tmp_path: Path, assets: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    source = tmp_path / "source"
    make_git_source(source)
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.link_source({"id": "code", "role": "implementation", "checkout": str(source)})
    preflight = app.run_preflight()
    monkeypatch.setenv("OKF_WIKI_WORKER_FAULT", "after_state")
    started = app.start_run(
        {
            "configuration_digest": preflight["configuration_digest"],
            "source_set_digest": preflight["source_set_digest"],
            "fixture": "success",
        }
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if app.run_status(started["run_id"])["operations"]["can_recover"]:
            break
        time.sleep(0.05)
    else:
        raise AssertionError("Run Worker did not become recoverable")
    monkeypatch.delenv("OKF_WIKI_WORKER_FAULT")

    with running_console(workspace, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {**authorization(server), "Origin": base}
        recovered = httpx.post(base + f"/api/v1/runs/{started['run_id']}/recover", headers=headers)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if app.run_status(started["run_id"])["state"] == "review_required":
                break
            time.sleep(0.05)
        repeated_http = httpx.post(
            base + f"/api/v1/runs/{started['run_id']}/recover", headers=headers
        )

    repeated_code, repeated_cli = cli(
        ["workspace", "recover-run", started["run_id"], str(workspace)], tmp_path
    )

    assert recovered.status_code == 200
    assert recovered.json()["recovered_tasks"] == []
    assert repeated_http.status_code == 200
    assert repeated_code == 0
    assert repeated_http.json() == repeated_cli

    with running_console(workspace, assets) as (server, _):
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {**authorization(server), "Origin": base}
        cancelled = httpx.post(base + f"/api/v1/runs/{started['run_id']}/cancel", headers=headers)
        repeated_cancel = httpx.post(
            base + f"/api/v1/runs/{started['run_id']}/cancel", headers=headers
        )
    cancel_code, command_cancel = cli(
        ["workspace", "cancel-run", started["run_id"], str(workspace)], tmp_path
    )

    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    assert repeated_cancel.status_code == 400
    assert cancel_code == 1
    assert repeated_cancel.json() == command_cancel
