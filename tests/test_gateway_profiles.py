import json
import os
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from okf_wiki.gateway_profiles import (
    GatewayApplication,
    GatewayError,
    GatewayProbe,
    GatewayProfileRegistry,
    LinuxSecretToolBackend,
    LocalFileSecretBackend,
    MacOSSecurityBackend,
    SecretStore,
)
from okf_wiki.workspace import WorkspaceApplication


class MemorySecretBackend:
    name = "test-keyring"

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.values: dict[str, str] = {}

    def available(self) -> bool:
        return True

    def put(self, profile_id: str, secret: str) -> None:
        if self.fail:
            raise GatewayError("credential store unavailable")
        self.values[profile_id] = secret

    def get(self, profile_id: str) -> str:
        if self.fail or profile_id not in self.values:
            raise GatewayError("credential unavailable")
        return self.values[profile_id]

    def delete(self, profile_id: str) -> None:
        self.values.pop(profile_id, None)


class BrokenSecretBackend(MemorySecretBackend):
    def put(self, profile_id: str, secret: str) -> None:
        raise RuntimeError("programming error")


def registry(tmp_path: Path, primary=None) -> GatewayProfileRegistry:
    fallback = LocalFileSecretBackend(tmp_path / "config" / "credentials")
    return GatewayProfileRegistry(
        tmp_path / "config",
        secret_store=SecretStore(primary=primary, fallback=fallback),
    )


def profile_payload(base_url: str = "https://gateway.example/v1") -> dict:
    return {
        "id": "enterprise",
        "name": "Enterprise Gateway",
        "gateway_id": "corp-openai",
        "base_url": base_url,
        "headers": {"X-Tenant": "docs"},
    }


def test_profile_registry_never_persists_or_lists_credentials(tmp_path: Path) -> None:
    secret = "never-write-this-token"
    profiles = registry(tmp_path, MemorySecretBackend())

    saved = profiles.save(profile_payload(), credential=secret)
    listed = profiles.list()

    assert saved["credential_configured"] is True
    assert saved["credential_backend"] == "test-keyring"
    assert saved["header_names"] == ["X-Tenant"]
    assert "docs" not in json.dumps(saved)
    assert listed == [saved]
    assert secret not in json.dumps(listed)
    assert secret.encode() not in profiles.path.read_bytes()


