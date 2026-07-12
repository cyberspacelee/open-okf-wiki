import json
import sqlite3
import subprocess
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

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
