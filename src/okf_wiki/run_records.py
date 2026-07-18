"""Wiki Run records: load, write, manual retry assembly, and secret redaction."""

from __future__ import annotations

import json
import os
import re
import uuid
from collections.abc import Iterator, Mapping
from datetime import datetime
from pathlib import Path
from typing import cast

from pydantic import ValidationError
from pydantic_ai import ModelSettings
from pydantic_ai.models import Model

from .errors import operator_error
from .run_models import (
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunLimits,
    WikiRunRecord,
    WikiRunRecordStatus,
    WikiRunRequest,
)
from .run_mounts import _check_directory_path, _create_directory_path
from .security import environment_secrets, git_read, redact_secrets


def _exception_chain(error: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    pending: list[BaseException] = [error]
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)


_SECRET_SETTING_MARKERS = (
    "api_key",
    "apikey",
    "authorization",
    "credential",
    "password",
    "secret",
    "token",
)


def _model_secret_values(settings: Mapping[str, object]) -> tuple[str, ...]:
    values: set[str] = set()

    def collect(value: object, *, sensitive: bool) -> None:
        if isinstance(value, Mapping):
            for key, item in value.items():
                normalized = str(key).casefold().replace("-", "_")
                collect(
                    item,
                    sensitive=sensitive
                    or normalized in {"extra_body", "extra_headers"}
                    or any(marker in normalized for marker in _SECRET_SETTING_MARKERS),
                )
        elif isinstance(value, (list, tuple)):
            for item in value:
                collect(item, sensitive=sensitive)
        elif sensitive and isinstance(value, str) and value:
            values.add(value)

    collect(settings, sensitive=False)
    values.update(environment_secrets())
    return tuple(values)


def _safe_model_error(error: Exception, settings: Mapping[str, object]) -> str | None:
    secrets = _model_secret_values(settings)
    if secrets and any(
        redact_secrets(str(item), secrets) != str(item) for item in _exception_chain(error)
    ):
        return f"{type(error).__name__}: model provider diagnostics withheld"
    return None


_RUN_RECORD_MAX_BYTES = 128 * 1024


def _record_settings(settings: Mapping[str, object]) -> dict[str, object]:
    secrets = _model_secret_values(settings)

    def sanitize(value: object, *, sensitive: bool = False, depth: int = 0) -> object:
        if sensitive:
            return "[redacted]"
        if depth >= 4:
            return "[truncated]"
        if isinstance(value, Mapping):
            result: dict[str, object] = {}
            for key, item in list(value.items())[:64]:
                normalized = str(key).casefold().replace("-", "_")
                child_sensitive = normalized in {"extra_body", "extra_headers"} or any(
                    marker in normalized for marker in _SECRET_SETTING_MARKERS
                )
                result[str(key)[:100]] = sanitize(item, sensitive=child_sensitive, depth=depth + 1)
            return result
        if isinstance(value, (list, tuple)):
            return [sanitize(item, depth=depth + 1) for item in list(value)[:64]]
        if isinstance(value, str):
            return redact_secrets(value, secrets)[:2_000]
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return f"<{type(value).__name__}>"

    value = sanitize(settings)
    result = cast(dict[str, object], value) if isinstance(value, dict) else {}
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 16 * 1024:
        return {"truncated": True}
    return result


def _record_model(model: Model | str, settings: Mapping[str, object]) -> dict[str, object]:
    secrets = _model_secret_values(settings)
    if isinstance(model, str):
        identity = model
        replayable = True
    else:
        try:
            identity = getattr(model, "model_name", None) or model.__class__.__name__
        except Exception:
            identity = model.__class__.__name__
        replayable = False
    return {
        "identity": redact_secrets(str(identity), secrets)[:200],
        "replayable": replayable,
        "settings": _record_settings(settings),
    }


def _record_usage(usage: object, extra: Mapping[str, object] | None = None) -> dict[str, object]:
    input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
    result = {
        "requests": int(getattr(usage, "requests", 0) or 0),
        "tool_calls": int(getattr(usage, "tool_calls", 0) or 0),
        "input_tokens": input_tokens,
        "cache_write_tokens": int(getattr(usage, "cache_write_tokens", 0) or 0),
        "cache_read_tokens": int(getattr(usage, "cache_read_tokens", 0) or 0),
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }
    if extra:
        for key in ("requests", "tool_calls", "input_tokens", "output_tokens"):
            extra_value = extra.get(key, 0)
            increment = extra_value if isinstance(extra_value, (int, float)) else 0
            base_value = cast(int | float, result[key])
            result[key] = int(base_value) + int(increment)
        result["total_tokens"] = int(result["input_tokens"]) + int(result["output_tokens"])
    return result