def test_secret_store_uses_restricted_fallback_when_primary_fails(tmp_path: Path) -> None:
    profiles = registry(tmp_path, MemorySecretBackend(fail=True))
    saved = profiles.save(profile_payload(), credential="fallback-secret")
    secret_path = tmp_path / "config" / "credentials" / "enterprise.secret"

    assert saved["credential_backend"] == "local-file-0600"
    assert stat.S_IMODE(secret_path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(secret_path.stat().st_mode) == 0o600
    assert profiles.credential("enterprise") == "fallback-secret"

    secret_path.chmod(0o644)
    with pytest.raises(GatewayError, match="permissions"):
        profiles.credential("enterprise")
    secret_path.chmod(0o600)
    secret_path.parent.chmod(0o755)
    with pytest.raises(GatewayError, match="directory permissions"):
        profiles.credential("enterprise")


def test_secret_store_does_not_hide_programming_errors(tmp_path: Path) -> None:
    profiles = registry(tmp_path, BrokenSecretBackend())
    with pytest.raises(RuntimeError, match="programming error"):
        profiles.save(profile_payload(), credential="secret")


def test_missing_credential_is_reported_without_profile_data(tmp_path: Path) -> None:
    profiles = registry(tmp_path)
    profiles.save(profile_payload())
    with pytest.raises(GatewayError, match="no credential") as caught:
        profiles.credential("enterprise")
    assert "gateway.example" not in str(caught.value)


def test_system_secret_command_uses_stdin_and_never_echoes_secret(monkeypatch) -> None:
    calls: list[tuple[list[str], str | None]] = []

    def run(command, **kwargs):
        calls.append((command, kwargs.get("input")))
        return subprocess.CompletedProcess(command, 1, "", "secret-tool leaked gateway-secret")

    monkeypatch.setattr("okf_wiki.gateway_profiles.shutil.which", lambda _name: "/bin/secret-tool")
    monkeypatch.setattr("okf_wiki.gateway_profiles.subprocess.run", run)
    for backend in (LinuxSecretToolBackend(), MacOSSecurityBackend()):
        with pytest.raises(GatewayError) as caught:
            backend.put("enterprise", "gateway-secret")
        command, stdin = calls[-1]
        assert stdin == "gateway-secret"
        assert all("gateway-secret" not in argument for argument in command)
        assert "gateway-secret" not in str(caught.value)


def test_profile_validation_and_stale_updates_are_strict(tmp_path: Path) -> None:
    profiles = registry(tmp_path)
    created = profiles.save(profile_payload(), credential="secret")

    with pytest.raises(GatewayError, match="stale"):
        profiles.save(
            {**profile_payload(), "name": "Changed"},
            expected_revision=created["revision"] - 1,
        )
    for invalid in (
        "https://user:password@gateway.example/v1",
        "https://gateway.example/v1?api_key=secret",
        "ftp://gateway.example/v1",
    ):
        with pytest.raises(GatewayError):
            profiles.save({**profile_payload(invalid), "id": f"bad-{len(invalid)}"})
    with pytest.raises(GatewayError, match="secret-bearing"):
        profiles.save({**profile_payload(), "headers": {"Authorization": "Bearer secret"}})
    with pytest.raises(GatewayError, match="headers"):
        profiles.save({**profile_payload(), "headers": {"Bad Header": "value"}})


def test_profile_save_restores_previous_secret_when_registry_write_fails(
    tmp_path: Path, monkeypatch
) -> None:
    backend = MemorySecretBackend()
    profiles = registry(tmp_path, backend)
    profiles.save(profile_payload(), credential="old-secret")

    def fail(_profiles) -> None:
        raise GatewayError("cannot save the Gateway Profile registry")

    monkeypatch.setattr(profiles, "_write", fail)
    with pytest.raises(GatewayError, match="cannot save"):
        profiles.save(
            {**profile_payload(), "name": "Changed"},
            credential="new-secret",
            expected_revision=1,
        )
    assert backend.values["enterprise"] == "old-secret"

    fresh_backend = MemorySecretBackend()
    fresh = registry(tmp_path / "fresh", fresh_backend)
    monkeypatch.setattr(fresh, "_write", fail)
    with pytest.raises(GatewayError, match="cannot save"):
        fresh.save(profile_payload(), credential="orphan-secret")
    assert "enterprise" not in fresh_backend.values


def test_capability_result_is_rejected_when_profile_changes_during_probe(
    tmp_path: Path, monkeypatch
) -> None:
    profiles = registry(tmp_path)
    profiles.save(profile_payload(), credential="gateway-secret")

    def change_profile(_probe, _model):
        profiles.save({**profile_payload(), "name": "Changed"}, expected_revision=1)
        return {"capabilities": {"authentication": True}, "models": ["model-a"]}

    monkeypatch.setattr(GatewayProbe, "run", change_profile)
    with pytest.raises(GatewayError, match="changed during") as caught:
        profiles.test("enterprise", model="model-a")
    assert caught.value.category == "stale"
    assert profiles.get("enterprise").capabilities == {}
    with pytest.raises(GatewayError, match="unknown field"):
        profiles.save({**profile_payload(), "api_key": "secret"})


class FakeGatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: "FakeGatewayServer"

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.server.requests.append((self.path, dict(self.headers), None))
        if self.path != "/v1/models":
            self._send(404, {"error": {"message": "not found"}})
            return
        if self.headers.get("Authorization") != "Bearer gateway-secret":
            self._send(401, {"error": {"message": "gateway-secret rejected"}})
            return
        self._send(200, {"data": [{"id": "model-a"}, {"id": "model-b"}]})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length))
        self.server.requests.append((self.path, dict(self.headers), payload))
        if self.server.status != 200:
            self._send(
                self.server.status,
                {"error": {"message": "gateway-secret provider body must stay private"}},
            )
            return
        if self.server.delay:
            time.sleep(self.server.delay)
        with self.server.active_lock:
            self.server.active += 1
            self.server.maximum_active = max(self.server.maximum_active, self.server.active)
        try:
            time.sleep(0.03)
            message = (
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {"name": "okf_probe", "arguments": "{}"},
                        }
                    ],
                }
                if "tools" in payload
                else {"role": "assistant", "content": '{"ok":true}'}
            )
            self._send(
                200,
                {
                    "choices": [{"message": message}],
                    "usage": {
                        "prompt_tokens": 2,
                        "completion_tokens": 1,
                        "total_tokens": 3,
                    },
                },
            )
        finally:
            with self.server.active_lock:
                self.server.active -= 1

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class FakeGatewayServer(ThreadingHTTPServer):
    def __init__(self, *, status: int, delay: float) -> None:
        super().__init__(("127.0.0.1", 0), FakeGatewayHandler)
        self.requests: list[tuple[str, dict[str, str], dict | None]] = []
        self.status = status
        self.delay = delay
        self.active = 0
        self.maximum_active = 0
        self.active_lock = threading.Lock()


