import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import tomllib
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Literal, TypeVar, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .bundle import verification_blockers
from .coverage import major_blockers
from .process_identity import process_start_identity
from .review import (
    ReviewError,
    ReviewStaleError,
    bundle_file_detail,
    complete_publication,
    decide_review,
    evidence_excerpt,
    review_snapshot,
)
from .source_checkouts import (
    FULL_COMMIT_RE,
    SourceCheckoutError,
    clone_checkout,
    delete_managed_checkout,
    inspect_checkout,
    pull_checkout,
    resolve_revision_policy,
    validate_clone_remote,
    verify_checkout_revision,
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


class WorkspaceReviewStaleError(WorkspaceStaleError):
    def __init__(self, snapshot: dict) -> None:
        super().__init__("Review changed; refresh and decide against the new digest")
        self.snapshot = snapshot


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
    revision_policy: Literal["follow_branch", "pinned_commit"] | None = None
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

    @model_validator(mode="after")
    def complete_explicit_pin(self) -> "WorkspaceSource":
        if (
            self.revision_policy == "pinned_commit"
            and FULL_COMMIT_RE.fullmatch(self.revision) is None
        ):
            raise ValueError("Pinned Commit must be a complete Git commit ID")
        return self


def _source_revision_policy(
    revision: str,
    revision_policy: Literal["follow_branch", "pinned_commit"] | None,
) -> Literal["follow_branch", "pinned_commit"]:
    return revision_policy or (
        "pinned_commit" if FULL_COMMIT_RE.fullmatch(revision) else "follow_branch"
    )


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
    revision_policy: Literal["follow_branch", "pinned_commit"] | None
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
        if source.revision_policy:
            lines.append(f"revision_policy = {_quote(source.revision_policy)}")
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


def recover_run_checkpoint(database: Path, run_id: str) -> tuple[int, dict]:
    from .cli import (
        TERMINAL_STATES,
        advance_preparation,
        advance_rendering,
        get_run,
        run_validation_errors,
    )
    from .coverage import obligation_rows
    from .run_state import transition_run
    from .scheduler import recover_tasks

    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    row = get_run(connection, run_id)
    if row["state"] == "published":
        connection.close()
        return 0, {"ok": True, "recovered_tasks": [], "run_id": run_id, "state": "published"}
    if row["state"] in {"failed", "cancelled"}:
        connection.close()
        raise WorkspaceError(f"Run {run_id} is {row['state']} and terminal")

    recovered_tasks = recover_tasks(database, run_id)
    row = get_run(connection, run_id)
    state = row["state"]
    if state == "failed":
        connection.close()
        return 1, {
            "errors": [row["error"] or "Run recovery failed"],
            "ok": False,
            "recovered_tasks": recovered_tasks,
            "run_id": run_id,
            "state": state,
        }
    try:
        if state == "preparing":
            state, _coverage = advance_preparation(connection, run_id, database=database)
            if state == "failed":
                raise WorkspaceError("Major Coverage Obligations are blocked or failed")
        if state in {"verifying", "rendering", "checking"}:
            state = advance_rendering(
                connection,
                run_id,
                rerender_checking=state == "checking",
                database=database,
            )
    except Exception as error:
        current = get_run(connection, run_id)["state"]
        if current not in TERMINAL_STATES:
            with connection:
                transition_run(connection, run_id, current, "failed", error=str(error))
            current = "failed"
        connection.close()
        return 1, {"errors": [str(error)], "ok": False, "run_id": run_id, "state": current}
    if state == "publishing":
        current = get_run(connection, run_id)
        source_set = json.loads(current["source_set_json"])
        errors = run_validation_errors(
            current, source_set, obligation_rows(connection, run_id), database
        )
        if errors:
            with connection:
                transition_run(connection, run_id, "publishing", "failed", error="; ".join(errors))
            connection.close()
            return 1, {"errors": errors, "ok": False, "run_id": run_id, "state": "failed"}
        try:
            complete_publication(connection, current)
        except Exception as error:
            connection.close()
            return 1, {
                "errors": [str(error)],
                "ok": False,
                "run_id": run_id,
                "state": "failed",
            }
    final_state = get_run(connection, run_id)["state"]
    connection.close()
    return 0, {
        "ok": True,
        "recovered_tasks": recovered_tasks,
        "run_id": run_id,
        "state": final_state,
    }


def cancel_run_checkpoint(database: Path, run_id: str) -> dict:
    from .bundle import published_run_id
    from .review import previous_publication_target, restore_publication
    from .run_state import RunTransitionError, transition_run

    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row is None:
                raise WorkspaceError(f"Unknown Production Run: {run_id}")
            if row["state"] in {"published", "failed", "cancelled"}:
                raise WorkspaceError(f"Run {run_id} is already terminal")
            if (
                row["state"] == "publishing"
                and published_run_id(Path(row["publish_dir"])) == run_id
            ):
                source_set = json.loads(row["source_set_json"]) if row["source_set_json"] else {}
                restore_publication(
                    Path(row["publish_dir"]),
                    previous_publication_target(row, source_set),
                    run_id,
                )
            transition_run(connection, run_id, row["state"], "cancelled")
    except RunTransitionError as error:
        raise WorkspaceError(str(error)) from error
    except OSError as error:
        raise WorkspaceError(f"Cannot restore the previous published Bundle: {error}") from error
    finally:
        connection.close()
    return {"ok": True, "run_id": run_id, "state": "cancelled"}


class WorkspaceApplication:
    def __init__(self, root: Path | str, *, config_root: Path | str | None = None) -> None:
        self.root = Path(root).resolve()
        self.config_root = Path(config_root).resolve() if config_root is not None else None
        self.definition_path = self.root / "workspace.toml"
        self.settings_path = self.root / ".okf-wiki" / "settings.toml"
        self.database_path = self.root / ".okf-wiki" / "runs.db"
        self.update_journal_path = self.root / ".okf-wiki" / "config-update.json"
        self.lock_path = self.root / ".okf-wiki" / "workspace-lock.db"
        self._workers: dict[str, subprocess.Popen] = {}

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
        write_definition: bool = True,
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
        operation = "configuration" if write_definition else "local settings"
        try:
            if write_definition:
                definition_temp = _write_temp(
                    self.definition_path, _render_definition(definition), 0o644
                )
            settings_temp = _write_temp(self.settings_path, _render_settings(settings), 0o600)
            self._begin_update(previous_definition, previous_settings)
            if definition_temp is not None:
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
                    f"{self.root}: {operation} update and recovery failed: {recovery_error}"
                ) from recovery_error
            raise WorkspaceError(f"{self.root}: {operation} update failed: {error}") from error
        finally:
            if definition_temp is not None:
                definition_temp.unlink(missing_ok=True)
            if settings_temp is not None:
                settings_temp.unlink(missing_ok=True)

    def _update_local_settings_locked(
        self, settings: LocalWorkspaceSettings | dict
    ) -> WorkspaceSnapshot:
        definition = _validate(
            WorkspaceDefinition, _read_toml(self.definition_path), self.definition_path
        )
        return self._update_locked(definition, settings, write_definition=False)

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

    def knowledge_snapshot(self, bundle: str = "staged", run_id: str | None = None) -> dict:
        from .knowledge import KnowledgeReader

        if bundle not in {"staged", "published"}:
            raise WorkspaceError("Knowledge Bundle must be staged or published")
        try:
            return KnowledgeReader(self.database_path).snapshot(
                cast(Literal["staged", "published"], bundle), run_id
            )
        except ValueError as error:
            raise WorkspaceError(str(error)) from error

    def knowledge_page(self, bundle: str, path: str, run_id: str) -> dict:
        from .knowledge import KnowledgeReader

        if bundle not in {"staged", "published"}:
            raise WorkspaceError("Knowledge Bundle must be staged or published")
        try:
            return KnowledgeReader(self.database_path).page(
                cast(Literal["staged", "published"], bundle), path, run_id
            )
        except ValueError as error:
            raise WorkspaceError(str(error)) from error

    def search_knowledge(self, query: str, bundle: str, run_id: str) -> list[dict[str, str]]:
        from .knowledge import KnowledgeReader

        if bundle not in {"staged", "published"}:
            raise WorkspaceError("Knowledge Bundle must be staged or published")
        try:
            return KnowledgeReader(self.database_path).search(
                query, cast(Literal["staged", "published"], bundle), run_id
            )
        except ValueError as error:
            raise WorkspaceError(str(error)) from error

    def diff_knowledge(
        self,
        path: str,
        base: str,
        target: str,
        base_run_id: str,
        target_run_id: str,
    ) -> dict:
        from .knowledge import KnowledgeReader

        if base not in {"published", "previous"} or target not in {"staged", "published"}:
            raise WorkspaceError("Knowledge diff selections are invalid")
        try:
            return KnowledgeReader(self.database_path).diff(
                path,
                cast(Literal["published", "previous"], base),
                cast(Literal["staged", "published"], target),
                base_run_id,
                target_run_id,
            )
        except ValueError as error:
            raise WorkspaceError(str(error)) from error

    def knowledge_claim(self, claim_id: str, bundle: str, run_id: str) -> dict:
        from .knowledge import KnowledgeReader

        if bundle not in {"staged", "published"}:
            raise WorkspaceError("Knowledge Bundle must be staged or published")
        if not re.fullmatch(r"claim:[0-9a-f]{64}", claim_id):
            raise WorkspaceError("Invalid Accepted Claim ID")
        try:
            return KnowledgeReader(self.database_path).claim(
                claim_id, cast(Literal["staged", "published"], bundle), run_id
            )
        except ValueError as error:
            raise WorkspaceError(str(error)) from error

    def query_knowledge(self, payload: object) -> dict:
        required = {"question", "bundle", "run_id", "source_set_digest", "scope"}
        if not isinstance(payload, dict) or set(payload) not in (required, required | {"page"}):
            raise WorkspaceError(
                "Knowledge Query requires question, Bundle, Run, Source Set digest, scope, "
                "and a page for Concept scope"
            )
        values = cast(dict[str, object], payload)
        if any(not isinstance(values[key], str) for key in required):
            raise WorkspaceError("Knowledge Query fields must be strings")
        question = cast(str, values["question"])
        bundle = cast(str, values["bundle"])
        run_id = cast(str, values["run_id"])
        source_set_digest = cast(str, values["source_set_digest"])
        scope = cast(str, values["scope"])
        if not question.strip():
            raise WorkspaceError("Knowledge Query must not be blank")
        if len(question) > 4_000:
            raise WorkspaceError("Knowledge Query exceeds 4000 characters")
        self._validate_run_id(run_id)
        if bundle not in {"staged", "published"}:
            raise WorkspaceError("Knowledge Query Bundle must be staged or published")
        if scope not in {"concept", "bundle"}:
            raise WorkspaceError("Knowledge Query scope must be concept or bundle")
        snapshot = self.open()
        page = values.get("page")
        if scope == "concept":
            if not isinstance(page, str) or not page:
                raise WorkspaceError("Concept-scoped Knowledge Query requires the current page")
            with sqlite3.connect(self.database_path) as connection:
                concepts = list(
                    connection.execute(
                        "SELECT concept_id FROM page_plans WHERE run_id = ? AND path = ?",
                        (run_id, page),
                    )
                )
            if len(concepts) != 1:
                raise WorkspaceError("Current page does not identify one accepted Concept")
            concept_id = concepts[0][0]
        else:
            if page is not None:
                raise WorkspaceError("Bundle-scoped Knowledge Query must not include a page")
            concept_id = None

        import asyncio

        from .gateway_common import GatewayError
        from .gateway_profiles import GatewayApplication
        from .query_agent import (
            KnowledgeQueryContext,
            QueryAgent,
            QueryAnswer,
            record_query_audit,
        )
        from .worker import GatewaySettings, build_gateway_model

        context = KnowledgeQueryContext(
            run_id=run_id,
            source_set_digest=source_set_digest,
            bundle=cast(Literal["staged", "published"], bundle),
            scope=cast(Literal["concept", "bundle"], scope),
            concept_id=concept_id,
        )
        gateways = GatewayApplication(self.config_root)
        assigned_model = snapshot.models.role_overrides.get(
            "query", snapshot.models.default_model or "unconfigured"
        )
        try:
            resolved = gateways.resolve_models(snapshot.models)
            profile, credential = gateways.execution_connection(resolved)
            assigned_model = resolved["assignments"]["query"]
            secrets = (
                credential,
                *profile.headers.values(),
                str(gateways.registry.root),
            )
            limit = resolved["runtime_limits"].get("per_agent_call_total_tokens", 8_000)
            answer = asyncio.run(
                QueryAgent(
                    build_gateway_model(
                        GatewaySettings(
                            base_url=profile.base_url,
                            api_key=credential,
                            model=assigned_model,
                            default_headers=profile.headers,
                        )
                    ),
                    database=self.database_path,
                    model_name=assigned_model,
                    total_tokens_limit=limit,
                    secrets=secrets,
                ).ask(context, question)
            )
        except GatewayError as error:
            answer = QueryAnswer(
                query_id=uuid.uuid4().hex,
                outcome="error",
                run_id=run_id,
                source_set_digest=source_set_digest,
                model=assigned_model,
                scope=context.scope,
                concept_id=concept_id,
                segments=(),
                usage={
                    "requests": 0,
                    "tool_calls": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                },
                latency_ms=0,
                error=str(error),
            )
            record_query_audit(self.database_path, answer)
        except ValueError as error:
            raise WorkspaceError(str(error)) from error
        return answer.model_dump(mode="json")

    def sources(self) -> dict:
        with self._locked():
            self._recover_update_locked()
            return self._sources_locked()

    def set_source_revision(self, payload: object) -> dict:
        values = self._source_payload(
            payload,
            {"id", "revision_policy", "revision", "configuration_digest"},
            "Set Source Revision Policy",
        )
        source_id = values["id"]
        with self._locked():
            self._recover_update_locked()
            if values["configuration_digest"] != self._configuration_digest():
                raise WorkspaceStaleError(
                    "Workspace Sources changed after they were loaded; refresh and try again"
                )
            definition, settings = self._configuration_locked()
            source = next((item for item in definition.sources if item.id == source_id), None)
            if source is None:
                raise WorkspaceError(f"Unknown Source: {source_id}")
            checkout = settings.checkouts.get(source_id)
            if checkout is None:
                raise WorkspaceError(
                    f"Source {source_id} has no checkout binding; clone or link it first"
                )
            self._checkout_call(
                resolve_revision_policy,
                Path(checkout),
                values["revision_policy"],
                values["revision"],
                require_clean=False,
            )
            definition_payload = definition.model_dump(mode="python")
            for item in definition_payload["sources"]:
                if item["id"] == source_id:
                    item["revision_policy"] = values["revision_policy"]
                    item["revision"] = values["revision"]
                    break
            self._update_locked(definition_payload, settings)
            return self._sources_locked()

    def pull_source(self, payload: object) -> dict:
        values = self._source_payload(payload, {"id"}, "Pull Source")
        source_id = values["id"]
        with self._locked():
            self._recover_update_locked()
            definition, settings = self._configuration_locked()
            source = next((item for item in definition.sources if item.id == source_id), None)
            if source is None:
                raise WorkspaceError(f"Unknown Source: {source_id}")
            checkout = settings.checkouts.get(source_id)
            if checkout is None:
                raise WorkspaceError(
                    f"Source {source_id} has no checkout binding; clone or link it first"
                )
            self._checkout_call(
                pull_checkout,
                Path(checkout),
                source_id,
                source.revision
                if _source_revision_policy(source.revision, source.revision_policy)
                == "follow_branch"
                else None,
            )
            return self._sources_locked()

    def run_preflight(self) -> dict:
        _, preflight = self.resolve_run_inputs()
        return preflight

    def start_run(self, payload: object) -> dict:
        if not isinstance(payload, dict) or set(payload) not in (
            {"configuration_digest", "source_set_digest"},
            {"configuration_digest", "source_set_digest", "fixture"},
        ):
            raise WorkspaceError(
                "Start Run must contain configuration_digest, source_set_digest, and optional fixture"
            )
        values = cast(dict[str, object], payload)
        configuration_digest = values["configuration_digest"]
        source_set_digest = values["source_set_digest"]
        fixture = values.get("fixture")
        if not isinstance(configuration_digest, str) or not isinstance(source_set_digest, str):
            raise WorkspaceError("Start Run identities must be strings")
        if fixture is not None and fixture not in {"success", "failure"}:
            raise WorkspaceError("Start Run fixture must be success or failure")

        from .bundle import published_run_id
        from .cli import create_run, load_profile, producer_profile_id, source_set_digest as digest
        from .gateway_profiles import GatewayApplication

        with self._locked():
            self._recover_update_locked()
            snapshot = self._open_current()
            preflight = self._run_preflight_locked(snapshot)
            if configuration_digest != preflight["configuration_digest"]:
                raise WorkspaceStaleError(
                    "Workspace configuration changed after Run preflight; refresh and try again"
                )
            if source_set_digest != preflight["source_set_digest"]:
                raise WorkspaceStaleError(
                    "Source Set changed after Run preflight; refresh and try again"
                )
            if not snapshot.sources:
                raise WorkspaceError("Workspace has no configured Sources")
            resolved_models = None
            if fixture is None:
                gateways = GatewayApplication(self.config_root)
                resolved_models = gateways.resolve_models(snapshot.models)
                gateways.registry.credential(resolved_models["profile"]["id"])
            with sqlite3.connect(self.database_path) as connection:
                active = connection.execute(
                    """SELECT id, state FROM runs
                       WHERE state NOT IN ('published', 'failed', 'cancelled')
                       ORDER BY created_at LIMIT 1"""
                ).fetchone()
                if active is not None:
                    raise WorkspaceError(
                        f"Production Run {active[0]} is {active[1]}; finish or cancel it first"
                    )
                configured_sources = [
                    {
                        "id": source.id,
                        "repository": str(source.checkout),
                        "revision": resolved["exact_commit"],
                        "revision_policy": resolved["revision_policy"],
                        "revision_target": resolved["revision"],
                        "digest": resolved["tree_digest"],
                        "tree_digest": resolved["tree_digest"],
                        "role": source.role,
                    }
                    for source, resolved in zip(snapshot.sources, preflight["sources"], strict=True)
                ]
                if digest(configured_sources) != source_set_digest:
                    raise WorkspaceStaleError(
                        "Source Set changed while creating the Production Run; refresh and try again"
                    )
                profile = load_profile({"profile": snapshot.profile.model_dump(exclude_none=True)})
                workspace_configuration = snapshot.model_dump(mode="json")
                workspace_configuration.update(
                    source_set_digest=source_set_digest,
                    source_snapshots=preflight["sources"],
                )
                if resolved_models is not None:
                    workspace_configuration["resolved_models"] = resolved_models
                run_id = uuid.uuid4().hex
                staging = self.root / ".okf-wiki" / "runs" / run_id / "staging"
                source_set = {
                    "base_run_id": published_run_id(snapshot.publication.path),
                    "digest": source_set_digest,
                    "evidence": [],
                    "execution": {
                        "mode": "deterministic_fixture" if fixture else "gateway_semantic",
                        **({"requested_outcome": fixture} if fixture else {}),
                    },
                    "producer_profile_id": producer_profile_id(profile),
                    "profile": {
                        **profile,
                        "priority_overrides": sorted(profile["priority_overrides"]),
                    },
                    "source_universe": [],
                    "sources": configured_sources,
                    "workspace_configuration": workspace_configuration,
                }
                create_run(
                    connection,
                    run_id,
                    snapshot.project.id,
                    Path(configured_sources[0]["repository"]),
                    configured_sources[0]["revision"]
                    if len(configured_sources) == 1
                    else source_set_digest,
                    snapshot.publication.path,
                    staging,
                    source_set,
                )
            try:
                self._launch_run_worker(run_id, cast(str, fixture or "gateway_semantic"))
            except OSError as error:
                from .run_state import transition_run

                with sqlite3.connect(self.database_path) as connection, connection:
                    transition_run(
                        connection,
                        run_id,
                        "preparing",
                        "failed",
                        error=f"Could not start Run Worker: {error}",
                    )
                raise WorkspaceError(f"Could not start Run Worker: {error}") from error
        return self.run_status(run_id)

    def _launch_run_worker(self, run_id: str, fixture: str) -> None:
        run_state = self.root / ".okf-wiki" / "runs" / run_id
        run_state.mkdir(parents=True, exist_ok=True)
        marker = run_state / "worker.pid"
        acknowledgement = run_state / "worker.ready"
        marker.unlink(missing_ok=True)
        acknowledgement.unlink(missing_ok=True)
        environment = os.environ.copy()
        environment["OKF_WIKI_WORKER_HANDSHAKE"] = "1"
        worker_fault = environment.pop("OKF_WIKI_WORKER_FAULT", None)
        if worker_fault:
            environment["OKF_WIKI_FAULT"] = worker_fault
        if self.config_root is not None:
            environment["OKF_WIKI_CONFIG_HOME"] = str(self.config_root)
        process = subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-m",
                "okf_wiki.run_worker",
                str(self.root),
                run_id,
                fixture,
            ],
            cwd=run_state,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
            env=environment,
        )
        try:
            expected_start = process_start_identity(process.pid)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise OSError("Run Worker exited before startup completed")
                try:
                    identity = json.loads(marker.read_text(encoding="utf-8"))
                except FileNotFoundError, json.JSONDecodeError:
                    time.sleep(0.01)
                    continue
                if identity == {"pid": process.pid, "started": expected_start}:
                    temporary = _write_temp(acknowledgement, "ready\n", 0o600)
                    try:
                        _replace_durable(temporary, acknowledgement)
                    finally:
                        temporary.unlink(missing_ok=True)
                    self._workers[run_id] = process
                    return
                raise OSError("Run Worker startup identity did not match")
            raise OSError("Run Worker startup timed out")
        except Exception:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            marker.unlink(missing_ok=True)
            acknowledgement.unlink(missing_ok=True)
            raise

    def list_runs(self) -> dict:
        self.open()
        with sqlite3.connect(self.database_path) as connection:
            connection.row_factory = sqlite3.Row
            rows = list(connection.execute("SELECT * FROM runs ORDER BY created_at DESC, id DESC"))
        return {"runs": [self._run_summary(row) for row in rows]}

    def concept_provenance(
        self,
        *,
        run_id: str | None = None,
        concept_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
        node_types: tuple[str, ...] = (),
        states: tuple[str, ...] = (),
    ) -> dict:
        self.open()
        from .provenance import (
            MAX_GRAPH_NODES,
            PROVENANCE_FILTER_STATES,
            PROVENANCE_NODE_TYPES,
            ConceptProvenanceStore,
        )

        if not 1 <= limit <= MAX_GRAPH_NODES:
            raise WorkspaceError(f"limit must be between 1 and {MAX_GRAPH_NODES}")
        if offset < 0:
            raise WorkspaceError("offset must be non-negative")
        if unknown := set(node_types) - PROVENANCE_NODE_TYPES:
            raise WorkspaceError(f"Unknown provenance node type: {sorted(unknown)[0]}")
        if unknown := set(states) - PROVENANCE_FILTER_STATES:
            raise WorkspaceError(f"Unknown provenance state: {sorted(unknown)[0]}")
        if run_id is not None:
            self._validate_run_id(run_id)
        else:
            with sqlite3.connect(self.database_path) as connection:
                row = connection.execute(
                    """SELECT r.id FROM runs r
                       WHERE EXISTS (
                         SELECT 1 FROM accepted_concepts c WHERE c.run_id = r.id
                       ) ORDER BY r.created_at DESC, r.id DESC LIMIT 1"""
                ).fetchone()
            run_id = row[0] if row else None
        if run_id is None:
            return {
                "run_id": None,
                "run_state": None,
                "selected_concept_id": None,
                "concepts": [],
                "nodes": [],
                "edges": [],
                "bounds": {
                    "limit": limit,
                    "offset": offset,
                    "previous_offset": None,
                    "next_offset": None,
                    "total_nodes": 0,
                    "total_edges": 0,
                    "filtered_total_nodes": 0,
                    "filtered_total_edges": 0,
                    "truncated": False,
                },
            }
        try:
            return ConceptProvenanceStore(self.database_path).snapshot(
                run_id,
                concept_id=concept_id,
                limit=limit,
                offset=offset,
                node_types=node_types,
                states=states,
            )
        except ValueError as error:
            raise WorkspaceError(str(error)) from error

    def run_status(self, run_id: str) -> dict:
        self._validate_run_id(run_id)
        self.open()
        with sqlite3.connect(self.database_path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row is None:
                raise WorkspaceError(f"Unknown Production Run: {run_id}")
            event_rows = list(
                connection.execute(
                    "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence", (run_id,)
                )
            )
            events = [
                {
                    "occurred_at": event["occurred_at"],
                    "previous_state": event["previous_state"],
                    "sequence": event["sequence"],
                    "state": event["state"],
                }
                for event in event_rows
                if json.loads(event["details"]).get("entity_type") in {None, "production_run"}
            ]
            entity_events = [
                {
                    "entity_id": details["entity_id"],
                    "entity_type": details["entity_type"],
                    "occurred_at": event["occurred_at"],
                    "previous_state": event["previous_state"],
                    "sequence": event["sequence"],
                    "state": event["state"],
                }
                | (
                    {"candidate_id": details["candidate_id"]}
                    if isinstance(details.get("candidate_id"), str)
                    else {}
                )
                for event in event_rows
                if isinstance((details := json.loads(event["details"])).get("entity_type"), str)
                and details["entity_type"] != "production_run"
                and isinstance(details.get("entity_id"), str)
            ]
            task_rows = [
                {
                    "agent_role": task["agent_role"],
                    "budgets": json.loads(task["budgets_json"]),
                    "error": task["error"],
                    "id": task["id"],
                    "obligation_ids": json.loads(task["obligation_ids_json"]),
                    "path_scope": json.loads(task["allowed_paths_json"]),
                    "receipt": json.loads(task["receipt_json"]) if task["receipt_json"] else None,
                    "source_id": task["source_id"],
                    "state": task["state"],
                }
                for task in connection.execute(
                    """SELECT id, state, obligation_ids_json, source_id, allowed_paths_json,
                              agent_role, budgets_json, receipt_json, error
                       FROM analysis_tasks WHERE run_id = ? ORDER BY created_at, id""",
                    (run_id,),
                )
            ]
            from .coverage import obligation_rows

            coverage_obligations = [
                {
                    key: obligation[key]
                    for key in ("id", "priority", "disposition", "source", "role")
                }
                | {
                    "state_changes": [
                        event
                        for event in entity_events
                        if event["entity_type"] == "coverage_obligation"
                        and event["entity_id"] == obligation["id"]
                    ]
                }
                for obligation in obligation_rows(connection, run_id)
            ]
        from .scheduler import scheduler_status

        source_set = self._source_set_for_row(row)
        secrets = self._run_secrets(source_set)
        for task in task_rows:
            if task["error"]:
                task["error"] = self._redact(str(task["error"]), secrets)
            if task["receipt"]:
                task["receipt"]["warnings"] = [
                    self._redact(str(warning), secrets)
                    for warning in task["receipt"].get("warnings", [])
                ]
        scheduler = scheduler_status(self.database_path, run_id)
        scheduler["tasks"] = {
            "active": [
                task for task in task_rows if task["state"] in {"planned", "running", "submitted"}
            ],
            "completed": [task for task in task_rows if task["state"] == "accepted"],
            "failed": [task for task in task_rows if task["state"] in {"rejected", "failed"}],
        }
        errors = list(
            dict.fromkeys(
                self._redact(str(error), secrets)
                for error in [row["error"], *scheduler["errors"]]
                if error
            )
        )
        review_blockers = (
            [
                self._redact(str(blocker), secrets)
                for blocker in verification_blockers(self.database_path, run_id)
            ]
            if row["state"] == "review_required"
            else []
        )
        audit = self._run_audit(run_id)
        if row["state"] in {"review_required", "published", "failed", "cancelled"}:
            self._reap_worker(run_id)
        worker_running = self._worker_running(run_id)
        terminal = row["state"] in {"published", "failed", "cancelled"}
        can_recover = not terminal and row["state"] != "review_required" and not worker_running
        if row["state"] in {"failed", "cancelled"}:
            recover_reason = f"{row['state'].title()} Production Runs are terminal"
        elif row["state"] == "published":
            recover_reason = "Published Production Runs are already complete"
        elif row["state"] == "review_required":
            recover_reason = "Production Run is waiting for review, not recovery"
        elif worker_running:
            recover_reason = "Run Worker is still active"
        else:
            recover_reason = None
        classification = (
            "terminal"
            if terminal
            else "review_blocked"
            if row["state"] == "review_required"
            else "active"
            if worker_running
            else "interrupted"
        )
        staging = Path(row["staging_dir"])
        return {
            **self._run_summary(row),
            "actionable_errors": errors,
            "audit": audit,
            "coverage_obligations": coverage_obligations,
            "diagnostics": {
                "active_tasks": len(scheduler["tasks"]["active"]),
                "budgets": scheduler["budgets"],
                "classification": classification,
                "failed_tasks": len(scheduler["tasks"]["failed"]),
                "review_blockers": review_blockers,
                "staging": {"exists": staging.is_dir(), "path": str(staging)},
                "terminal_outcome": row["state"] if terminal else None,
            },
            "entity_events": entity_events,
            "events": events,
            "models": source_set.get("workspace_configuration", {}).get("resolved_models"),
            "project_id": row["project_id"],
            "operations": {
                "can_cancel": not terminal,
                "can_recover": can_recover,
                "recover_reason": recover_reason,
            },
            "sources": [
                {
                    "id": source["id"],
                    "revision": source["revision"],
                    "role": source["role"],
                    "tree_digest": source.get("tree_digest", source.get("digest")),
                }
                for source in source_set["sources"]
            ],
            "tasks": scheduler["tasks"],
        }

    def cancel_run(self, run_id: str) -> dict:
        self._validate_run_id(run_id)
        with self._locked():
            cancel_run_checkpoint(self.database_path, run_id)
        return self.run_status(run_id)

    def recover_run(self, run_id: str) -> dict:
        self._validate_run_id(run_id)
        recovered_tasks: list[str] = []
        with self._locked():
            with sqlite3.connect(self.database_path) as connection:
                connection.row_factory = sqlite3.Row
                row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row is None:
                raise WorkspaceError(f"Unknown Production Run: {run_id}")
            if row["state"] in {"failed", "cancelled"}:
                raise WorkspaceError(f"Run {run_id} is {row['state']} and terminal")
            if row["state"] not in {"published", "review_required"}:
                if self._worker_running(run_id):
                    raise WorkspaceError(f"Run {run_id} still has an active Run Worker")
                code, outcome = recover_run_checkpoint(self.database_path, run_id)
                if code or not outcome.get("ok"):
                    errors = outcome.get("errors")
                    message = (
                        errors[0] if isinstance(errors, list) and errors else "Run recovery failed"
                    )
                    raise WorkspaceError(str(message))
                recovered_tasks = [str(task_id) for task_id in outcome["recovered_tasks"]]
                if outcome["state"] == "exploring":
                    source_set = self._source_set_for_row(row)
                    execution = source_set.get("execution", {})
                    launch = (
                        execution.get("requested_outcome")
                        if execution.get("mode") == "deterministic_fixture"
                        else "gateway_semantic"
                    )
                    if launch not in {"success", "failure", "gateway_semantic"}:
                        raise WorkspaceError("Production Run has no recoverable execution mode")
                    self._launch_run_worker(run_id, launch)
        return {**self.run_status(run_id), "recovered_tasks": recovered_tasks}

    def review_snapshot(self, run_id: str) -> dict:
        self.open()
        try:
            return review_snapshot(self.database_path, run_id)
        except ReviewError as error:
            raise WorkspaceError(str(error)) from error

    def review_evidence(self, run_id: str, evidence_id: str) -> dict:
        self.open()
        try:
            return evidence_excerpt(self.database_path, run_id, evidence_id)
        except ReviewError as error:
            raise WorkspaceError(str(error)) from error

    def review_bundle_file(self, run_id: str, path: str) -> dict:
        self.open()
        try:
            return bundle_file_detail(self.database_path, run_id, path)
        except ReviewError as error:
            raise WorkspaceError(str(error)) from error

    def decide_review(self, run_id: str, payload: object) -> dict:
        if not isinstance(payload, dict) or set(payload) != {"decision", "expected_digest"}:
            raise WorkspaceError("Review decision requires decision and expected_digest")
        payload = cast(dict[str, object], payload)
        decision = payload["decision"]
        expected_digest = payload["expected_digest"]
        if not isinstance(decision, str) or not isinstance(expected_digest, str):
            raise WorkspaceError("Review decision fields must be strings")
        self.open()
        try:
            return decide_review(self.database_path, run_id, decision, expected_digest)
        except ReviewStaleError as error:
            raise WorkspaceReviewStaleError(error.snapshot) from error
        except ReviewError as error:
            raise WorkspaceError(str(error)) from error

    @staticmethod
    def _validate_run_id(run_id: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", run_id):
            raise WorkspaceError("Invalid Production Run ID")

    def _worker_running(self, run_id: str) -> bool:
        process = self._workers.get(run_id)
        if process is not None:
            if process.poll() is None:
                return True
            process.wait()
            self._workers.pop(run_id, None)
        marker = self.root / ".okf-wiki" / "runs" / run_id / "worker.pid"
        try:
            identity = json.loads(marker.read_text(encoding="utf-8"))
            pid = int(identity["pid"])
            try:
                finished, _status = os.waitpid(pid, os.WNOHANG)
                if finished:
                    marker.unlink(missing_ok=True)
                    return False
            except ChildProcessError:
                pass
            os.kill(pid, 0)
            started = identity.get("started")
            if started is not None and process_start_identity(pid) != started:
                marker.unlink(missing_ok=True)
                return False
        except (
            FileNotFoundError,
            json.JSONDecodeError,
            KeyError,
            ProcessLookupError,
            TypeError,
            ValueError,
        ):
            return False
        except PermissionError:
            return True
        return True

    def _reap_worker(self, run_id: str) -> None:
        process = self._workers.get(run_id)
        if process is None:
            return
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            return
        self._workers.pop(run_id, None)

    def _run_secrets(self, source_set: dict) -> tuple[str, ...]:
        from .gateway_profiles import GatewayApplication

        gateways = GatewayApplication(self.config_root)
        secrets = [str(gateways.registry.root)]
        resolved = source_set.get("workspace_configuration", {}).get("resolved_models")
        profile_id = resolved.get("profile", {}).get("id") if isinstance(resolved, dict) else None
        if isinstance(profile_id, str):
            try:
                profile = gateways.registry.get(profile_id)
                secrets.extend(profile.headers.values())
                secrets.append(gateways.registry.credential(profile_id))
            except Exception:
                pass
        return tuple(secrets)

    @staticmethod
    def _redact(value: str, secrets: tuple[str, ...]) -> str:
        from .security import redact_secrets

        return redact_secrets(value, secrets)

    def _run_audit(self, run_id: str) -> dict:
        from .semantic_audit import aggregate_semantic_audit

        return aggregate_semantic_audit(self.root / ".okf-wiki" / "runs" / run_id / "worker.db")

    @staticmethod
    def _run_summary(row: sqlite3.Row) -> dict:
        source_set = WorkspaceApplication._source_set_for_row(row)
        state = row["state"]
        return {
            "created_at": row["created_at"],
            "execution": source_set.get("execution", {"mode": "legacy", "requested_outcome": None}),
            "outcome": state
            if state in {"review_required", "published", "failed", "cancelled"}
            else None,
            "phase": state,
            "run_id": row["id"],
            "source_set_digest": source_set["digest"],
            "state": state,
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _source_set_for_row(row: sqlite3.Row) -> dict:
        if row["source_set_json"]:
            return json.loads(row["source_set_json"])
        source = {
            "id": "source",
            "repository": row["repository"],
            "revision": row["revision"],
            "role": "implementation",
        }
        identity = json.dumps(
            [
                {
                    "digest": None,
                    "id": "source",
                    "revision": row["revision"],
                    "role": "implementation",
                }
            ],
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        return {
            "digest": hashlib.sha256(identity).hexdigest(),
            "evidence": [],
            "source_universe": [],
            "sources": [source],
        }

    def resolve_run_inputs(self) -> tuple[WorkspaceSnapshot, dict]:
        with self._locked():
            self._recover_update_locked()
            snapshot = self._open_current()
            return snapshot, self._run_preflight_locked(snapshot)

    def _run_preflight_locked(self, snapshot: WorkspaceSnapshot) -> dict:
        sources = []
        for source in snapshot.sources:
            if source.checkout is None:
                raise WorkspaceError(
                    f"Source {source.id} has no checkout binding; clone or link it first"
                )
            policy = _source_revision_policy(source.revision, source.revision_policy)
            resolved = self._checkout_call(
                resolve_revision_policy,
                source.checkout,
                policy,
                source.revision,
            )
            sources.append(
                {
                    "id": source.id,
                    "role": source.role,
                    "revision_policy": policy,
                    "revision": source.revision,
                    **resolved,
                }
            )
        identity = json.dumps(
            [
                {
                    "digest": source["tree_digest"],
                    "id": source["id"],
                    "revision": source["exact_commit"],
                    "role": source["role"],
                }
                for source in sources
            ],
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        return {
            "configuration_digest": snapshot.configuration_digest,
            "source_set_digest": hashlib.sha256(identity).hexdigest(),
            "sources": sources,
        }

    def clone_source(self, payload: object) -> dict:
        values = self._source_payload_any(
            payload, ({"id"}, {"id", "role", "remote"}), "Clone Source"
        )
        source_id = values["id"]
        self._validate_source_id(source_id)
        with self._locked():
            self._recover_update_locked()
            definition, settings = self._configuration_locked()
            existing = next(
                (source for source in definition.sources if source.id == source_id), None
            )
            self._ensure_source_unbound(source_id, settings)
            if existing is not None:
                if "role" in values and values["role"] != existing.role:
                    raise WorkspaceError(
                        f"Configured Source {source_id} role is {existing.role}; shared definition is unchanged"
                    )
                if "remote" in values and values["remote"] != existing.remote:
                    raise WorkspaceError(
                        f"Configured Source {source_id} remote differs from the shared definition"
                    )
                if existing.remote is None:
                    raise WorkspaceError(
                        f"Configured Source {source_id} has no remote; link an existing checkout"
                    )
                source = existing
                remote = existing.remote
                revision = existing.revision
            else:
                if set(values) != {"id", "role", "remote"}:
                    raise WorkspaceError("A new Clone Source must contain id, role, and remote")
                source = self._new_source(
                    source_id, values["role"], "0" * 40, values["remote"], None
                )
                remote = values["remote"]
                revision = None
            self._checkout_call(validate_clone_remote, remote)
            target, status, identity = self._checkout_call(
                clone_checkout,
                self.root,
                self.settings_path.parent,
                source_id,
                remote,
                revision,
                source.revision
                if existing
                and _source_revision_policy(source.revision, source.revision_policy)
                == "follow_branch"
                else None,
            )
            definition_payload = definition.model_dump(mode="python")
            if existing is None:
                source = self._new_source(
                    source.id,
                    source.role,
                    cast(str, status["branch"] or status["commit"]),
                    cast(str | None, status["remote"]) or remote,
                    "follow_branch" if status["branch"] else "pinned_commit",
                )
                definition_payload["sources"].append(source.model_dump(mode="python"))
            settings_payload = settings.model_dump(mode="python")
            settings_payload["checkouts"][source.id] = str(target)
            settings_payload["managed_checkouts"][source.id] = {
                "path": str(target),
                "device": identity.st_dev,
                "inode": identity.st_ino,
            }
            try:
                if existing is None:
                    self._update_locked(definition_payload, settings_payload)
                else:
                    self._update_local_settings_locked(settings_payload)
            except Exception as error:
                try:
                    delete_managed_checkout(
                        self.root, source_id, target, identity.st_dev, identity.st_ino
                    )
                except SourceCheckoutError as cleanup_error:
                    raise WorkspaceError(
                        f"{error}; managed clone cleanup failed: {cleanup_error}"
                    ) from cleanup_error
                raise
            return self._sources_locked()

    def link_source(self, payload: object) -> dict:
        values = self._source_payload_any(
            payload, ({"id", "checkout"}, {"id", "role", "checkout"}), "Link Source"
        )
        source_id = values["id"]
        self._validate_source_id(source_id)
        checkout = Path(values["checkout"]).expanduser().resolve()
        try:
            checkout.relative_to(self.root)
        except ValueError:
            pass
        else:
            raise WorkspaceError("Linked Source checkout must be outside the Workspace")
        with self._locked():
            self._recover_update_locked()
            definition, settings = self._configuration_locked()
            existing = next(
                (source for source in definition.sources if source.id == source_id), None
            )
            self._ensure_source_unbound(source_id, settings)
            status = self._checkout_call(inspect_checkout, checkout)
            definition_payload = definition.model_dump(mode="python")
            if existing is not None:
                if "role" in values and values["role"] != existing.role:
                    raise WorkspaceError(
                        f"Configured Source {source_id} role is {existing.role}; shared definition is unchanged"
                    )
                if (
                    _source_revision_policy(existing.revision, existing.revision_policy)
                    == "follow_branch"
                ):
                    self._checkout_call(
                        resolve_revision_policy,
                        checkout,
                        "follow_branch",
                        existing.revision,
                        require_clean=False,
                    )
                else:
                    self._checkout_call(verify_checkout_revision, checkout, existing.revision)
                source = existing
            else:
                if "role" not in values:
                    raise WorkspaceError("A new Link Source must contain id, role, and checkout")
                source = self._new_source(
                    source_id,
                    values["role"],
                    cast(str, status["branch"] or status["commit"]),
                    cast(str | None, status["remote"]),
                    "follow_branch" if status["branch"] else "pinned_commit",
                )
                definition_payload["sources"].append(source.model_dump(mode="python"))
            settings_payload = settings.model_dump(mode="python")
            settings_payload["checkouts"][source.id] = str(checkout)
            if existing is None:
                self._update_locked(definition_payload, settings_payload)
            else:
                self._update_local_settings_locked(settings_payload)
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
            self._update_local_settings_locked(settings_payload)
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
                "local_commit": None,
                "remote_commit": None,
                "dirty": None,
                "ahead": None,
                "behind": None,
                "error": None,
            }
            if checkout_text:
                try:
                    status = self._checkout_call(inspect_checkout, Path(checkout_text))
                    policy = _source_revision_policy(source.revision, source.revision_policy)
                    resolved = self._checkout_call(
                        resolve_revision_policy,
                        Path(checkout_text),
                        policy,
                        source.revision,
                        require_clean=False,
                    )
                    status["local_commit"] = resolved["local_commit"]
                    status["remote_commit"] = resolved["remote_commit"]
                except WorkspaceError as error:
                    status["error"] = str(error)
            sources.append(
                {
                    "id": source.id,
                    "role": source.role,
                    "revision": source.revision,
                    "revision_policy": _source_revision_policy(
                        source.revision, source.revision_policy
                    ),
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
        return WorkspaceApplication._source_payload_any(payload, (fields,), operation)

    @staticmethod
    def _source_payload_any(
        payload: object, field_sets: tuple[set[str], ...], operation: str
    ) -> dict[str, str]:
        expected = next(
            (
                fields
                for fields in field_sets
                if isinstance(payload, dict) and set(payload) == fields
            ),
            None,
        )
        if expected is None:
            alternatives = " or ".join(", ".join(sorted(fields)) for fields in field_sets)
            raise WorkspaceError(f"{operation} must contain {alternatives}")
        assert isinstance(payload, dict)
        values = cast(dict[str, object], payload)
        for key, value in values.items():
            if not isinstance(value, str) or not value.strip():
                raise WorkspaceError(f"{operation} field {key} must be a non-empty string")
        return {key: cast(str, value).strip() for key, value in values.items()}

    def _new_source(
        self,
        source_id: str,
        role: str,
        revision: str,
        remote: str | None,
        revision_policy: Literal["follow_branch", "pinned_commit"] | None = None,
    ) -> WorkspaceSource:
        try:
            return WorkspaceSource(
                id=source_id,
                role=role,
                revision=revision,
                remote=remote,
                revision_policy=revision_policy,
            )
        except ValidationError as error:
            item = error.errors()[0]
            location = ".".join(str(part) for part in item["loc"])
            raise WorkspaceError(f"Invalid Source {location}: {item['msg']}") from error

    @staticmethod
    def _checkout_call(function, *arguments, **keywords):
        try:
            return function(*arguments, **keywords)
        except SourceCheckoutError as error:
            raise WorkspaceError(str(error)) from error

    @staticmethod
    def _validate_source_id(source_id: str) -> None:
        if not SOURCE_ID_RE.fullmatch(source_id):
            raise WorkspaceError("Invalid Source id: must use a safe stable identifier")

    @staticmethod
    def _ensure_source_unbound(source_id: str, settings: LocalWorkspaceSettings) -> None:
        if source_id in settings.checkouts:
            raise WorkspaceError(f"Source {source_id} already has a checkout binding")
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