# Allow PascalCase exception type names (e.g. OSError) as bounded diagnostic labels.
_EVENT_ENUM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
_EVENT_SAFE_KEYS = {
    "attempt",
    "changed",
    "count",
    "depth",
    "duration_seconds",
    "dynamic_workflow",
    "reviewer",
    "fanout",
    "retries",
    "kind",
    "node_kind",
    "reason_code",
    "error_type",
    "status",
    "total",
    "wait_seconds",
    "active",
    "max_active",
    "concurrency",
    "critical_failures",
    "receipt_bytes",
    "requests",
    "tool_calls",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "provider_attempts",
    "provider_possible_duplicates",
    "fallback",
    "context_tokens",
    "warning_tokens",
    "before_tokens",
    "target_tokens",
    "defect_count",
}


def _event_payload(payload: Mapping[str, object]) -> dict[str, object]:
    """Keep public diagnostics to bounded counters and enum-like labels."""
    result: dict[str, object] = {}
    for raw_key, value in list(payload.items())[:32]:
        key = str(raw_key)[:64]
        if key not in _EVENT_SAFE_KEYS:
            continue
        if isinstance(value, bool) or isinstance(value, (int, float)):
            result[key] = value
        elif isinstance(value, str) and _EVENT_ENUM_RE.fullmatch(value):
            result[key] = value
    return result


def _record_directory(publication: Path) -> Path:
    return publication.parent / f".{publication.name}.runs"


