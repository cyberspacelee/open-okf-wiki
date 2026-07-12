import json
import os
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import tomllib
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from okf_wiki.cli import load_config
from okf_wiki.gateway_common import GatewayError
from okf_wiki.gateway_probe import GatewayProbe
from okf_wiki.gateway_profiles import (
    GatewayApplication,
    GatewayProfileRegistry,
)
from okf_wiki.gateway_secrets import (
    LinuxSecretToolBackend,
    LocalFileSecretBackend,
    MacOSSecurityBackend,
    SecretStore,
    WindowsCredentialBackend,
    system_secret_backend,
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


class UnreadSecretBackend(MemorySecretBackend):
    def __init__(self) -> None:
        super().__init__()
        self.unread = False
        self.puts = 0

    def put(self, profile_id: str, secret: str) -> None:
        self.puts += 1
        super().put(profile_id, secret)

    def get(self, profile_id: str) -> str:
        if self.unread:
            raise GatewayError("credential unavailable")
        return super().get(profile_id)


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


def test_credential_replacement_stops_when_previous_secret_is_unavailable(
    tmp_path: Path,
) -> None:
    backend = UnreadSecretBackend()
    profiles = registry(tmp_path, backend)
    profiles.save(profile_payload(), credential="old-secret")
    backend.unread = True

    with pytest.raises(GatewayError, match="credential unavailable"):
        profiles.save(profile_payload(), credential="new-secret", expected_revision=1)
    assert backend.values["enterprise"] == "old-secret"
    assert backend.puts == 1


def test_missing_credential_is_reported_without_profile_data(tmp_path: Path) -> None:
    profiles = registry(tmp_path)
    profiles.save(profile_payload())
    with pytest.raises(GatewayError, match="no credential") as caught:
        profiles.credential("enterprise")
    assert "gateway.example" not in str(caught.value)


def test_linux_secret_command_uses_stdin_and_never_echoes_secret(monkeypatch) -> None:
    calls: list[tuple[list[str], str | None]] = []

    def run(command, **kwargs):
        calls.append((command, kwargs.get("input")))
        return subprocess.CompletedProcess(command, 1, "", "secret-tool leaked gateway-secret")

    monkeypatch.setattr("okf_wiki.gateway_secrets.shutil.which", lambda _name: "/bin/secret-tool")
    monkeypatch.setattr("okf_wiki.gateway_secrets.subprocess.run", run)
    with pytest.raises(GatewayError) as caught:
        LinuxSecretToolBackend().put("enterprise", "gateway-secret")
    command, stdin = calls[-1]
    assert stdin == "gateway-secret"
    assert all("gateway-secret" not in argument for argument in command)
    assert "gateway-secret" not in str(caught.value)


def test_macos_keychain_uses_injected_framework_api_without_process_arguments(
    monkeypatch,
) -> None:
    class KeychainAPI:
        def __init__(self) -> None:
            self.values: dict[tuple[bytes, bytes], bytes] = {}
            self.calls: list[tuple[str, bytes, bytes, bytes | None]] = []

        def available(self) -> bool:
            return True

        def put(self, service: bytes, account: bytes, secret: bytes) -> None:
            self.calls.append(("put", service, account, secret))
            self.values[(service, account)] = secret

        def get(self, service: bytes, account: bytes) -> bytes | None:
            self.calls.append(("get", service, account, None))
            return self.values.get((service, account))

        def delete(self, service: bytes, account: bytes) -> None:
            self.calls.append(("delete", service, account, None))
            self.values.pop((service, account), None)

    monkeypatch.setattr(
        "okf_wiki.gateway_secrets.subprocess.run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not spawn")),
    )
    api = KeychainAPI()
    backend = MacOSSecurityBackend(api)
    backend.put("enterprise", "mac-secret")

    assert backend.get("enterprise") == "mac-secret"
    assert api.calls[0] == (
        "put",
        b"okf-wiki-gateway",
        b"enterprise",
        b"mac-secret",
    )
    backend.delete("enterprise")
    assert (b"okf-wiki-gateway", b"enterprise") not in api.values


