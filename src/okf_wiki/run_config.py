"""YAML loading and Wiki Run request configuration."""

from __future__ import annotations

import os
import re
from collections.abc import Hashable, Mapping
from pathlib import Path
from typing import Annotated, Literal

import yaml
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode
from yaml.resolver import BaseResolver

from .errors import ConfigError, operator_error
from .provider_env import resolve_model_identity, resolve_model_settings
from .run_models import (
    IgnorePattern,
    ModelProviderConfig,
    ProducerSkillVersion,
    RepositoryId,
    RepositorySnapshot,
    SkillDigest,
    WikiRunLimits,
    WikiRunRequest,
    _validate_unique_repository_ids,
)
from .run_mounts import _existing_directory
from .security import git_read


class _ConfiguredRepository(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: RepositoryId
    path: Path
    branch: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)] | None = None
    revision: (
        Annotated[
            str,
            StringConstraints(
                strip_whitespace=True,
                to_lower=True,
                pattern=r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
            ),
        ]
        | None
    ) = None
    ignore: tuple[IgnorePattern, ...] = ()
    apply_default_source_ignores: bool = True

    @model_validator(mode="after")
    def validate_ref(self) -> "_ConfiguredRepository":
        if (self.branch is None) == (self.revision is None):
            raise ConfigError("each repository must define exactly one of branch or revision")
        return self


