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
from okf_wiki.console import create_console
from okf_wiki.cli import parser
from okf_wiki.workspace import WorkspaceApplication, WorkspaceError


@contextmanager
def running_console(root: Path, assets: Path):
    server, session_url = create_console(root, assets=assets)
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