@contextmanager
def fake_gateway(*, status: int = 200, delay: float = 0):
    server = FakeGatewayServer(status=status, delay=delay)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_capability_probe_checks_models_schema_tools_usage_headers_and_concurrency(
    tmp_path: Path,
) -> None:
    with fake_gateway() as (server, base_url):
        profiles = registry(tmp_path)
        profiles.save(profile_payload(base_url), credential="gateway-secret")

        result = profiles.test("enterprise", model="model-a", timeout_seconds=1)

    assert result["ok"] is True
    assert result["error_mapping_basis"] == "live_authentication_and_client_contract"
    assert result["models"] == ["model-a", "model-b"]
    assert result["capabilities"] == {
        "authentication": True,
        "concurrency": True,
        "error_mapping": True,
        "model_discovery": True,
        "structured_output": True,
        "tool_calling": True,
        "usage_reporting": True,
    }
    assert server.maximum_active >= 2
    assert all(headers["X-Tenant"] == "docs" for _, headers, _ in server.requests)
    bodies = [body for _, _, body in server.requests if body]
    assert any(body.get("response_format", {}).get("type") == "json_schema" for body in bodies)
    assert any(body.get("tool_choice") == "required" for body in bodies)
    assert any(
        headers.get("Authorization")
        == "Bearer okf-wiki-deliberately-invalid-capability-probe"
        for _, headers, _ in server.requests
    )


@pytest.mark.parametrize(
    ("status", "category"), [(401, "authentication"), (429, "rate_limit"), (503, "gateway")]
)
def test_capability_failures_are_mapped_and_redacted(
    tmp_path: Path, status: int, category: str
) -> None:
    with fake_gateway(status=status) as (_server, base_url):
        profiles = registry(tmp_path)
        profiles.save(profile_payload(base_url), credential="gateway-secret")
        with pytest.raises(GatewayError) as caught:
            profiles.test("enterprise", model="model-a", timeout_seconds=1)

    assert caught.value.category == category
    assert "gateway-secret" not in str(caught.value)
    assert "provider body" not in str(caught.value)


def test_capability_timeout_is_safe(tmp_path: Path) -> None:
    with fake_gateway(delay=0.2) as (_server, base_url):
        profiles = registry(tmp_path)
        profiles.save(profile_payload(base_url), credential="gateway-secret")
        with pytest.raises(GatewayError, match="timed out") as caught:
            profiles.test("enterprise", model="model-a", timeout_seconds=0.05)
    assert caught.value.category == "timeout"


def test_unreachable_endpoint_is_mapped_without_connection_details(tmp_path: Path) -> None:
    profiles = registry(tmp_path)
    profiles.save(profile_payload("http://127.0.0.1:1/v1"), credential="gateway-secret")
    with pytest.raises(GatewayError, match="connection failed") as caught:
        profiles.test("enterprise", model="model-a", timeout_seconds=0.1)
    assert caught.value.category == "connection"
    assert "gateway-secret" not in str(caught.value)


