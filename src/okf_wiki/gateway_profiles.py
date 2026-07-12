import builtins
import ipaddress
import json
import os
import re
import sqlite3
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .gateway_common import PROFILE_ID, GatewayError, atomic_write
from .gateway_probe import GatewayProbe
from .gateway_secrets import (
    LocalFileSecretBackend,
    SecretStore,
    system_secret_backend,
)
from .workspace import ModelSettings, WorkspaceApplication, WorkspaceError


PROFILE_SCHEMA_VERSION = 1
AGENT_ROLES = ("planner", "worker", "verifier", "renderer", "query")
HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


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
        if parsed.scheme == "http" and not _is_loopback_host(parsed.hostname):
            raise ValueError("must use https unless the host is localhost or loopback")
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
                for marker in (
                    "authorization",
                    "api_key",
                    "token",
                    "secret",
                    "credential",
                    "cookie",
                )
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
    capabilities: dict[str, dict[str, bool]] = Field(default_factory=dict)
    models: list[str] = Field(default_factory=list)
    revision: int = Field(ge=1)

    def public(self) -> dict:
        value = self.model_dump(mode="json")
        value["header_names"] = sorted(value.pop("headers"))
        value["credential_configured"] = self.credential_backend is not None
        return value


def _default_config_root() -> Path:
    explicit = os.environ.get("OKF_WIKI_CONFIG_HOME")
    if explicit:
        return Path(explicit).expanduser().resolve()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".config"
    return (base / "okf-wiki").resolve()


class GatewayProfileRegistry:
    def __init__(
        self,
        root: Path | str | None = None,
        *,
        secret_store: SecretStore | None = None,
    ) -> None:
        self.root = Path(root).resolve() if root is not None else _default_config_root()
        self.path = self.root / "gateway-profiles.json"
        self.lock_path = self.root / "gateway-profiles-lock.db"
        self.secret_store = secret_store or SecretStore(
            primary=system_secret_backend(),
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
                    previous_secret = self.secret_store.get(value.id, previous_backend)
                backend = self.secret_store.put(value.id, credential)
            connection_changed = (
                current is None
                or any(
                    getattr(current, field) != getattr(value, field)
                    for field in ("gateway_id", "base_url", "headers")
                )
                or credential is not None
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

    def test(
        self, profile_id: str, *, model: str | None = None, timeout_seconds: float = 10
    ) -> dict:
        if timeout_seconds <= 0:
            raise GatewayError("timeout must be positive")
        with self._locked():
            profile = self._load().get(profile_id)
            if profile is None:
                raise GatewayError("Gateway Profile not found", category="not_found")
            if profile.credential_backend is None:
                raise GatewayError(
                    "Gateway Profile has no credential",
                    category="authentication",
                )
            secret = self.secret_store.get(profile_id, profile.credential_backend)
        client = GatewayProbe(profile, secret, timeout_seconds)
        try:
            result = client.run(model)
        except GatewayError as error:
            self._invalidate_capabilities(
                profile,
                model if error.model_specific else None,
            )
            raise
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
            discovered_models = result["models"]
            tested_model = result["model"]
            capabilities = {
                name: value
                for name, value in current.capabilities.items()
                if name in discovered_models
            }
            capabilities[tested_model] = result["capabilities"]
            profiles[profile_id] = current.model_copy(
                update={
                    "capabilities": capabilities,
                    "models": discovered_models,
                    "revision": current.revision + 1,
                }
            )
            self._write(profiles)
        return result

    def _invalidate_capabilities(self, profile: GatewayProfile, model: str | None) -> None:
        with self._locked():
            profiles = self._load()
            current = profiles.get(profile.id)
            if current is None or current.revision != profile.revision:
                return
            capabilities = dict(current.capabilities)
            if model is None:
                capabilities.clear()
            else:
                capabilities.pop(model, None)
            if capabilities == current.capabilities:
                return
            profiles[profile.id] = current.model_copy(
                update={
                    "capabilities": capabilities,
                    "revision": current.revision + 1,
                }
            )
            self._write(profiles)

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
                    {
                        key: item.get(key)
                        for key in ("id", "name", "gateway_id", "base_url", "headers")
                    }
                )
                profiles.append(GatewayProfile.model_validate(item))
            if len({profile.id for profile in profiles}) != len(profiles):
                raise ValueError("duplicate Gateway Profile ID")
            return {profile.id: profile for profile in profiles}
        except (OSError, ValueError, json.JSONDecodeError, ValidationError) as error:
            raise GatewayError("Gateway Profile registry is invalid") from error

    def _write(self, profiles: Mapping[str, GatewayProfile]) -> None:
        try:
            atomic_write(
                self.path,
                json.dumps(
                    {
                        "schema_version": PROFILE_SCHEMA_VERSION,
                        "profiles": [
                            profiles[key].model_dump(mode="json") for key in sorted(profiles)
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
        overrides = dict(role_overrides or {})
        app = WorkspaceApplication(root)
        try:
            settings = ModelSettings(
                gateway_profile=profile_id,
                default_model=default_model,
                concurrency=concurrency,
                budgets=dict(budgets or {}),
                role_overrides=overrides,
            )
            # Selection records local intent. Ticket08 applies the release Benchmark
            # Corpus and Agent Evaluation policy before semantic execution.
            self.resolve_models(settings)
            snapshot = app.configure_models(settings)
            return snapshot.model_dump(mode="json")
        except (ValidationError, WorkspaceError) as error:
            raise GatewayError(str(error)) from error

    def run_snapshot(self, root: Path | str, *, allow_missing: bool = False) -> dict:
        return self.resolve_models(
            WorkspaceApplication(root).open().models,
            allow_missing=allow_missing,
        )

    def resolve_models(self, models: ModelSettings, *, allow_missing: bool = False) -> dict:
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
        assigned_models = sorted(set(assignments.values()))
        untested = [
            model
            for model in assigned_models
            if model not in profile.models or model not in profile.capabilities
        ]
        if untested:
            raise GatewayError(
                "Gateway Profile requires successful capability tests for models: "
                + ", ".join(untested),
                category="capability",
            )
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
            "capabilities": {model: profile.capabilities[model] for model in assigned_models},
        }


def _is_loopback_host(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