def load_run_record(path: Path) -> WikiRunRecord:
    """Load a secret-free Wiki Run Record from disk."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise operator_error("Wiki Run Record is not readable JSON", error) from error
    if not isinstance(payload, dict):
        raise ValueError("Wiki Run Record must be a JSON object")
    try:
        return WikiRunRecord.model_validate(payload)
    except ValidationError as error:
        raise operator_error("Wiki Run Record is invalid", error) from error


def _manual_retry_request(
    record: WikiRunRecord | Path | Mapping[str, object],
    *,
    staging: Path,
    publication: Path,
    model: Model | str | None = None,
    explicit_answers: Mapping[str, str] | None = None,
    retain_analysis_workspace: bool = False,
) -> WikiRunRequest:
    """Create a fresh Manual Retry Run request from a terminal run record."""
    if isinstance(record, Path):
        loaded = load_run_record(record)
    elif isinstance(record, WikiRunRecord):
        loaded = record
    else:
        try:
            loaded = WikiRunRecord.model_validate(record)
        except ValidationError as error:
            raise operator_error("Wiki Run Record is invalid", error) from error
    if loaded.status not in {"failed", "cancelled"}:
        raise ValueError("Manual Retry Run requires a failed or cancelled Wiki Run Record")
    if not loaded.model.get("replayable", False) and model is None:
        raise ValueError(
            "Manual Retry Run requires an explicit model because the recorded model is "
            "not replayable across processes"
        )
    repositories: list[RepositorySnapshot] = []
    for item in loaded.repositories:
        repo_id = str(item.get("id") or "repo")
        path = Path(str(item["path"]))
        revision = str(item["revision"])
        ignore = tuple(str(pattern) for pattern in cast(list[object], item.get("ignore") or ()))
        if "effective_ignore" not in item:
            raise ValueError(
                "Manual Retry Run requires frozen effective_ignore for each repository; "
                "create a new Wiki Run if the record predates Effective Source Ignores"
            )
        frozen_effective = tuple(
            str(pattern) for pattern in cast(list[object], item.get("effective_ignore") or ())
        )
        apply_defaults = bool(item.get("apply_default_source_ignores", True))
        if not path.exists():
            raise ValueError(f"Frozen repository path is no longer available: {path}")
        # Fail closed if the exact revision cannot be resolved.
        try:
            resolved = git_read(path, "rev-parse", "--verify", f"{revision}^{{commit}}").strip()
        except Exception as error:
            raise operator_error(
                f"Frozen repository revision is no longer available ({revision})",
                error,
            ) from error
        if resolved.casefold() != revision.casefold():
            raise ValueError(f"Frozen repository revision is no longer available: {revision}")
        repositories.append(
            RepositorySnapshot(
                id=repo_id,
                path=path,
                revision=revision,
                ignore=ignore,
                apply_default_source_ignores=apply_defaults,
                frozen_effective_ignore=frozen_effective,
            )
        )
    skill_path = Path(str(loaded.skill["path"]))
    skill_digest = str(loaded.skill["digest"])
    if not skill_path.exists():
        raise ValueError(f"Frozen Skill path is no longer available: {skill_path}")
    try:
        skill = ProducerSkillVersion.from_directory(skill_path)
    except Exception as error:
        raise operator_error(
            f"Frozen Skill path is invalid: {skill_path}",
            error,
        ) from error
    if skill.digest != skill_digest:
        raise ValueError(
            "Frozen Skill digest no longer matches the recorded Skill: "
            f"expected {skill_digest}, found {skill.digest}"
        )
    try:
        limits = WikiRunLimits.model_validate(loaded.limits)
    except ValidationError as error:
        raise operator_error("Manual Retry Run limits are invalid", error) from error
    try:
        if model is None:
            model_identity = str(loaded.model["identity"])
            settings = cast(dict[str, object], loaded.model.get("settings") or {})
            model_config = ModelProviderConfig(
                model=model_identity, settings=ModelSettings(**settings)
            )
        else:
            settings = cast(dict[str, object], loaded.model.get("settings") or {})
            model_config = ModelProviderConfig(model=model, settings=ModelSettings(**settings))
    except Exception as error:
        raise operator_error("Manual Retry Run model settings are invalid", error) from error
    answers = dict(loaded.explicit_answers)
    if explicit_answers is not None:
        answers.update({str(key): str(value) for key, value in explicit_answers.items()})
    return WikiRunRequest(
        operation=loaded.operation,
        repositories=tuple(repositories),
        skill=skill,
        model=model_config,
        limits=limits,
        staging=staging,
        publication=publication,
        retain_analysis_workspace=retain_analysis_workspace,
        explicit_answers=answers,
        prior_run_id=loaded.run_id,
    )


def _record_publication_path(value: Path) -> Path | None:
    """Best-effort absolute publication path for run records.

    Prefer a resolved parent + final name when the filesystem cooperates. On failure,
    fall back to ``Path.absolute()`` so a completed run still has a record location
    rather than silently losing the path (``None`` only when even that fails or the
    path has no directory name).
    """
    try:
        candidate = value.absolute()
    except OSError, RuntimeError, ValueError:
        return None
    if not candidate.name:
        return None
    try:
        return candidate.parent.resolve(strict=False) / candidate.name
    except OSError, RuntimeError, ValueError:
        return candidate


def _write_json_atomically(path: Path, data: bytes, *, max_bytes: int, label: str) -> None:
    if len(data) > max_bytes:
        raise ValueError(f"{label} exceeds the configured byte limit")
    _check_directory_path(path.parent, f"{label} parent")
    _create_directory_path(path.parent, f"{label} parent")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, 0o600)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(descriptor, view) :]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if os.path.lexists(path):
            raise ValueError(f"{label} already exists")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_run_record(
    request: WikiRunRequest,
    *,
    run_id: str,
    publication: Path,
    status: WikiRunRecordStatus,
    started_at: datetime,
    completed_at: datetime,
    usage: object,
    retry_counters: Mapping[str, int],
    publication_status: dict[str, object],
    failure_category: str | None,
    skill_path: Path | None = None,
    adaptive_usage: Mapping[str, object] | None = None,
) -> None:
    secrets = _model_secret_values(request.model.settings)
    repositories: list[dict[str, object]] = []
    for repository in request.repositories:
        path = redact_secrets(str(repository.path.resolve()), secrets)
        effective = repository.effective_source_ignores()
        item: dict[str, object] = {
            "id": repository.id,
            "path": path[:1_024],
            "revision": repository.revision,
            "apply_default_source_ignores": repository.apply_default_source_ignores,
            "ignore": [redact_secrets(pattern, secrets)[:500] for pattern in repository.ignore],
            "effective_ignore": [redact_secrets(pattern, secrets)[:500] for pattern in effective],
        }
        if len(path) > 1_024:
            item["path_truncated"] = True
        repositories.append(item)
    skill = redact_secrets(str(skill_path or request.skill.path.resolve()), secrets)
    answers = {
        redact_secrets(str(key), secrets)[:128]: redact_secrets(str(value), secrets)[:500]
        for key, value in list(request.explicit_answers.items())[:32]
    }
    record = WikiRunRecord(
        run_id=run_id,
        status=status,
        operation=request.operation,
        repositories=repositories,
        skill={"path": skill[:1_024], "digest": request.skill.digest},
        model=_record_model(request.model.model, request.model.settings),
        limits=request.limits.model_dump(mode="json"),
        explicit_answers=answers,
        started_at=started_at,
        completed_at=completed_at,
        duration_seconds=max(0.0, (completed_at - started_at).total_seconds()),
        usage=_record_usage(usage, adaptive_usage),
        retry_counters=dict(retry_counters),
        publication=publication_status,
        failure_category=failure_category,
    )
    encoded = json.dumps(
        record.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    _write_json_atomically(
        _record_directory(publication) / f"{run_id}.json",
        encoded,
        max_bytes=_RUN_RECORD_MAX_BYTES,
        label="Wiki Run Record",
    )
