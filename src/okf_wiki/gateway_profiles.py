import concurrent.futures
import builtins
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Literal, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .workspace import ModelSettings, WorkspaceApplication, WorkspaceError


PROFILE_SCHEMA_VERSION = 1
AGENT_ROLES = ("planner", "worker", "verifier", "renderer", "query")
PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


class GatewayError(ValueError):
    def __init__(self, message: str, *, category: str = "configuration") -> None:
        super().__init__(message)
        self.category = category


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class GatewayProfileInput(StrictModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1)
    gateway_id: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    headers: dict[str, str] = Field(default_factory=dict)

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        if PROFILE_ID.fullmatch(value) is None:
            raise ValueError("must contain only letters, numbers, dot, underscore, or dash")
        return value

    @field_validator("name", "gateway_id")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("must be an http or https URL with a host")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("must not contain user information")
        if parsed.query or parsed.fragment:
            raise ValueError("must not contain a query or fragment")
        return value

    @field_validator("headers")
    @classmethod
    def safe_headers(cls, headers: dict[str, str]) -> dict[str, str]:
        for name, value in headers.items():
            normalized = name.casefold().replace("-", "_")
            if (
                HEADER_NAME.fullmatch(name) is None
                or not value.strip()
                or "\n" in value
                or "\r" in value
            ):
                raise ValueError("headers must use non-empty single-line names and values")
            if any(
                marker in normalized
                for marker in ("authorization", "api_key", "token", "secret", "credential", "cookie")
            ):
                raise ValueError(f"secret-bearing header '{name}' must use the credential field")
        return headers


class GatewayProfile(StrictModel):
    schema_version: Literal[1] = PROFILE_SCHEMA_VERSION
    id: str
    name: str
    gateway_id: str
    base_url: str
    headers: dict[str, str] = Field(default_factory=dict)
    credential_backend: str | None = None
    capabilities: dict[str, bool] = Field(default_factory=dict)
    models: list[str] = Field(default_factory=list)
    revision: int = Field(ge=1)

    def public(self) -> dict:
        value = self.model_dump(mode="json")
        value["header_names"] = sorted(value.pop("headers"))
        value["credential_configured"] = self.credential_backend is not None
        return value


class SecretBackend(Protocol):
    name: str

    def available(self) -> bool: ...

    def put(self, profile_id: str, secret: str) -> None: ...

    def get(self, profile_id: str) -> str: ...

    def delete(self, profile_id: str) -> None: ...


