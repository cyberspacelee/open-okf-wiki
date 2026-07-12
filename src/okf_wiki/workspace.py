import hashlib
import json
import os
import re
import sqlite3
import tempfile
import tomllib
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Literal, TypeVar, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .bundle import verification_blockers
from .coverage import major_blockers
from .source_checkouts import (
    SourceCheckoutError,
    clone_checkout,
    delete_managed_checkout,
    inspect_checkout,
    validate_clone_remote,
)
from .state_schema import migrate_state


WORKSPACE_SCHEMA_VERSION = 1
SOURCE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
SOURCE_ROLES = {"implementation", "documentation", "requirements", "contract"}
ModelT = TypeVar("ModelT", bound=BaseModel)


class WorkspaceError(ValueError):
    pass


class WorkspaceStaleError(WorkspaceError):
    pass


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class WorkspaceProject(StrictModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)

    @field_validator("id", "name")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


class PublicationDefinition(StrictModel):
    path: str = Field(default="published", min_length=1)
    bundle_name: str | None = Field(default=None, min_length=1)

    @field_validator("path", "bundle_name")
    @classmethod
    def non_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("must not be blank")
        return value.strip() if value is not None else None


class WorkspaceSource(StrictModel):
    id: str = Field(min_length=1)
    role: str = Field(min_length=1)
    revision: str = Field(min_length=1)
    remote: str | None = Field(default=None, min_length=1)

    @field_validator("id", "role", "revision", "remote")
    @classmethod
    def non_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("must not be blank")
        return value.strip() if value is not None else None

    @field_validator("id")
    @classmethod
    def safe_id(cls, value: str) -> str:
        if not SOURCE_ID_RE.fullmatch(value):
            raise ValueError("must use letters, numbers, dots, underscores, or hyphens")
        return value

    @field_validator("role")
    @classmethod
    def supported_role(cls, value: str) -> str:
        if value not in SOURCE_ROLES:
            raise ValueError(
                "must be one of implementation, documentation, requirements, or contract"
            )
        return value

    @field_validator("remote")
    @classmethod
    def no_credentials(cls, value: str | None) -> str | None:
        if value is None:
            return value
        remote = urlsplit(value)
        if remote.query or remote.fragment:
            raise ValueError("must not contain a query or fragment")
        if remote.password is not None or (
            remote.scheme in {"http", "https"} and remote.username is not None
        ):
            raise ValueError("must not contain credentials; use local Git credential handling")
        return value


class DispositionSettings(StrictModel):
    disposition: Literal["open", "covered", "deferred", "excluded", "blocked", "failed"]
    reason: str | None = None


class ProducerProfileSettings(StrictModel):
    java_excluded_paths: list[str] | None = None
    priorities: dict[str, Literal["major", "supporting"]] = Field(default_factory=dict)
    dispositions: dict[Literal["major", "supporting"], DispositionSettings] = Field(
        default_factory=dict
    )

    @model_validator(mode="after")
    def valid_policy(self) -> "ProducerProfileSettings":
        if self.java_excluded_paths is not None:
            if not self.java_excluded_paths or any(
                not rule.strip() or rule.startswith("/") or ".." in Path(rule).parts
                for rule in self.java_excluded_paths
            ):
                raise ValueError("java_excluded_paths must contain safe relative patterns")
        for priority, settings in self.dispositions.items():
            if settings.disposition in {"deferred", "excluded"} and not (
                settings.reason and settings.reason.strip()
            ):
                raise ValueError(f"{settings.disposition} {priority} disposition requires a reason")
            if settings.disposition == "deferred" and priority != "supporting":
                raise ValueError("deferred is available only to Supporting Obligations")
        return self


class WorkspaceDefinition(StrictModel):
    schema_version: Literal[1] = WORKSPACE_SCHEMA_VERSION
    project: WorkspaceProject
    publication: PublicationDefinition = PublicationDefinition()
    sources: list[WorkspaceSource] = Field(default_factory=list)
    profile: ProducerProfileSettings = ProducerProfileSettings()

    @model_validator(mode="after")
    def source_ids_are_unique(self) -> "WorkspaceDefinition":
        ids = [source.id for source in self.sources]
        if len(ids) != len(set(ids)):
            raise ValueError("Source IDs must be unique")
        return self