class _ConfiguredSkill(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: Path
    digest: SkillDigest


def _coerce_configured_model(value: object) -> object:
    if isinstance(value, str):
        return {"identity": value}
    return value


class _ConfiguredModel(BaseModel):
    """Non-secret model selection. Credentials stay in environment / ``.env``."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    identity: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)] | None = None
    max_tokens: int | None = Field(default=None, gt=0)
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    timeout: float | None = Field(default=None, gt=0)


class _WikiRunFileConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1]
    operation: Literal["generate", "refresh"] = "generate"
    model: Annotated[_ConfiguredModel, BeforeValidator(_coerce_configured_model)] = Field(
        default_factory=_ConfiguredModel
    )
    # Optional separate Wiki Reviewer model; string or object form, same as ``model``.
    reviewer_model: (
        Annotated[_ConfiguredModel, BeforeValidator(_coerce_configured_model)] | None
    ) = None
    staging: Path
    publication: Path
    repositories: tuple[_ConfiguredRepository, ...] = Field(min_length=1, max_length=64)
    skill: _ConfiguredSkill | None = None
    # Raw mapping so omitted keys can still pick up env defaults via WikiRunLimits.build.
    limits: dict[str, object] | None = None
    retain_analysis_workspace: bool = False
    write_visualization: bool = False

    @model_validator(mode="after")
    def validate_repository_ids(self) -> "_WikiRunFileConfig":
        _validate_unique_repository_ids(
            (repository.id for repository in self.repositories),
            "repository IDs must be unique",
        )
        if self.limits is not None:
            unknown = set(self.limits) - set(WikiRunLimits.model_fields)
            if unknown:
                names = ", ".join(sorted(unknown))
                raise ConfigError(f"Unknown limits fields: {names}")
        return self


class _UniqueKeySafeLoader(yaml.SafeLoader):
    pass


def _construct_unique_mapping(
    loader: _UniqueKeySafeLoader, node: MappingNode, deep: bool = False
) -> dict[object, object]:
    loader.flatten_mapping(node)
    mapping: dict[object, object] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, Hashable):
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "found unhashable key",
                key_node.start_mark,
            )
        if key in mapping:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key ({key!r})",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_UniqueKeySafeLoader.add_constructor(BaseResolver.DEFAULT_MAPPING_TAG, _construct_unique_mapping)


_CONFIG_SECRET_MARKERS = (
    "authorization",
    "apikey",
    "credential",
    "credentials",
    "header",
    "headers",
    "key",
    "password",
    "secret",
    "token",
)


def _reject_yaml_secrets(value: object) -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).casefold())
            if any(normalized.endswith(marker) for marker in _CONFIG_SECRET_MARKERS):
                raise ConfigError(
                    "Secrets and provider headers are not allowed in Wiki Run YAML; "
                    "use process environment variables or a secret manager"
                )
            _reject_yaml_secrets(item)
    elif isinstance(value, list):
        for item in value:
            _reject_yaml_secrets(item)


def _configured_path(root: Path, value: Path) -> Path:
    return Path(os.path.normpath(value if value.is_absolute() else root / value))


def _resolve_branch(checkout: Path, branch: str) -> str:
    try:
        validated = git_read(checkout, "check-ref-format", "--branch", branch).strip()
    except ValueError as error:
        raise operator_error(f"Repository branch is invalid: {branch!r}", error) from error
    if validated != branch:
        raise ConfigError(f"Repository branch is not canonical: {branch!r}")
    try:
        return git_read(
            checkout, "rev-parse", "--verify", f"refs/heads/{branch}^{{commit}}"
        ).strip()
    except ValueError as error:
        raise operator_error(
            f"Repository branch does not resolve locally: {branch!r}", error
        ) from error


def _wiki_run_request_from_yaml(path: Path) -> WikiRunRequest:
    config_path = path.resolve(strict=True)
    try:
        raw = yaml.load(config_path.read_text(encoding="utf-8"), Loader=_UniqueKeySafeLoader)
    except (OSError, UnicodeError, yaml.YAMLError) as error:
        raise operator_error("Wiki Run YAML is not readable valid UTF-8 YAML", error) from error
    _reject_yaml_secrets(raw)
    try:
        config = _WikiRunFileConfig.model_validate(raw)
    except ValidationError as error:
        raise operator_error("Wiki Run YAML configuration is invalid", error) from error
    root = config_path.parent
    repositories = []
    for configured in config.repositories:
        checkout = _existing_directory(
            _configured_path(root, configured.path),
            f"Repository Snapshot {configured.id}",
        )
        revision = configured.revision or _resolve_branch(checkout, configured.branch or "")
        repositories.append(
            RepositorySnapshot(
                id=configured.id,
                path=checkout,
                revision=revision,
                ignore=configured.ignore,
                apply_default_source_ignores=configured.apply_default_source_ignores,
            )
        )
    skill = (
        ProducerSkillVersion.default()
        if config.skill is None
        else ProducerSkillVersion(
            path=_configured_path(root, config.skill.path),
            digest=config.skill.digest,
        )
    )
    try:
        model_identity = resolve_model_identity(config.model.identity)
        model_settings = resolve_model_settings(
            max_tokens=config.model.max_tokens,
            temperature=config.model.temperature,
            top_p=config.model.top_p,
            timeout=config.model.timeout,
        )
        limits = WikiRunLimits.build(config.limits)
        reviewer_config: ModelProviderConfig | None = None
        if config.reviewer_model is not None:
            reviewer_identity = resolve_model_identity(config.reviewer_model.identity)
            reviewer_settings = resolve_model_settings(
                max_tokens=config.reviewer_model.max_tokens,
                temperature=config.reviewer_model.temperature,
                top_p=config.reviewer_model.top_p,
                timeout=config.reviewer_model.timeout,
            )
            reviewer_config = ModelProviderConfig(
                model=reviewer_identity, settings=reviewer_settings
            )
    except (ValidationError, ValueError) as error:
        raise operator_error("Wiki Run YAML configuration is invalid", error) from error
    return WikiRunRequest(
        operation=config.operation,
        repositories=tuple(repositories),
        skill=skill,
        model=ModelProviderConfig(model=model_identity, settings=model_settings),
        limits=limits,
        staging=_configured_path(root, config.staging),
        publication=_configured_path(root, config.publication),
        retain_analysis_workspace=config.retain_analysis_workspace,
        write_visualization=config.write_visualization,
        reviewer_model=reviewer_config,
    )