def test_windows_credential_manager_uses_injected_api_without_process_arguments(
    monkeypatch,
) -> None:
    class CredentialAPI:
        def __init__(self) -> None:
            self.values: dict[str, bytes] = {}
            self.calls: list[tuple[str, str, bytes | None]] = []

        def available(self) -> bool:
            return True

        def put(self, target: str, secret: bytes) -> None:
            self.calls.append(("put", target, secret))
            self.values[target] = secret

        def get(self, target: str) -> bytes | None:
            self.calls.append(("get", target, None))
            return self.values.get(target)

        def delete(self, target: str) -> None:
            self.calls.append(("delete", target, None))
            self.values.pop(target, None)

    monkeypatch.setattr(
        "okf_wiki.gateway_secrets.subprocess.run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not spawn")),
    )
    api = CredentialAPI()
    backend = WindowsCredentialBackend(api)
    backend.put("enterprise", "windows-secret")

    assert backend.get("enterprise") == "windows-secret"
    assert api.calls[0] == (
        "put",
        "okf-wiki-gateway:enterprise",
        b"windows-secret",
    )
    backend.delete("enterprise")
    assert "okf-wiki-gateway:enterprise" not in api.values

    monkeypatch.setattr("okf_wiki.gateway_secrets.sys.platform", "win32")
    monkeypatch.setattr(
        "okf_wiki.gateway_secrets.CtypesWindowsCredentialManager",
        lambda: api,
    )
    selected = system_secret_backend()
    assert isinstance(selected, WindowsCredentialBackend)
    assert selected.api is api


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


@pytest.mark.parametrize(
    "base_url",
    [
        "http://localhost:8080/v1",
        "http://127.0.0.1:8080/v1",
        "http://127.1.2.3:8080/v1",
        "http://[::1]:8080/v1",
    ],
)
def test_cleartext_gateway_is_limited_to_loopback(tmp_path: Path, base_url: str) -> None:
    profiles = registry(tmp_path)
    assert profiles.save(profile_payload(base_url))["base_url"] == base_url

    with pytest.raises(GatewayError, match="must use https") as caught:
        profiles.save(
            profile_payload("http://gateway.example/v1"),
            credential="must-not-leak",
        )
    assert "must-not-leak" not in str(caught.value)


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
        return {
            "capabilities": {"authentication": True},
            "model": "model-a",
            "models": ["model-a"],
        }

    monkeypatch.setattr(GatewayProbe, "run", change_profile)
    with pytest.raises(GatewayError, match="changed during") as caught:
        profiles.test("enterprise", model="model-a")
    assert caught.value.category == "stale"
    assert profiles.get("enterprise").capabilities == {}
    with pytest.raises(GatewayError, match="unknown field"):
        profiles.save({**profile_payload(), "api_key": "secret"})


def test_capability_probe_captures_profile_and_credential_under_one_lock(
    tmp_path: Path, monkeypatch
) -> None:
    reading = threading.Event()
    release = threading.Event()
    saved = threading.Event()
    captured: list[tuple[str, str]] = []

    class CoordinatedBackend(MemorySecretBackend):
        def get(self, profile_id: str) -> str:
            if threading.current_thread().name == "capability-probe":
                reading.set()
                assert release.wait(timeout=2)
            return super().get(profile_id)

    backend = CoordinatedBackend()
    profiles = registry(tmp_path, backend)
    profiles.save(profile_payload("https://old.example/v1"), credential="old-secret")

    def run(probe, _model):
        assert saved.wait(timeout=2)
        captured.append((probe.profile.base_url, probe.secret))
        return {
            "capabilities": {"authentication": True},
            "model": "model-a",
            "models": ["model-a"],
        }

    monkeypatch.setattr(GatewayProbe, "run", run)

    def replace() -> None:
        profiles.save(
            profile_payload("https://new.example/v1"),
            credential="new-secret",
            expected_revision=1,
        )
        saved.set()

    result: list[BaseException] = []

    def probe() -> None:
        try:
            profiles.test("enterprise", model="model-a")
        except BaseException as error:
            result.append(error)

    probe_thread = threading.Thread(target=probe, name="capability-probe")
    probe_thread.start()
    assert reading.wait(timeout=2)
    replace_thread = threading.Thread(target=replace)
    replace_thread.start()
    release.set()
    probe_thread.join(timeout=2)
    replace_thread.join(timeout=2)

    assert captured == [("https://old.example/v1", "old-secret")]
    assert len(result) == 1
    assert isinstance(result[0], GatewayError)
    assert result[0].category == "stale"


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


class RedirectTargetHandler(BaseHTTPRequestHandler):
    server: "RedirectTargetServer"

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.server.requests.append(dict(self.headers))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")