class ModelSettings(StrictModel):
    gateway_profile: str | None = Field(default=None, min_length=1)
    default_model: str | None = Field(default=None, min_length=1)
    role_overrides: dict[str, str] = Field(default_factory=dict)
    concurrency: int = Field(default=4, ge=1)
    budgets: dict[str, int] = Field(default_factory=dict)

    @field_validator("role_overrides")
    @classmethod
    def valid_overrides(cls, values: dict[str, str]) -> dict[str, str]:
        if any(not key or not value for key, value in values.items()):
            raise ValueError("model role overrides must use non-empty strings")
        return values

    @field_validator("budgets")
    @classmethod
    def valid_budgets(cls, values: dict[str, int]) -> dict[str, int]:
        if any(not key or value < 1 for key, value in values.items()):
            raise ValueError("model budgets must be positive integers")
        return values


class UISettings(StrictModel):
    compact_navigation: bool = False


class ManagedCheckoutReceipt(StrictModel):
    path: str = Field(min_length=1)
    device: int = Field(ge=0)
    inode: int = Field(ge=1)


class LocalWorkspaceSettings(StrictModel):
    schema_version: Literal[1] = WORKSPACE_SCHEMA_VERSION
    checkouts: dict[str, str] = Field(default_factory=dict)
    managed_checkouts: dict[str, ManagedCheckoutReceipt] = Field(default_factory=dict)
    models: ModelSettings = ModelSettings()
    ui: UISettings = UISettings()

    @field_validator("checkouts")
    @classmethod
    def valid_checkouts(cls, values: dict[str, str]) -> dict[str, str]:
        if any(not SOURCE_ID_RE.fullmatch(key) or not value for key, value in values.items()):
            raise ValueError("checkout bindings must use non-empty strings")
        return values

    @field_validator("managed_checkouts")
    @classmethod
    def valid_managed_ids(
        cls, values: dict[str, ManagedCheckoutReceipt]
    ) -> dict[str, ManagedCheckoutReceipt]:
        if any(not SOURCE_ID_RE.fullmatch(key) for key in values):
            raise ValueError("managed checkout IDs must be safe Source IDs")
        return values


class ResolvedSource(StrictModel):
    id: str
    role: str
    revision: str
    remote: str | None
    checkout: Path | None
    ownership: Literal["managed", "linked"] | None


class ResolvedPublication(StrictModel):
    path: Path
    bundle_name: str


class WorkspaceSnapshot(StrictModel):
    schema_version: Literal[1]
    state_schema_version: int
    workspace: Path
    project: WorkspaceProject
    publication: ResolvedPublication
    sources: tuple[ResolvedSource, ...]
    profile: ProducerProfileSettings
    models: ModelSettings
    configuration_digest: str


REMOVED_FIELDS = {
    "workspace.toml": {
        "project_id": "use project.id",
        "publish_dir": "use publication.path",
        "repository": "use sources plus Local Workspace Settings checkouts",
        "revision": "use sources",
    },
    "settings.toml": {
        "models.api_key": "use a Gateway Profile credential reference",
        "models.base_url": "use a Gateway Profile",
        "models.headers": "use a Gateway Profile",
    },
}


def _read_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise WorkspaceError(f"{path}: cannot read configuration: {error}") from error
    except tomllib.TOMLDecodeError as error:
        raise WorkspaceError(f"{path}: malformed TOML: {error}") from error


def _validate(model: type[ModelT], payload: object, path: Path) -> ModelT:
    for location, guidance in REMOVED_FIELDS.get(path.name, {}).items():
        value: object = payload
        for part in location.split("."):
            if not isinstance(value, dict) or part not in value:
                break
            value = cast(dict[str, object], value)[part]
        else:
            raise WorkspaceError(f"{path}: removed field '{location}'; {guidance}")
    try:
        return model.model_validate(payload)
    except ValidationError as error:
        item = error.errors()[0]
        location = ".".join(str(part) for part in item["loc"])
        removed = REMOVED_FIELDS.get(path.name, {}).get(location)
        if removed:
            raise WorkspaceError(f"{path}: removed field '{location}'; {removed}") from error
        kind = "unknown field" if item["type"] == "extra_forbidden" else "invalid field"
        raise WorkspaceError(f"{path}: {kind} '{location}': {item['msg']}") from error


