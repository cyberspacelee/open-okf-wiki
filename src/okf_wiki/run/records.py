"""Wiki Run records: load, write, and Manual Retry assembly.

**Manual Retry path** for request assembly lives here (``_manual_retry_request``),
exposed publicly as :meth:`okf_wiki.run.models.WikiRunRequest.from_run_record`.

Event payload sanitization and model-error redaction live in
:mod:`okf_wiki.run.events` (re-exported here for compatibility).

Sibling assembly entry points:

* YAML — :mod:`okf_wiki.run.config` (``WikiRunRequest.from_yaml``)
* Programmatic — construct :class:`~okf_wiki.run.models.WikiRunRequest` / factories
  in :mod:`okf_wiki.run.models` directly
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import cast

from pydantic import ValidationError
from pydantic_ai import ModelSettings
from pydantic_ai.models import Model

from .errors import operator_error
from .models import (
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiRunLimits,
    WikiRunRecord,
    WikiRunRecordStatus,
    WikiRunRequest,
)
from .events import (
    exception_chain,
    safe_model_error,
    sanitize_event_payload,
)
from .filesystem import check_directory_path, create_directory_path, write_bytes_atomically
from .security import (
    _SECRET_SETTING_MARKERS,
    environment_secrets,
    git_read,
    redact_secrets,
)

# Compatibility re-exports / aliases.
_exception_chain = exception_chain
_safe_model_error = safe_model_error
_event_payload = sanitize_event_payload


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


def record_publication_path(value: Path) -> Path | None:
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


_record_publication_path = record_publication_path


def _write_json_atomically(path: Path, data: bytes, *, max_bytes: int, label: str) -> None:
    check_directory_path(path.parent, f"{label} parent")
    create_directory_path(path.parent, f"{label} parent")
    write_bytes_atomically(path, data, max_bytes=max_bytes, label=label)


def write_run_record(
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


# Private alias kept for test monkeypatches during the deepening transition.
_write_run_record = write_run_record


__all__ = [
    "exception_chain",
    "load_run_record",
    "record_publication_path",
    "safe_model_error",
    "sanitize_event_payload",
    "write_run_record",
]