def test_workspace_selection_is_local_reusable_and_run_snapshot_is_secret_free(
    tmp_path: Path,
) -> None:
    config_root = tmp_path / "machine"
    gateway = GatewayApplication(config_root)
    gateway.save_profile(profile_payload(), credential="shared-secret")
    workspaces = [tmp_path / "one", tmp_path / "two"]
    for root in workspaces:
        WorkspaceApplication(root).initialize(root.name)
        selected = gateway.select_workspace(
            root,
            profile_id="enterprise",
            default_model="model-a",
            concurrency=2,
            budgets={"total_tokens": 5000},
            role_overrides={"verifier": "model-b"},
        )
        assert selected["models"]["gateway_profile"] == "enterprise"

    snapshot = gateway.run_snapshot(workspaces[0])
    encoded = json.dumps(snapshot)
    assert snapshot["assignments"]["worker"] == "model-a"
    assert snapshot["assignments"]["verifier"] == "model-b"
    assert snapshot["profile"]["gateway_id"] == "corp-openai"
    assert snapshot["concurrency"] == 2
    assert snapshot["budgets"] == {"total_tokens": 5000}
    assert "shared-secret" not in encoded
    assert "credential" not in encoded
    assert "docs" not in encoded
    assert "shared-secret" not in (workspaces[0] / "workspace.toml").read_text()
    assert "shared-secret" not in (workspaces[0] / ".okf-wiki/settings.toml").read_text()


def test_default_config_root_can_be_overridden(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OKF_WIKI_CONFIG_HOME", str(tmp_path / "custom"))
    assert GatewayProfileRegistry().root == (tmp_path / "custom").resolve()


def test_gateway_cli_uses_application_seam_and_reads_credentials_from_stdin(tmp_path: Path) -> None:
    config_root = tmp_path / "machine"
    command = [sys.executable, "-m", "okf_wiki", "gateway"]
    saved = subprocess.run(
        [
            *command,
            "save",
            "enterprise",
            "--name",
            "Enterprise",
            "--gateway-id",
            "corp",
            "--base-url",
            "https://gateway.example/v1",
            "--credential-stdin",
            "--config-root",
            str(config_root),
        ],
        input="cli-secret\n",
        text=True,
        capture_output=True,
        check=False,
    )
    listed = subprocess.run(
        [*command, "list", "--config-root", str(config_root)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert saved.returncode == listed.returncode == 0
    assert json.loads(listed.stdout)["profiles"][0]["credential_configured"] is True
    assert "cli-secret" not in saved.stdout + saved.stderr + listed.stdout + listed.stderr
    assert "cli-secret" not in (config_root / "gateway-profiles.json").read_text()


def test_production_run_persists_resolved_nonsecret_gateway_snapshot(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("# Product\n\nThe product must be documented.\n")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()

    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [
                {
                    "id": "docs",
                    "role": "documentation",
                    "revision": revision,
                }
            ],
        },
        {"schema_version": 1, "checkouts": {"docs": str(source)}},
    )
    config_root = tmp_path / "machine"
    gateways = GatewayApplication(config_root)
    with fake_gateway() as (_server, base_url):
        gateways.save_profile(profile_payload(base_url), credential="gateway-secret")
        gateways.test_profile("enterprise", model="model-a", timeout_seconds=1)
    gateways.select_workspace(
        workspace,
        profile_id="enterprise",
        default_model="model-a",
        role_overrides={"verifier": "model-b"},
        concurrency=2,
        budgets={"total_tokens": 5000},
    )

    result = subprocess.run(
        [sys.executable, "-m", "okf_wiki", "build", "workspace.toml"],
        cwd=workspace,
        env={**os.environ, "OKF_WIKI_CONFIG_HOME": str(config_root)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    run_id = json.loads(result.stdout)["run_id"]
    with sqlite3.connect(workspace / ".okf-wiki" / "runs.db") as connection:
        persisted = json.loads(
            connection.execute(
                "SELECT source_set_json FROM runs WHERE id = ?", (run_id,)
            ).fetchone()[0]
        )["workspace_configuration"]["resolved_models"]

    assert persisted["assignments"]["verifier"] == "model-b"
    assert persisted["profile"]["gateway_id"] == "corp-openai"
    assert persisted["concurrency"] == 2
    assert persisted["capabilities"]["structured_output"] is True
    assert persisted["capabilities"]["tool_calling"] is True
    assert "gateway-secret" not in json.dumps(persisted)
    assert "credential" not in json.dumps(persisted)