def _quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _render_definition(value: WorkspaceDefinition) -> str:
    lines = [
        f"schema_version = {value.schema_version}",
        "",
        "[project]",
        f"id = {_quote(value.project.id)}",
        f"name = {_quote(value.project.name)}",
        "",
        "[publication]",
        f"path = {_quote(value.publication.path)}",
    ]
    if value.publication.bundle_name:
        lines.append(f"bundle_name = {_quote(value.publication.bundle_name)}")
    for source in value.sources:
        lines.extend(
            [
                "",
                "[[sources]]",
                f"id = {_quote(source.id)}",
                f"role = {_quote(source.role)}",
                f"revision = {_quote(source.revision)}",
            ]
        )
        if source.remote:
            lines.append(f"remote = {_quote(source.remote)}")
    profile = value.profile
    if profile.java_excluded_paths is not None:
        lines.extend(
            [
                "",
                "[profile]",
                "java_excluded_paths = ["
                + ", ".join(_quote(item) for item in profile.java_excluded_paths)
                + "]",
            ]
        )
    if profile.priorities:
        lines.extend(["", "[profile.priorities]"])
        lines.extend(f"{key} = {_quote(item)}" for key, item in sorted(profile.priorities.items()))
    for priority, settings in sorted(profile.dispositions.items()):
        lines.extend(
            [
                "",
                f"[profile.dispositions.{priority}]",
                f"disposition = {_quote(settings.disposition)}",
            ]
        )
        if settings.reason is not None:
            lines.append(f"reason = {_quote(settings.reason)}")
    return "\n".join(lines) + "\n"


def _render_settings(value: LocalWorkspaceSettings) -> str:
    lines = [f"schema_version = {value.schema_version}"]
    if value.checkouts:
        lines.extend(["", "[checkouts]"])
        lines.extend(
            f"{_quote(key)} = {_quote(path)}" for key, path in sorted(value.checkouts.items())
        )
    for source_id, receipt in sorted(value.managed_checkouts.items()):
        lines.extend(
            [
                "",
                f"[managed_checkouts.{_quote(source_id)}]",
                f"path = {_quote(receipt.path)}",
                f"device = {receipt.device}",
                f"inode = {receipt.inode}",
            ]
        )
    models = value.models
    lines.extend(["", "[models]", f"concurrency = {models.concurrency}"])
    if models.gateway_profile:
        lines.append(f"gateway_profile = {_quote(models.gateway_profile)}")
    if models.default_model:
        lines.append(f"default_model = {_quote(models.default_model)}")
    if models.role_overrides:
        lines.extend(["", "[models.role_overrides]"])
        lines.extend(
            f"{_quote(key)} = {_quote(model)}"
            for key, model in sorted(models.role_overrides.items())
        )
    if models.budgets:
        lines.extend(["", "[models.budgets]"])
        lines.extend(f"{_quote(key)} = {budget}" for key, budget in sorted(models.budgets.items()))
    lines.extend(
        [
            "",
            "[ui]",
            f"compact_navigation = {str(value.ui.compact_navigation).lower()}",
        ]
    )
    return "\n".join(lines) + "\n"