class CommandSecretBackend:
    def _run(self, command: list[str], *, secret: str | None = None) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(
                command,
                input=secret,
                text=True,
                capture_output=True,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise GatewayError("operating-system credential store unavailable") from error


class LinuxSecretToolBackend(CommandSecretBackend):
    name = "linux-secret-tool"
    executable = "secret-tool"

    def available(self) -> bool:
        return shutil.which(self.executable) is not None

    def put(self, profile_id: str, secret: str) -> None:
        result = self._run(
            [self.executable, "store", "--label=OKF Wiki gateway", "service", "okf-wiki", "profile", profile_id],
            secret=secret,
        )
        if result.returncode:
            raise GatewayError("operating-system credential store unavailable")

    def get(self, profile_id: str) -> str:
        result = self._run(
            [self.executable, "lookup", "service", "okf-wiki", "profile", profile_id]
        )
        value = result.stdout.rstrip("\n")
        if result.returncode or not value:
            raise GatewayError("gateway credential unavailable")
        return value

    def delete(self, profile_id: str) -> None:
        self._run([self.executable, "clear", "service", "okf-wiki", "profile", profile_id])


class MacOSSecurityBackend(CommandSecretBackend):
    name = "macos-keychain"
    executable = "security"
    service = "okf-wiki-gateway"

    def available(self) -> bool:
        return shutil.which(self.executable) is not None

    def put(self, profile_id: str, secret: str) -> None:
        result = self._run(
            [
                self.executable,
                "add-generic-password",
                "-U",
                "-a",
                profile_id,
                "-s",
                self.service,
                "-w",
            ],
            secret=secret,
        )
        if result.returncode:
            raise GatewayError("operating-system credential store unavailable")

    def get(self, profile_id: str) -> str:
        result = self._run(
            [
                self.executable,
                "find-generic-password",
                "-a",
                profile_id,
                "-s",
                self.service,
                "-w",
            ]
        )
        value = result.stdout.rstrip("\n")
        if result.returncode or not value:
            raise GatewayError("gateway credential unavailable")
        return value

    def delete(self, profile_id: str) -> None:
        self._run(
            [
                self.executable,
                "delete-generic-password",
                "-a",
                profile_id,
                "-s",
                self.service,
            ]
        )


class LocalFileSecretBackend:
    name = "local-file-0600"

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def available(self) -> bool:
        return True

    def _path(self, profile_id: str) -> Path:
        if PROFILE_ID.fullmatch(profile_id) is None:
            raise GatewayError("invalid Gateway Profile ID")
        return self.root / f"{profile_id}.secret"

    def put(self, profile_id: str, secret: str) -> None:
        path = self._path(profile_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.parent.chmod(0o700)
            _atomic_write(path, secret, 0o600)
        except OSError as error:
            raise GatewayError("cannot write the restricted local credential store") from error

    def get(self, profile_id: str) -> str:
        path = self._path(profile_id)
        try:
            if path.parent.stat().st_mode & 0o077:
                raise GatewayError("local credential directory permissions are too broad")
            mode = path.stat().st_mode
            if mode & (stat_bits := 0o077):
                raise GatewayError(
                    f"local credential permissions are too broad ({oct(mode & stat_bits)})"
                )
            value = path.read_text(encoding="utf-8")
        except OSError as error:
            raise GatewayError("gateway credential unavailable") from error
        if not value:
            raise GatewayError("gateway credential unavailable")
        return value

    def delete(self, profile_id: str) -> None:
        try:
            self._path(profile_id).unlink(missing_ok=True)
        except OSError as error:
            raise GatewayError("cannot remove the local credential") from error


class SecretStore:
    def __init__(self, *, primary: SecretBackend | None, fallback: SecretBackend) -> None:
        self.primary = primary
        self.fallback = fallback

    def put(self, profile_id: str, secret: str) -> str:
        if not secret:
            raise GatewayError("credential must not be empty")
        if self.primary is not None and self.primary.available():
            try:
                self.primary.put(profile_id, secret)
                return self.primary.name
            except GatewayError:
                pass
        self.fallback.put(profile_id, secret)
        return self.fallback.name

    def get(self, profile_id: str, backend: str) -> str:
        for candidate in (self.primary, self.fallback):
            if candidate is not None and candidate.name == backend and candidate.available():
                return candidate.get(profile_id)
        raise GatewayError("gateway credential unavailable")

    def restore(self, profile_id: str, secret: str, backend: str) -> None:
        for candidate in (self.primary, self.fallback):
            if candidate is not None and candidate.name == backend and candidate.available():
                candidate.put(profile_id, secret)
                return
        raise GatewayError("cannot restore the previous gateway credential")

    def delete(self, profile_id: str, backend: str | None) -> None:
        for candidate in (self.primary, self.fallback):
            if candidate is not None and candidate.name == backend and candidate.available():
                candidate.delete(profile_id)


def _default_config_root() -> Path:
    explicit = os.environ.get("OKF_WIKI_CONFIG_HOME")
    if explicit:
        return Path(explicit).expanduser().resolve()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".config"
    return (base / "okf-wiki").resolve()


def _system_backend() -> SecretBackend | None:
    if sys.platform == "darwin":
        return MacOSSecurityBackend()
    if sys.platform.startswith("linux"):
        return LinuxSecretToolBackend()
    return None


def _atomic_write(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


class GatewayProfileRegistry:
    def __init__(
        self,
        root: Path | str | None = None,
        *,
        secret_store: SecretStore | None = None,
    ) -> None:
        self.root = (Path(root).resolve() if root is not None else _default_config_root())
        self.path = self.root / "gateway-profiles.json"
        self.lock_path = self.root / "gateway-profiles-lock.db"
        self.secret_store = secret_store or SecretStore(
            primary=_system_backend(),
            fallback=LocalFileSecretBackend(self.root / "credentials"),
        )

    def list(self) -> builtins.list[dict]:
        with self._locked():
            profiles = self._load()
        return [profile.public() for profile in sorted(profiles.values(), key=lambda p: p.name)]

    def get(self, profile_id: str) -> GatewayProfile:
        with self._locked():
            profile = self._load().get(profile_id)
        if profile is None:
            raise GatewayError("Gateway Profile not found", category="not_found")
        return profile

    def save(
        self,
        payload: Mapping[str, object],
        *,
        credential: str | None = None,
        expected_revision: int | None = None,
    ) -> dict:
        value = self._validate_input(payload)
        with self._locked():
            profiles = self._load()
            current = profiles.get(value.id)
            current_revision = current.revision if current else 0
            if expected_revision is not None and expected_revision != current_revision:
                raise GatewayError("stale Gateway Profile revision", category="stale")
            backend = current.credential_backend if current else None
            previous_backend = backend
            previous_secret = None
            if credential is not None:
                if previous_backend is not None:
                    try:
                        previous_secret = self.secret_store.get(value.id, previous_backend)
                    except GatewayError:
                        pass
                backend = self.secret_store.put(value.id, credential)
            connection_changed = current is None or any(
                getattr(current, field) != getattr(value, field)
                for field in ("gateway_id", "base_url", "headers")
            )
            profiles[value.id] = GatewayProfile(
                **value.model_dump(),
                credential_backend=backend,
                capabilities={} if connection_changed else current.capabilities,
                models=[] if connection_changed else current.models,
                revision=current_revision + 1,
            )
            try:
                self._write(profiles)
            except GatewayError:
                if credential is not None:
                    if (
                        previous_backend is not None
                        and previous_backend == backend
                        and previous_secret is not None
                    ):
                        self.secret_store.restore(value.id, previous_secret, previous_backend)
                    elif previous_backend != backend:
                        self.secret_store.delete(value.id, backend)
                raise
            if (
                credential is not None
                and previous_backend is not None
                and previous_backend != backend
            ):
                self.secret_store.delete(value.id, previous_backend)
            return profiles[value.id].public()

    def delete(self, profile_id: str, *, expected_revision: int | None = None) -> None:
        with self._locked():
            profiles = self._load()
            profile = profiles.get(profile_id)
            if profile is None:
                raise GatewayError("Gateway Profile not found", category="not_found")
            if expected_revision is not None and expected_revision != profile.revision:
                raise GatewayError("stale Gateway Profile revision", category="stale")
            del profiles[profile_id]
            self._write(profiles)
            self.secret_store.delete(profile_id, profile.credential_backend)

    def credential(self, profile_id: str) -> str:
        profile = self.get(profile_id)
        if profile.credential_backend is None:
            raise GatewayError("Gateway Profile has no credential", category="authentication")
        return self.secret_store.get(profile_id, profile.credential_backend)

    def test(self, profile_id: str, *, model: str | None = None, timeout_seconds: float = 10) -> dict:
        if timeout_seconds <= 0:
            raise GatewayError("timeout must be positive")
        profile = self.get(profile_id)
        secret = self.credential(profile_id)
        client = GatewayProbe(profile, secret, timeout_seconds)
        result = client.run(model)
        with self._locked():
            profiles = self._load()
            current = profiles.get(profile_id)
            if current is None:
                raise GatewayError("Gateway Profile not found", category="not_found")
            if current.revision != profile.revision:
                raise GatewayError(
                    "Gateway Profile changed during capability testing",
                    category="stale",
                )
            profiles[profile_id] = current.model_copy(
                update={
                    "capabilities": result["capabilities"],
                    "models": result["models"],
                    "revision": current.revision + 1,
                }
            )
            self._write(profiles)
        return result

    def _validate_input(self, payload: Mapping[str, object]) -> GatewayProfileInput:
        try:
            return GatewayProfileInput.model_validate(payload)
        except ValidationError as error:
            item = error.errors()[0]
            location = ".".join(str(part) for part in item["loc"])
            kind = "unknown field" if item["type"] == "extra_forbidden" else "invalid field"
            raise GatewayError(f"{kind} '{location}': {item['msg']}") from error

    def _load(self) -> dict[str, GatewayProfile]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or set(payload) != {"schema_version", "profiles"}:
                raise ValueError("invalid registry shape")
            if payload["schema_version"] != PROFILE_SCHEMA_VERSION or not isinstance(
                payload["profiles"], list
            ):
                raise ValueError("unsupported registry schema")
            profiles = []
            for item in payload["profiles"]:
                if not isinstance(item, dict):
                    raise ValueError("invalid Gateway Profile")
                GatewayProfileInput.model_validate(
                    {key: item.get(key) for key in ("id", "name", "gateway_id", "base_url", "headers")}
                )
                profiles.append(GatewayProfile.model_validate(item))
            if len({profile.id for profile in profiles}) != len(profiles):
                raise ValueError("duplicate Gateway Profile ID")
            return {profile.id: profile for profile in profiles}
        except (OSError, ValueError, json.JSONDecodeError, ValidationError) as error:
            raise GatewayError("Gateway Profile registry is invalid") from error

    def _write(self, profiles: Mapping[str, GatewayProfile]) -> None:
        try:
            _atomic_write(
                self.path,
                json.dumps(
                    {
                        "schema_version": PROFILE_SCHEMA_VERSION,
                        "profiles": [
                            profiles[key].model_dump(mode="json")
                            for key in sorted(profiles)
                        ],
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                0o600,
            )
        except OSError as error:
            raise GatewayError("cannot save the Gateway Profile registry") from error

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self.root.mkdir(parents=True, exist_ok=True)
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(self.lock_path, timeout=30)
            connection.execute("BEGIN IMMEDIATE")
            yield
        except sqlite3.Error as error:
            raise GatewayError("cannot lock Gateway Profile registry") from error
        finally:
            if connection is not None:
                connection.rollback()
                connection.close()


class GatewayProbe:
    def __init__(self, profile: GatewayProfile, secret: str, timeout_seconds: float) -> None:
        self.profile = profile
        self.secret = secret
        self.timeout_seconds = timeout_seconds

    def run(self, model: str | None) -> dict:
        models_payload = self._request("GET", "models")
        raw_models = models_payload.get("data")
        if not isinstance(raw_models, list):
            raise GatewayError("Gateway model discovery returned an invalid response", category="capability")
        models = [item["id"] for item in raw_models if isinstance(item, dict) and isinstance(item.get("id"), str)]
        if not models:
            raise GatewayError("Gateway model discovery returned no models", category="capability")
        selected = model or models[0]
        if selected not in models:
            raise GatewayError("Selected model is not available from the Gateway", category="capability")
        try:
            self._request(
                "GET",
                "models",
                credential="okf-wiki-deliberately-invalid-capability-probe",
            )
        except GatewayError as error:
            if error.category != "authentication":
                raise GatewayError(
                    "Gateway does not map invalid authentication safely",
                    category="capability",
                ) from None
        else:
            raise GatewayError(
                "Gateway accepted an invalid authentication credential",
                category="capability",
            )

        schema_payload = {
            "model": selected,
            "messages": [{"role": "user", "content": "Return ok=true."}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "okf_gateway_probe",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {"ok": {"type": "boolean"}},
                        "required": ["ok"],
                        "additionalProperties": False,
                    },
                },
            },
        }
        structured = self._request("POST", "chat/completions", schema_payload)
        self._validate_structured(structured)
        self._validate_usage(structured)

        tool_payload = {
            "model": selected,
            "messages": [{"role": "user", "content": "Call the probe tool."}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "okf_probe",
                        "description": "Verify function tool calling.",
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "required": [],
                            "additionalProperties": False,
                        },
                    },
                }
            ],
            "tool_choice": "required",
        }
        tool_result = self._request("POST", "chat/completions", tool_payload)
        self._validate_tools(tool_result)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(self._request, "POST", "chat/completions", schema_payload)
                for _ in range(2)
            ]
            for future in futures:
                self._validate_structured(future.result())

        return {
            "ok": True,
            "model": selected,
            "models": models,
            "error_mapping_basis": "live_authentication_and_client_contract",
            "capabilities": {
                "authentication": True,
                "concurrency": True,
                "error_mapping": _error_mapping_verified(),
                "model_discovery": True,
                "structured_output": True,
                "tool_calling": True,
                "usage_reporting": True,
            },
        }

    def _request(
        self,
        method: str,
        endpoint: str,
        payload: dict | None = None,
        *,
        credential: str | None = None,
    ) -> dict:
        body = json.dumps(payload).encode() if payload is not None else None
        request = Request(
            f"{self.profile.base_url}/{endpoint}",
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {credential or self.secret}",
                **self.profile.headers,
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read(1_048_577)
        except HTTPError as error:
            status = error.code
            error.close()
            raise _status_error(status) from None
        except (TimeoutError, socket.timeout):
            raise GatewayError("Gateway request timed out", category="timeout") from None
        except URLError as error:
            if isinstance(error.reason, (TimeoutError, socket.timeout)):
                raise GatewayError("Gateway request timed out", category="timeout") from None
            raise GatewayError("Gateway connection failed", category="connection") from None
        except OSError:
            raise GatewayError("Gateway connection failed", category="connection") from None
        if len(raw) > 1_048_576:
            raise GatewayError("Gateway response exceeded the size limit", category="capability")
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            raise GatewayError("Gateway returned invalid JSON", category="capability") from None
        if not isinstance(value, dict):
            raise GatewayError("Gateway returned an invalid response", category="capability")
        return value

    @staticmethod
    def _message(payload: dict) -> dict:
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise GatewayError("Gateway chat response is missing a choice", category="capability")
        message = choices[0].get("message")
        if not isinstance(message, dict):
            raise GatewayError("Gateway chat response is missing a message", category="capability")
        return message

    def _validate_structured(self, payload: dict) -> None:
        content = self._message(payload).get("content")
        try:
            value = json.loads(content) if isinstance(content, str) else None
        except json.JSONDecodeError:
            value = None
        if value != {"ok": True}:
            raise GatewayError("Gateway does not satisfy structured output", category="capability")

    def _validate_tools(self, payload: dict) -> None:
        calls = self._message(payload).get("tool_calls")
        if not isinstance(calls, list) or not calls:
            raise GatewayError("Gateway does not satisfy function tool calling", category="capability")
        function = calls[0].get("function") if isinstance(calls[0], dict) else None
        if not isinstance(function, dict) or function.get("name") != "okf_probe":
            raise GatewayError("Gateway returned an invalid function tool call", category="capability")

    @staticmethod
    def _validate_usage(payload: dict) -> None:
        usage = payload.get("usage")
        names = ("prompt_tokens", "completion_tokens", "total_tokens")
        if not isinstance(usage, dict) or any(not isinstance(usage.get(name), int) for name in names):
            raise GatewayError("Gateway does not report token usage", category="capability")


def _status_error(status: int) -> GatewayError:
    if status in {401, 403}:
        return GatewayError("Gateway authentication was rejected", category="authentication")
    if status == 429:
        return GatewayError("Gateway rate limit was reached", category="rate_limit")
    if 500 <= status <= 599:
        return GatewayError("Gateway service failed", category="gateway")
    return GatewayError(f"Gateway request failed with HTTP {status}", category="request")


def _error_mapping_verified() -> bool:
    return all(
        _status_error(status).category == category
        for status, category in ((401, "authentication"), (429, "rate_limit"), (503, "gateway"))
    )


class GatewayApplication:
    def __init__(
        self,
        config_root: Path | str | None = None,
        *,
        registry: GatewayProfileRegistry | None = None,
    ) -> None:
        self.registry = registry or GatewayProfileRegistry(config_root)

    def list_profiles(self) -> list[dict]:
        return self.registry.list()

    def save_profile(
        self,
        payload: Mapping[str, object],
        *,
        credential: str | None = None,
        expected_revision: int | None = None,
    ) -> dict:
        return self.registry.save(
            payload,
            credential=credential,
            expected_revision=expected_revision,
        )

    def test_profile(
        self, profile_id: str, *, model: str | None = None, timeout_seconds: float = 10
    ) -> dict:
        return self.registry.test(profile_id, model=model, timeout_seconds=timeout_seconds)

    def select_workspace(
        self,
        root: Path | str,
        *,
        profile_id: str,
        default_model: str,
        concurrency: int = 4,
        budgets: Mapping[str, int] | None = None,
        role_overrides: Mapping[str, str] | None = None,
    ) -> dict:
        self.registry.get(profile_id)
        overrides = dict(role_overrides or {})
        unknown_roles = sorted(set(overrides) - set(AGENT_ROLES))
        if unknown_roles:
            raise GatewayError("unknown Agent Roles: " + ", ".join(unknown_roles))
        app = WorkspaceApplication(root)
        try:
            snapshot = app.configure_models(
                ModelSettings(
                    gateway_profile=profile_id,
                    default_model=default_model,
                    concurrency=concurrency,
                    budgets=dict(budgets or {}),
                    role_overrides=overrides,
                )
            )
            return snapshot.model_dump(mode="json")
        except (ValidationError, WorkspaceError) as error:
            raise GatewayError(str(error)) from error

    def run_snapshot(self, root: Path | str, *, allow_missing: bool = False) -> dict:
        models = WorkspaceApplication(root).open().models
        if models.gateway_profile is None or models.default_model is None:
            raise GatewayError("Workspace has no selected Gateway Profile or default model")
        unknown_roles = sorted(set(models.role_overrides) - set(AGENT_ROLES))
        if unknown_roles:
            raise GatewayError("unknown Agent Roles: " + ", ".join(unknown_roles))
        assignments = {
            role: models.role_overrides.get(role, models.default_model) for role in AGENT_ROLES
        }
        try:
            profile = self.registry.get(models.gateway_profile)
        except GatewayError as error:
            if not allow_missing or error.category != "not_found":
                raise
            # ponytail: deterministic pre-registry Runs remain auditable; Ticket 08 can
            # require a registered profile before semantic execution starts.
            return {
                "profile": {"id": models.gateway_profile, "registered": False},
                "default_model": models.default_model,
                "assignments": assignments,
                "concurrency": models.concurrency,
                "budgets": models.budgets,
                "capabilities": {},
            }
        return {
            "profile": {
                "id": profile.id,
                "name": profile.name,
                "gateway_id": profile.gateway_id,
                "base_url": profile.base_url,
                "header_names": sorted(profile.headers),
                "revision": profile.revision,
                "registered": True,
            },
            "default_model": models.default_model,
            "assignments": assignments,
            "concurrency": models.concurrency,
            "budgets": models.budgets,
            "capabilities": profile.capabilities,
        }