class RedirectTargetServer(ThreadingHTTPServer):
    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), RedirectTargetHandler)
        self.requests: list[dict[str, str]] = []


class RedirectSourceHandler(BaseHTTPRequestHandler):
    server: "RedirectSourceServer"

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.send_response(302)
        self.send_header("Location", self.server.target_url)
        self.send_header("Content-Length", "0")
        self.end_headers()


class RedirectSourceServer(ThreadingHTTPServer):
    def __init__(self, target_url: str) -> None:
        super().__init__(("127.0.0.1", 0), RedirectSourceHandler)
        self.target_url = target_url


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


@contextmanager
def redirect_gateway():
    target = RedirectTargetServer()
    target_thread = threading.Thread(target=target.serve_forever)
    target_thread.start()
    source = RedirectSourceServer(f"http://127.0.0.1:{target.server_port}/capture")
    source_thread = threading.Thread(target=source.serve_forever)
    source_thread.start()
    try:
        yield source, target
    finally:
        source.shutdown()
        target.shutdown()
        source.server_close()
        target.server_close()
        source_thread.join()
        target_thread.join()


def test_capability_probe_checks_models_schema_tools_usage_headers_and_concurrency(
    tmp_path: Path,
) -> None:
    with fake_gateway() as (server, base_url):
        profiles = registry(tmp_path)
        profiles.save(profile_payload(base_url), credential="gateway-secret")

        result = profiles.test("enterprise", model="model-a", timeout_seconds=1)
        replaced = profiles.save(
            profile_payload(base_url),
            credential="invalid-new-secret",
            expected_revision=2,
        )
        with pytest.raises(GatewayError) as invalid:
            profiles.test("enterprise", model="model-a", timeout_seconds=1)

    assert result["ok"] is True
    assert result["error_mapping_basis"] == "live_invalid_authentication_and_not_found"
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
        headers.get("Authorization") == "Bearer okf-wiki-deliberately-invalid-capability-probe"
        for _, headers, _ in server.requests
    )
    assert any(
        path.endswith("okf-wiki-capability-probe-not-found") for path, _, _ in server.requests
    )

    assert replaced["capabilities"] == {}
    assert replaced["models"] == []
    assert invalid.value.category == "authentication"


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


def test_failed_retest_invalidates_model_specific_or_all_global_capabilities(
    tmp_path: Path, monkeypatch
) -> None:
    profiles = registry(tmp_path)
    profiles.save(profile_payload(), credential="gateway-secret")
    outcomes = iter(
        [
            {
                "capabilities": {"authentication": True},
                "model": "model-a",
                "models": ["model-a", "model-b"],
            },
            {
                "capabilities": {"authentication": True},
                "model": "model-b",
                "models": ["model-a", "model-b"],
            },
        ]
    )
    monkeypatch.setattr(GatewayProbe, "run", lambda _probe, _model: next(outcomes))
    profiles.test("enterprise", model="model-a")
    profiles.test("enterprise", model="model-b")

    def fail_model(_probe, _model):
        raise GatewayError(
            "Gateway does not satisfy structured output",
            category="capability",
            model_specific=True,
        )

    monkeypatch.setattr(GatewayProbe, "run", fail_model)
    with pytest.raises(GatewayError, match="structured output"):
        profiles.test("enterprise", model="model-a")

    saved = profiles.get("enterprise")
    assert set(saved.capabilities) == {"model-b"}
    assert saved.capabilities["model-b"]["authentication"] is True

    monkeypatch.setattr(
        GatewayProbe,
        "run",
        lambda _probe, _model: {
            "capabilities": {"authentication": True},
            "model": "model-a",
            "models": ["model-a", "model-b"],
        },
    )
    profiles.test("enterprise", model="model-a")

    def fail_global(_probe, _model):
        raise GatewayError("Gateway authentication was rejected", category="authentication")

    monkeypatch.setattr(GatewayProbe, "run", fail_global)
    with pytest.raises(GatewayError, match="authentication was rejected"):
        profiles.test("enterprise", model="model-a")
    assert profiles.get("enterprise").capabilities == {}


def test_capability_timeout_is_safe(tmp_path: Path) -> None:
    with fake_gateway(delay=0.2) as (_server, base_url):
        profiles = registry(tmp_path)
        profiles.save(profile_payload(base_url), credential="gateway-secret")
        with pytest.raises(GatewayError, match="timed out") as caught:
            profiles.test("enterprise", model="model-a", timeout_seconds=0.05)
    assert caught.value.category == "timeout"