def _write_temp(path: Path, content: str, mode: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise
    return temporary


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _replace_durable(source: Path, target: Path) -> None:
    os.replace(source, target)
    _fsync_directory(target.parent)


class WorkspaceApplication:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.definition_path = self.root / "workspace.toml"
        self.settings_path = self.root / ".okf-wiki" / "settings.toml"
        self.database_path = self.root / ".okf-wiki" / "runs.db"
        self.update_journal_path = self.root / ".okf-wiki" / "config-update.json"
        self.lock_path = self.root / ".okf-wiki" / "workspace-lock.db"

    def initialize(self, project_id: str, name: str | None = None) -> WorkspaceSnapshot:
        with self._locked():
            return self._initialize_locked(project_id, name)

    def _initialize_locked(self, project_id: str, name: str | None) -> WorkspaceSnapshot:
        self._recover_update_locked()
        if self.definition_path.exists() or self.settings_path.exists():
            raise WorkspaceError(f"{self.root}: Workspace is already initialized")
        definition = _validate(
            WorkspaceDefinition,
            {
                "schema_version": WORKSPACE_SCHEMA_VERSION,
                "project": {"id": project_id, "name": name if name is not None else project_id},
            },
            self.definition_path,
        )
        return self._update_locked(definition, LocalWorkspaceSettings())

    def update(
        self,
        definition: WorkspaceDefinition | dict,
        settings: LocalWorkspaceSettings | dict,
    ) -> WorkspaceSnapshot:
        with self._locked():
            self._recover_update_locked()
            return self._update_locked(definition, settings)

    def settings(self) -> dict:
        with self._locked():
            self._recover_update_locked()
            return self._settings_locked()

    def update_settings(
        self,
        definition: WorkspaceDefinition | dict,
        settings: LocalWorkspaceSettings | dict,
        expected_configuration_digest: str,
    ) -> dict:
        with self._locked():
            self._recover_update_locked()
            current_digest = self._configuration_digest()
            if expected_configuration_digest != current_digest:
                raise WorkspaceStaleError(
                    "Workspace settings changed after they were loaded; refresh and try again"
                )
            self._update_locked(definition, settings)
            return self._settings_locked()

    def update_settings_payload(self, payload: object) -> dict:
        if not isinstance(payload, dict) or set(payload) != {
            "definition",
            "local_settings",
            "configuration_digest",
        }:
            raise WorkspaceError(
                "Settings update must contain definition, local_settings, and configuration_digest"
            )
        values = cast(dict[str, object], payload)
        definition = values["definition"]
        settings = values["local_settings"]
        digest = values["configuration_digest"]
        if not isinstance(definition, dict) or not isinstance(settings, dict):
            raise WorkspaceError("Settings update definition and local_settings must be objects")
        if not isinstance(digest, str):
            raise WorkspaceError("Settings update configuration_digest must be a string")
        return self.update_settings(definition, settings, digest)

    def _settings_locked(self) -> dict:
        definition = _validate(
            WorkspaceDefinition, _read_toml(self.definition_path), self.definition_path
        )
        settings = _validate(
            LocalWorkspaceSettings, _read_toml(self.settings_path), self.settings_path
        )
        return {
            "definition": definition.model_dump(mode="json"),
            "local_settings": settings.model_dump(mode="json"),
            "configuration_digest": self._configuration_digest(),
        }

    def _configuration_digest(self) -> str:
        return hashlib.sha256(
            self.definition_path.read_bytes() + b"\0" + self.settings_path.read_bytes()
        ).hexdigest()

    def _update_locked(
        self,
        definition: WorkspaceDefinition | dict,
        settings: LocalWorkspaceSettings | dict,
        *,
        validate_current: bool = True,
    ) -> WorkspaceSnapshot:
        definition = _validate(WorkspaceDefinition, definition, self.definition_path)
        settings = _validate(LocalWorkspaceSettings, settings, self.settings_path)
        if validate_current and self.definition_path.exists():
            current = _validate(
                WorkspaceDefinition, _read_toml(self.definition_path), self.definition_path
            )
            if definition.project.id != current.project.id:
                raise WorkspaceError(
                    f"{self.definition_path}: Producer Project identity is immutable "
                    f"({current.project.id})"
                )
        unknown_checkouts = sorted(
            set(settings.checkouts) - {item.id for item in definition.sources}
        )
        if unknown_checkouts:
            raise WorkspaceError(
                f"{self.settings_path}: checkout bindings reference unknown Sources: "
                + ", ".join(unknown_checkouts)
            )
        self._validate_managed_bindings(definition, settings)
        self.root.mkdir(parents=True, exist_ok=True)
        previous_definition = (
            self.definition_path.read_bytes() if self.definition_path.exists() else None
        )
        previous_settings = self.settings_path.read_bytes() if self.settings_path.exists() else None
        definition_temp: Path | None = None
        settings_temp: Path | None = None
        try:
            definition_temp = _write_temp(
                self.definition_path, _render_definition(definition), 0o644
            )
            settings_temp = _write_temp(self.settings_path, _render_settings(settings), 0o600)
            self._begin_update(previous_definition, previous_settings)
            _replace_durable(definition_temp, self.definition_path)
            _replace_durable(settings_temp, self.settings_path)
            snapshot = self._open_current()
            self._finish_update()
            return snapshot
        except Exception as error:
            try:
                self._restore_pair(previous_definition, previous_settings)
                self._finish_update()
            except Exception as recovery_error:
                raise WorkspaceError(
                    f"{self.root}: configuration update and recovery failed: {recovery_error}"
                ) from recovery_error
            raise WorkspaceError(f"{self.root}: configuration update failed: {error}") from error
        finally:
            if definition_temp is not None:
                definition_temp.unlink(missing_ok=True)
            if settings_temp is not None:
                settings_temp.unlink(missing_ok=True)

    def open(self) -> WorkspaceSnapshot:
        with self._locked():
            self._recover_update_locked()
            return self._open_current()

    def configure_models(self, models: ModelSettings | dict) -> WorkspaceSnapshot:
        with self._locked():
            self._recover_update_locked()
            definition = _validate(
                WorkspaceDefinition,
                _read_toml(self.definition_path),
                self.definition_path,
            )
            settings = _validate(
                LocalWorkspaceSettings,
                _read_toml(self.settings_path),
                self.settings_path,
            )
            try:
                selected = ModelSettings.model_validate(models)
            except ValidationError as error:
                item = error.errors()[0]
                location = ".".join(str(part) for part in item["loc"])
                raise WorkspaceError(
                    f"{self.settings_path}: invalid field 'models.{location}': {item['msg']}"
                ) from error
            return self._update_locked(
                definition,
                settings.model_copy(update={"models": selected}),
            )

    def _open_current(self) -> WorkspaceSnapshot:
        definition = _validate(
            WorkspaceDefinition, _read_toml(self.definition_path), self.definition_path
        )
        settings = _validate(
            LocalWorkspaceSettings, _read_toml(self.settings_path), self.settings_path
        )
        unknown_checkouts = sorted(
            set(settings.checkouts) - {item.id for item in definition.sources}
        )
        if unknown_checkouts:
            raise WorkspaceError(
                f"{self.settings_path}: checkout bindings reference unknown Sources: "
                + ", ".join(unknown_checkouts)
            )
        self._validate_managed_bindings(definition, settings)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with sqlite3.connect(self.database_path) as connection:
                state_version = migrate_state(connection)
        except (sqlite3.Error, ValueError) as error:
            raise WorkspaceError(f"{self.database_path}: {error}") from error
        digest = self._configuration_digest()
        return WorkspaceSnapshot(
            schema_version=definition.schema_version,
            state_schema_version=state_version,
            workspace=self.root,
            project=definition.project,
            publication=ResolvedPublication(
                path=(self.root / definition.publication.path).resolve(),
                bundle_name=definition.publication.bundle_name or definition.project.name,
            ),
            sources=tuple(
                ResolvedSource(
                    **source.model_dump(),
                    checkout=(self.root / settings.checkouts[source.id]).resolve()
                    if source.id in settings.checkouts
                    else None,
                    ownership=(
                        "managed"
                        if source.id in settings.managed_checkouts
                        else "linked"
                        if source.id in settings.checkouts
                        else None
                    ),
                )
                for source in definition.sources
            ),
            profile=definition.profile,
            models=settings.models,
            configuration_digest=digest,
        )

    def _validate_managed_bindings(
        self, definition: WorkspaceDefinition, settings: LocalWorkspaceSettings
    ) -> None:
        source_ids = {source.id for source in definition.sources}
        for source_id, receipt in settings.managed_checkouts.items():
            expected = self.root / "sources" / source_id
            if Path(receipt.path) != expected:
                raise WorkspaceError(
                    f"{self.settings_path}: managed checkout {source_id} must use {expected}"
                )
            if source_id in source_ids and settings.checkouts.get(source_id) != str(expected):
                raise WorkspaceError(
                    f"{self.settings_path}: managed Source {source_id} has an ambiguous checkout"
                )

    def _begin_update(
        self, previous_definition: bytes | None, previous_settings: bytes | None
    ) -> None:
        journal = _write_temp(
            self.update_journal_path,
            json.dumps(
                {
                    "definition": previous_definition.decode("utf-8")
                    if previous_definition is not None
                    else None,
                    "settings": previous_settings.decode("utf-8")
                    if previous_settings is not None
                    else None,
                },
                sort_keys=True,
            ),
            0o600,
        )
        try:
            _replace_durable(journal, self.update_journal_path)
        finally:
            journal.unlink(missing_ok=True)

    def _recover_update_locked(self) -> None:
        if not self.update_journal_path.exists():
            return
        try:
            journal = json.loads(self.update_journal_path.read_text(encoding="utf-8"))
            if (
                not isinstance(journal, dict)
                or set(journal) != {"definition", "settings"}
                or not all(value is None or isinstance(value, str) for value in journal.values())
            ):
                raise ValueError("invalid update journal")
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise WorkspaceError(
                f"{self.update_journal_path}: cannot recover configuration update: {error}"
            ) from error
        self._restore_pair(
            journal["definition"].encode("utf-8") if journal["definition"] is not None else None,
            journal["settings"].encode("utf-8") if journal["settings"] is not None else None,
        )
        self._finish_update()

    def _restore_pair(
        self, previous_definition: bytes | None, previous_settings: bytes | None
    ) -> None:
        self._restore_content(self.definition_path, previous_definition, 0o644)
        self._restore_content(self.settings_path, previous_settings, 0o600)

    def _restore_content(self, target: Path, content: bytes | None, mode: int) -> None:
        if content is None:
            self._remove_durable(target)
            return
        temporary = _write_temp(target, content.decode("utf-8"), mode)
        try:
            _replace_durable(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _remove_durable(path: Path) -> None:
        if path.exists():
            path.unlink()
            _fsync_directory(path.parent)

    def _finish_update(self) -> None:
        self._remove_durable(self.update_journal_path)

    def inspect(self) -> dict:
        return self.open().model_dump(mode="json")

    def overview(self) -> dict:
        snapshot = self.open()
        with sqlite3.connect(self.database_path) as connection:
            connection.row_factory = sqlite3.Row
            latest_bundle = connection.execute(
                """SELECT id, state, updated_at, publish_dir FROM runs
                   WHERE state = 'published' ORDER BY updated_at DESC, id DESC LIMIT 1"""
            ).fetchone()
            active_run = connection.execute(
                """SELECT id, state, updated_at, coverage_json, error FROM runs
                   WHERE state NOT IN ('published', 'failed', 'cancelled')
                   ORDER BY updated_at DESC, id DESC LIMIT 1"""
            ).fetchone()
        blockers: list[str] = []
        missing_checkouts = [source.id for source in snapshot.sources if source.checkout is None]
        if not snapshot.sources:
            blockers.append("No Sources are configured")
        blockers.extend(
            f"Source {source_id} has no checkout binding" for source_id in missing_checkouts
        )
        if active_run is not None:
            if active_run["error"]:
                blockers.append(active_run["error"])
            coverage = (
                json.loads(active_run["coverage_json"]) if active_run["coverage_json"] else {}
            )
            blocked = major_blockers(coverage)
            if blocked:
                blockers.append(f"{blocked} major obligations remain open")
            if active_run["state"] == "review_required":
                blockers.extend(verification_blockers(self.database_path, active_run["id"]))
        if not snapshot.sources or missing_checkouts:
            next_actions = ["configure_sources"]
        elif active_run is None:
            next_actions = ["start_run"]
        elif active_run["state"] == "review_required":
            next_actions = ["review_run"]
        else:
            next_actions = ["view_run"]
        return {
            "project": snapshot.project.model_dump(mode="json"),
            "source_count": len(snapshot.sources),
            "latest_bundle": (
                {
                    "run_id": latest_bundle["id"],
                    "state": latest_bundle["state"],
                    "updated_at": latest_bundle["updated_at"],
                    "path": latest_bundle["publish_dir"],
                }
                if latest_bundle is not None
                else None
            ),
            "active_run": (
                {
                    "run_id": active_run["id"],
                    "state": active_run["state"],
                    "updated_at": active_run["updated_at"],
                }
                if active_run is not None
                else None
            ),
            "blockers": list(dict.fromkeys(blockers)),
            "next_actions": next_actions,
        }

    def sources(self) -> dict:
        with self._locked():
            self._recover_update_locked()
            return self._sources_locked()

    def clone_source(self, payload: object) -> dict:
        values = self._source_payload(payload, {"id", "role", "remote"}, "Clone Source")
        source_id, role, remote = values["id"], values["role"], values["remote"]
        candidate = self._new_source(source_id, role, "0" * 40, remote)
        self._checkout_call(validate_clone_remote, remote)
        with self._locked():
            self._recover_update_locked()
            definition, settings = self._configuration_locked()
            self._ensure_available_source_id(candidate.id, definition, settings)
            target, status, identity = self._checkout_call(
                clone_checkout,
                self.root,
                self.settings_path.parent,
                candidate.id,
                remote,
            )
            source = self._new_source(
                candidate.id,
                candidate.role,
                cast(str, status["commit"]),
                cast(str | None, status["remote"]) or remote,
            )
            definition_payload = definition.model_dump(mode="python")
            definition_payload["sources"].append(source.model_dump(mode="python"))
            settings_payload = settings.model_dump(mode="python")
            settings_payload["checkouts"][source.id] = str(target)
            settings_payload["managed_checkouts"][source.id] = {
                "path": str(target),
                "device": identity.st_dev,
                "inode": identity.st_ino,
            }
            try:
                self._update_locked(definition_payload, settings_payload)
            except Exception as error:
                try:
                    delete_managed_checkout(
                        self.root, candidate.id, target, identity.st_dev, identity.st_ino
                    )
                except SourceCheckoutError as cleanup_error:
                    raise WorkspaceError(
                        f"{error}; managed clone cleanup failed: {cleanup_error}"
                    ) from cleanup_error
                raise
            return self._sources_locked()

    def link_source(self, payload: object) -> dict:
        values = self._source_payload(payload, {"id", "role", "checkout"}, "Link Source")
        checkout = Path(values["checkout"]).expanduser().resolve()
        try:
            checkout.relative_to(self.root)
        except ValueError:
            pass
        else:
            raise WorkspaceError("Linked Source checkout must be outside the Workspace")
        status = self._checkout_call(inspect_checkout, checkout)
        source = self._new_source(
            values["id"],
            values["role"],
            cast(str, status["commit"]),
            cast(str | None, status["remote"]),
        )
        with self._locked():
            self._recover_update_locked()
            definition, settings = self._configuration_locked()
            self._ensure_available_source_id(source.id, definition, settings)
            definition_payload = definition.model_dump(mode="python")
            definition_payload["sources"].append(source.model_dump(mode="python"))
            settings_payload = settings.model_dump(mode="python")
            settings_payload["checkouts"][source.id] = str(checkout)
            self._update_locked(definition_payload, settings_payload)
            return self._sources_locked()

    def remove_source(self, payload: object) -> dict:
        values = self._source_payload(payload, {"id"}, "Remove Source")
        with self._locked():
            self._recover_update_locked()
            definition, settings = self._configuration_locked()
            if values["id"] not in {source.id for source in definition.sources}:
                raise WorkspaceError(f"Unknown Source: {values['id']}")
            definition_payload = definition.model_dump(mode="python")
            definition_payload["sources"] = [
                source for source in definition_payload["sources"] if source["id"] != values["id"]
            ]
            settings_payload = settings.model_dump(mode="python")
            settings_payload["checkouts"].pop(values["id"], None)
            self._update_locked(definition_payload, settings_payload)
            return self._sources_locked()

    def delete_managed_source(self, payload: object) -> dict:
        values = self._source_payload(payload, {"id", "confirmation"}, "Delete managed Source")
        source_id = values["id"]
        if values["confirmation"] != source_id:
            raise WorkspaceError(
                f"Managed Source deletion confirmation must exactly match {source_id}"
            )
        with self._locked():
            self._recover_update_locked()
            definition, settings = self._configuration_locked()
            if source_id in {source.id for source in definition.sources}:
                raise WorkspaceError(
                    f"Remove Source {source_id} from configuration first, then delete its checkout"
                )
            receipt = settings.managed_checkouts.get(source_id)
            if receipt is None:
                raise WorkspaceError(f"Source {source_id} is not a managed checkout")
            self._checkout_call(
                delete_managed_checkout,
                self.root,
                source_id,
                Path(receipt.path),
                receipt.device,
                receipt.inode,
            )
            settings_payload = settings.model_dump(mode="python")
            settings_payload["managed_checkouts"].pop(source_id)
            self._update_locked(definition, settings_payload)
            return {"deleted": source_id, **self._sources_locked()}

    def _sources_locked(self) -> dict:
        definition, settings = self._configuration_locked()
        sources = []
        for source in definition.sources:
            checkout_text = settings.checkouts.get(source.id)
            ownership = (
                "managed"
                if source.id in settings.managed_checkouts
                else "linked"
                if checkout_text
                else None
            )
            status: dict[str, object] = {
                "remote": source.remote,
                "branch": None,
                "commit": None,
                "dirty": None,
                "ahead": None,
                "behind": None,
                "error": None,
            }
            if checkout_text:
                try:
                    status = self._checkout_call(inspect_checkout, Path(checkout_text))
                except WorkspaceError as error:
                    status["error"] = str(error)
            sources.append(
                {
                    "id": source.id,
                    "role": source.role,
                    "ownership": ownership,
                    "checkout": checkout_text,
                    **status,
                }
            )
        active_ids = {source.id for source in definition.sources}
        retained = [
            {"id": source_id, "checkout": receipt.path}
            for source_id, receipt in sorted(settings.managed_checkouts.items())
            if source_id not in active_ids
        ]
        return {
            "configuration_digest": self._configuration_digest(),
            "sources": sources,
            "retained_managed": retained,
        }

    def _configuration_locked(self) -> tuple[WorkspaceDefinition, LocalWorkspaceSettings]:
        definition = _validate(
            WorkspaceDefinition, _read_toml(self.definition_path), self.definition_path
        )
        settings = _validate(
            LocalWorkspaceSettings, _read_toml(self.settings_path), self.settings_path
        )
        unknown_checkouts = sorted(
            set(settings.checkouts) - {item.id for item in definition.sources}
        )
        if unknown_checkouts:
            raise WorkspaceError(
                f"{self.settings_path}: checkout bindings reference unknown Sources: "
                + ", ".join(unknown_checkouts)
            )
        self._validate_managed_bindings(definition, settings)
        return definition, settings

    @staticmethod
    def _source_payload(payload: object, fields: set[str], operation: str) -> dict[str, str]:
        if not isinstance(payload, dict) or set(payload) != fields:
            raise WorkspaceError(f"{operation} must contain {', '.join(sorted(fields))}")
        values = cast(dict[str, object], payload)
        for key, value in values.items():
            if not isinstance(value, str) or not value.strip():
                raise WorkspaceError(f"{operation} field {key} must be a non-empty string")
        return {key: cast(str, value).strip() for key, value in values.items()}

    def _new_source(
        self, source_id: str, role: str, revision: str, remote: str | None
    ) -> WorkspaceSource:
        try:
            return WorkspaceSource(id=source_id, role=role, revision=revision, remote=remote)
        except ValidationError as error:
            item = error.errors()[0]
            location = ".".join(str(part) for part in item["loc"])
            raise WorkspaceError(f"Invalid Source {location}: {item['msg']}") from error

    @staticmethod
    def _checkout_call(function, *arguments):
        try:
            return function(*arguments)
        except SourceCheckoutError as error:
            raise WorkspaceError(str(error)) from error

    @staticmethod
    def _ensure_available_source_id(
        source_id: str, definition: WorkspaceDefinition, settings: LocalWorkspaceSettings
    ) -> None:
        if source_id in {source.id for source in definition.sources}:
            raise WorkspaceError(f"Source {source_id} already exists")
        if source_id in settings.managed_checkouts:
            raise WorkspaceError(
                f"Source {source_id} has a retained managed checkout; delete or restore it first"
            )

    def migrate_legacy(self, path: Path | str) -> WorkspaceSnapshot:
        with self._locked():
            return self._migrate_legacy_locked(path)

    def _migrate_legacy_locked(self, path: Path | str) -> WorkspaceSnapshot:
        self._recover_update_locked()
        legacy_path = Path(path).resolve()
        if legacy_path.parent != self.root:
            raise WorkspaceError(
                f"{legacy_path}: legacy Producer Project must be migrated in place"
            )
        if self.settings_path.exists() or (
            self.definition_path.exists() and legacy_path != self.definition_path
        ):
            raise WorkspaceError(f"{self.root}: Workspace is already initialized")
        payload = _read_toml(legacy_path)
        if legacy_path == self.definition_path and "schema_version" in payload:
            raise WorkspaceError(f"{self.root}: Workspace is already initialized")
        allowed = {"project_id", "publish_dir", "repository", "revision", "sources", "profile"}
        unknown = sorted(set(payload) - allowed)
        if unknown:
            raise WorkspaceError(f"{legacy_path}: unknown fields: {', '.join(unknown)}")
        if "sources" in payload and ({"repository", "revision"} & payload.keys()):
            raise WorkspaceError(
                f"{legacy_path}: use either sources or repository/revision fields, not both"
            )
        try:
            project_id = payload["project_id"]
            publish_dir = Path(payload["publish_dir"])
            if not publish_dir.is_absolute():
                publish_dir = Path(os.path.relpath((legacy_path.parent / publish_dir), self.root))
            raw_sources = payload.get("sources")
            if raw_sources is None:
                raw_sources = [
                    {
                        "id": "source",
                        "role": "implementation",
                        "repository": payload["repository"],
                        "revision": payload["revision"],
                    }
                ]
            if not isinstance(raw_sources, list) or not raw_sources:
                raise TypeError("sources must be a non-empty array")
            for index, source in enumerate(raw_sources):
                if not isinstance(source, dict):
                    raise TypeError(f"sources.{index} must be a table")
                unknown_source = sorted(set(source) - {"id", "role", "repository", "revision"})
                if unknown_source:
                    raise TypeError(
                        f"sources.{index} has unknown fields: {', '.join(unknown_source)}"
                    )
            sources = [
                WorkspaceSource(
                    id=source["id"],
                    role=source["role"],
                    revision=source["revision"],
                )
                for source in raw_sources
            ]
            profile = ProducerProfileSettings.model_validate(payload.get("profile", {}))
            definition = WorkspaceDefinition(
                project=WorkspaceProject(id=project_id, name=project_id),
                publication=PublicationDefinition(path=str(publish_dir)),
                sources=sources,
                profile=profile,
            )
            settings = LocalWorkspaceSettings(
                checkouts={
                    source["id"]: str(
                        (
                            legacy_path.parent / source["repository"]
                            if not Path(source["repository"]).is_absolute()
                            else Path(source["repository"])
                        ).resolve()
                    )
                    for source in raw_sources
                }
            )
        except (KeyError, TypeError, ValidationError) as error:
            raise WorkspaceError(
                f"{legacy_path}: invalid Producer Project configuration: {error}"
            ) from error
        return self._update_locked(
            definition,
            settings,
            validate_current=legacy_path != self.definition_path,
        )

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(self.lock_path, timeout=30)
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.Error as error:
            if connection is not None:
                connection.close()
            raise WorkspaceError(f"{self.lock_path}: cannot lock workspace: {error}") from error
        try:
            yield
        finally:
            connection.rollback()
            connection.close()
