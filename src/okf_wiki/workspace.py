import hashlib
import json
import os
import sqlite3
import tempfile
import tomllib
from pathlib import Path
from typing import Literal, TypeVar, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .state_schema import migrate_state


WORKSPACE_SCHEMA_VERSION = 1
ModelT = TypeVar("ModelT", bound=BaseModel)


class WorkspaceError(ValueError):
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


class LocalWorkspaceSettings(StrictModel):
    schema_version: Literal[1] = WORKSPACE_SCHEMA_VERSION
    checkouts: dict[str, str] = Field(default_factory=dict)
    models: ModelSettings = ModelSettings()

    @field_validator("checkouts")
    @classmethod
    def valid_checkouts(cls, values: dict[str, str]) -> dict[str, str]:
        if any(not key or not value for key, value in values.items()):
            raise ValueError("checkout bindings must use non-empty strings")
        return values


class ResolvedSource(StrictModel):
    id: str
    role: str
    revision: str
    remote: str | None
    checkout: Path | None


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

    def initialize(self, project_id: str, name: str | None = None) -> WorkspaceSnapshot:
        self._recover_update()
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
        return self.update(definition, LocalWorkspaceSettings())

    def update(
        self,
        definition: WorkspaceDefinition | dict,
        settings: LocalWorkspaceSettings | dict,
    ) -> WorkspaceSnapshot:
        self._recover_update()
        definition = _validate(WorkspaceDefinition, definition, self.definition_path)
        settings = _validate(LocalWorkspaceSettings, settings, self.settings_path)
        if self.definition_path.exists():
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
        self._recover_update()
        return self._open_current()

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
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with sqlite3.connect(self.database_path) as connection:
                state_version = migrate_state(connection)
        except (sqlite3.Error, ValueError) as error:
            raise WorkspaceError(f"{self.database_path}: {error}") from error
        digest = hashlib.sha256(
            self.definition_path.read_bytes() + b"\0" + self.settings_path.read_bytes()
        ).hexdigest()
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
                )
                for source in definition.sources
            ),
            profile=definition.profile,
            models=settings.models,
            configuration_digest=digest,
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

    def _recover_update(self) -> None:
        if not self.update_journal_path.exists():
            return
        try:
            journal = json.loads(self.update_journal_path.read_text(encoding="utf-8"))
            if set(journal) != {"definition", "settings"} or not all(
                value is None or isinstance(value, str) for value in journal.values()
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

    def migrate_legacy(self, path: Path | str) -> WorkspaceSnapshot:
        self._recover_update()
        legacy_path = Path(path).resolve()
        if legacy_path.parent != self.root:
            raise WorkspaceError(
                f"{legacy_path}: legacy Producer Project must be migrated in place"
            )
        if self.definition_path.exists() or self.settings_path.exists():
            raise WorkspaceError(f"{self.root}: Workspace is already initialized")
        payload = _read_toml(legacy_path)
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
        return self.update(definition, settings)