def test_gateway_redirect_is_rejected_without_forwarding_sensitive_headers(
    tmp_path: Path,
) -> None:
    with redirect_gateway() as (source, target):
        profiles = registry(tmp_path)
        profiles.save(
            profile_payload(f"http://127.0.0.1:{source.server_port}/v1"),
            credential="redirect-secret",
        )
        with pytest.raises(GatewayError, match="redirect was rejected") as caught:
            profiles.test("enterprise", model="model-a", timeout_seconds=1)

    assert caught.value.category == "redirect"
    assert target.requests == []
    assert "redirect-secret" not in str(caught.value)
    assert "docs" not in str(caught.value)


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
    with fake_gateway() as (_server, base_url):
        gateway.save_profile(profile_payload(base_url), credential="gateway-secret")
        with pytest.raises(GatewayError, match="model-a, model-b"):
            gateway.select_workspace(
                tmp_path / "missing",
                profile_id="enterprise",
                default_model="model-a",
                role_overrides={"verifier": "model-b"},
            )
        gateway.test_profile("enterprise", model="model-a", timeout_seconds=1)
        with pytest.raises(GatewayError, match="model-b"):
            gateway.select_workspace(
                tmp_path / "missing",
                profile_id="enterprise",
                default_model="model-a",
                role_overrides={"verifier": "model-b"},
            )
        gateway.test_profile("enterprise", model="model-b", timeout_seconds=1)
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
    assert set(snapshot["capabilities"]) == {"model-a", "model-b"}
    assert snapshot["capabilities"]["model-a"]["structured_output"] is True
    assert snapshot["capabilities"]["model-b"]["tool_calling"] is True
    assert "gateway-secret" not in encoded
    assert "credential" not in encoded
    assert "docs" not in encoded
    assert "gateway-secret" not in (workspaces[0] / "workspace.toml").read_text()
    assert "gateway-secret" not in (workspaces[0] / ".okf-wiki/settings.toml").read_text()


def test_build_configuration_resolves_models_from_the_same_workspace_snapshot(
    tmp_path: Path, monkeypatch
) -> None:
    workspace = tmp_path / "workspace"
    source = tmp_path / "source"
    source.mkdir()
    app = WorkspaceApplication(workspace)
    app.initialize("catalog")
    app.update(
        {
            "schema_version": 1,
            "project": {"id": "catalog", "name": "Catalog"},
            "sources": [{"id": "docs", "role": "documentation", "revision": "abc"}],
        },
        {"schema_version": 1, "checkouts": {"docs": str(source)}},
    )
    config_root = tmp_path / "machine"
    gateways = GatewayApplication(config_root)
    with fake_gateway() as (_server, base_url):
        gateways.save_profile(profile_payload(base_url), credential="gateway-secret")
        gateways.test_profile("enterprise", model="model-a", timeout_seconds=1)
        gateways.test_profile("enterprise", model="model-b", timeout_seconds=1)
    gateways.select_workspace(
        workspace,
        profile_id="enterprise",
        default_model="model-a",
    )
    monkeypatch.setenv("OKF_WIKI_CONFIG_HOME", str(config_root))
    real_open = WorkspaceApplication.open
    calls = 0

    def open_then_change(self):
        nonlocal calls
        snapshot = real_open(self)
        if self.root == workspace:
            calls += 1
            if calls == 1:
                gateways.select_workspace(
                    workspace,
                    profile_id="enterprise",
                    default_model="model-b",
                )
        return snapshot

    monkeypatch.setattr(WorkspaceApplication, "open", open_then_change)
    configuration = load_config(str(workspace / "workspace.toml"))[4]

    assert calls == 1
    assert configuration is not None
    assert configuration["resolved_models"]["default_model"] == "model-a"
    persisted = tomllib.loads(app.settings_path.read_text())
    assert persisted["models"]["default_model"] == "model-b"


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
        gateways.test_profile("enterprise", model="model-b", timeout_seconds=1)
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
    assert persisted["capabilities"]["model-a"]["structured_output"] is True
    assert persisted["capabilities"]["model-b"]["tool_calling"] is True
    assert "gateway-secret" not in json.dumps(persisted)
    assert "credential" not in json.dumps(persisted)
