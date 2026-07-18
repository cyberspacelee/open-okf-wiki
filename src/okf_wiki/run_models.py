"""Domain types for Wiki Run."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)
from pydantic_ai import (
    ModelSettings,
    UnexpectedModelBehavior,
    UsageLimits,
)
from pydantic_ai.models import Model

from .errors import OkfWikiError
from .provider_env import (
    env_limit_overrides,
    merge_limit_overrides,
)


RepositoryId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, pattern=r"^[a-z][a-z0-9-]{0,62}$"),
]


def _validate_ignore_pattern(pattern: str) -> str:
    if (
        "\\" in pattern
        or "\x00" in pattern
        or pattern.startswith("/")
        or any(part in {"", ".", ".."} for part in pattern.split("/"))
    ):
        raise ValueError("ignore patterns must be repository-relative POSIX globs")
    return pattern


IgnorePattern = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=500),
    AfterValidator(_validate_ignore_pattern),
]

# Host-owned Default Source Ignores (noise). Tests are intentionally not listed.
DEFAULT_SOURCE_IGNORES: tuple[str, ...] = (
    "node_modules/**",
    ".venv/**",
    "venv/**",
    "env/**",
    "__pycache__/**",
    "dist/**",
    "build/**",
    "coverage/**",
    ".git/**",
    ".next/**",
    ".turbo/**",
    ".cache/**",
    ".parcel-cache/**",
    "vendor/**",
)


def resolve_effective_source_ignores(
    *,
    apply_default_source_ignores: bool,
    user_ignore: tuple[str, ...],
    frozen_effective_ignore: tuple[str, ...] | None = None,
) -> tuple[str, ...]:
    """Compute Effective Source Ignores for one repository.

    When ``frozen_effective_ignore`` is set (Manual Retry), that expanded list is
    authoritative and product defaults are not re-resolved.
    """
    if frozen_effective_ignore is not None:
        return tuple(frozen_effective_ignore)
    if apply_default_source_ignores:
        # Preserve catalog order, then append user patterns not already present.
        seen = set(DEFAULT_SOURCE_IGNORES)
        extra = tuple(pattern for pattern in user_ignore if pattern not in seen)
        return DEFAULT_SOURCE_IGNORES + extra
    return tuple(user_ignore)


def _validate_unique_repository_ids(ids: Iterable[str], message: str) -> None:
    values = tuple(ids)
    if len(values) != len(set(values)):
        raise ValueError(message)


class RepositorySnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: RepositoryId = "source"
    path: Path
    revision: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=1)]
    ignore: tuple[IgnorePattern, ...] = ()
    apply_default_source_ignores: bool = True
    # Manual Retry only: expanded Effective Source Ignores frozen at the earlier run.
    frozen_effective_ignore: tuple[IgnorePattern, ...] | None = None

    def effective_source_ignores(self) -> tuple[str, ...]:
        return resolve_effective_source_ignores(
            apply_default_source_ignores=self.apply_default_source_ignores,
            user_ignore=tuple(self.ignore),
            frozen_effective_ignore=(
                None
                if self.frozen_effective_ignore is None
                else tuple(self.frozen_effective_ignore)
            ),
        )


SkillDigest = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class ProducerSkillVersion(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: Path
    digest: SkillDigest

    @classmethod
    def default(cls) -> "ProducerSkillVersion":
        from .run_skill import (
            _DEFAULT_PRODUCER_SKILL,
            _DEFAULT_PRODUCER_SKILL_DIGEST,
            _selected_producer_skill,
        )

        version = cls(path=_DEFAULT_PRODUCER_SKILL, digest=_DEFAULT_PRODUCER_SKILL_DIGEST)
        return cls(path=_selected_producer_skill(version), digest=version.digest)

    @classmethod
    def from_directory(cls, path: Path) -> "ProducerSkillVersion":
        from .run_skill import _validate_producer_skill

        resolved, digest = _validate_producer_skill(path)
        return cls(path=resolved, digest=digest)


class ProducerSkillFork(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: Path

    @classmethod
    def create(cls, version: ProducerSkillVersion, destination: Path) -> "ProducerSkillFork":
        import shutil

        from .run_mounts import _overlaps
        from .run_skill import _selected_producer_skill

        source = _selected_producer_skill(version)
        target = destination.absolute()
        if _overlaps(source, target.resolve(strict=False)):
            raise ValueError("Skill Version and Skill Fork must not overlap")
        try:
            target.mkdir(parents=True, exist_ok=False)
        except FileExistsError as error:
            raise ValueError("Skill Fork destination must not already exist") from error
        try:
            shutil.copytree(source, target, dirs_exist_ok=True)
            fork = cls(path=target.resolve(strict=True))
            if fork.version().digest != version.digest:
                raise ValueError("Skill Fork does not match its selected Skill Version")
            return fork
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise

    def version(self) -> ProducerSkillVersion:
        return ProducerSkillVersion.from_directory(self.path)


class ModelProviderConfig(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    model: Model | str
    settings: ModelSettings = Field(default_factory=ModelSettings)


class WikiRunLimits(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    request_limit: int = Field(default=50, gt=0)
    tool_calls_limit: int = Field(default=200, gt=0)
    input_tokens_limit: int = Field(default=250_000, gt=0)
    output_tokens_limit: int = Field(default=100_000, gt=0)
    total_tokens_limit: int = Field(default=350_000, gt=0)
    retries: int = Field(default=2, ge=0)
    request_timeout_seconds: float = Field(default=120, gt=0)
    tool_timeout_seconds: float = Field(default=30, gt=0)
    wall_clock_timeout_seconds: float = Field(default=600, gt=0)
    source_files_limit: int = Field(default=50_000, gt=0)
    source_file_bytes_limit: int = Field(default=25_000_000, gt=0)
    source_total_bytes_limit: int = Field(default=500_000_000, gt=0)
    wiki_entries_limit: int = Field(default=2_000, gt=0)
    wiki_file_bytes_limit: int = Field(default=1_000_000, gt=0)
    wiki_total_bytes_limit: int = Field(default=50_000_000, gt=0)
    wiki_write_bytes_limit: int = Field(default=200_000_000, gt=0)
    analysis_receipt_bytes_limit: int = Field(default=128 * 1024, gt=0)
    analysis_artifact_bytes_limit: int = Field(default=2 * 1024 * 1024, gt=0)
    analysis_workspace_bytes_limit: int = Field(default=32 * 1024 * 1024, gt=0)
    analysis_workspace_entries_limit: int = Field(default=256, gt=0)
    context_target_tokens: int = Field(default=100_000, gt=0)
    adaptive_source_files_threshold: int = Field(default=128, gt=0)
    adaptive_source_bytes_threshold: int = Field(default=1_000_000, gt=0)
    adaptive_max_depth: int = Field(default=2, ge=0, le=2)
    adaptive_root_fanout: int = Field(default=2, ge=0, le=4)
    adaptive_domain_fanout: int = Field(default=2, ge=0, le=2)
    adaptive_child_concurrency: int = Field(default=4, gt=0, le=4)
    adaptive_child_timeout_seconds: float = Field(default=120, gt=0)
    adaptive_domain_request_limit: int = Field(default=6, gt=0)
    adaptive_leaf_request_limit: int = Field(default=3, gt=0)
    adaptive_domain_total_tokens_limit: int = Field(default=25_000, gt=0)
    adaptive_leaf_total_tokens_limit: int = Field(default=18_000, gt=0)
    adaptive_enable_reviewer: bool = True
    adaptive_reviewer_request_limit: int = Field(default=5, gt=0)
    adaptive_reviewer_total_tokens_limit: int = Field(default=30_000, gt=0)
    adaptive_leaf_timeout_seconds: float = Field(default=90, gt=0)
    adaptive_dynamic_workflow: bool = False

    @classmethod
    def build(cls, overrides: Mapping[str, object] | None = None) -> "WikiRunLimits":
        """Construct limits with precedence: field defaults < env < explicit overrides."""
        return cls(**merge_limit_overrides(env_limit_overrides(), overrides))

    def usage_limits(self) -> UsageLimits:
        return UsageLimits(
            request_limit=self.request_limit,
            tool_calls_limit=self.tool_calls_limit,
            input_tokens_limit=self.input_tokens_limit,
            output_tokens_limit=self.output_tokens_limit,
            total_tokens_limit=self.total_tokens_limit,
        )


PagePath = Annotated[str, StringConstraints(min_length=1, max_length=500)]
Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class WikiManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    pages: list[PagePath] = Field(min_length=1)


class WikiChangeSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    added: list[PagePath] = Field(default_factory=list)
    changed: list[PagePath] = Field(default_factory=list)
    removed: list[PagePath] = Field(default_factory=list)
    unchanged: list[PagePath] = Field(default_factory=list)
    content_changed: bool = False
    publication_changed: bool = False


class Complete(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["complete"] = "complete"
    manifest: WikiManifest
    summary: WikiChangeSummary = Field(default_factory=WikiChangeSummary)


class NeedsInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["needs_input"] = "needs_input"
    questions: list[Question] = Field(min_length=1, max_length=5)


type WikiRunResult = Complete | NeedsInput


class WikiRunEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]
    sequence: int = Field(gt=0)
    timestamp: datetime
    type: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    node_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = "root"
    payload: dict[str, object] = Field(default_factory=dict, max_length=32)


# Terminal Wiki Run Record statuses. `complete` means publication succeeded
# (or a documented successful no-op refresh). HITL publish adds awaiting/declined.
WikiRunRecordStatus = Literal[
    "complete",
    "needs_input",
    "failed",
    "cancelled",
    "awaiting_publication",
    "publication_declined",
]


class WikiRunRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1] = 1
    run_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]
    status: WikiRunRecordStatus
    operation: Literal["generate", "refresh"]
    repositories: list[dict[str, object]] = Field(min_length=1, max_length=64)
    skill: dict[str, str]
    model: dict[str, object]
    limits: dict[str, object]
    explicit_answers: dict[str, str] = Field(default_factory=dict)
    started_at: datetime
    completed_at: datetime
    duration_seconds: float = Field(ge=0)
    usage: dict[str, object] = Field(default_factory=dict)
    retry_counters: dict[str, int] = Field(default_factory=dict)
    publication: dict[str, object] = Field(default_factory=dict)
    failure_category: str | None = None


class WikiRunResourceLimitError(UnexpectedModelBehavior, OkfWikiError, ValueError):
    """A bounded Wiki Run stopped before it could produce a terminal result."""


class WikiRunRequest(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    operation: Literal["generate", "refresh"] = "generate"
    repositories: tuple[RepositorySnapshot, ...] = Field(min_length=1, max_length=64)
    skill: ProducerSkillVersion
    model: ModelProviderConfig
    limits: WikiRunLimits
    staging: Path
    publication: Path
    retain_analysis_workspace: bool = False
    write_visualization: bool = False
    # YOLO / non-interactive explicit yes: auto-approve deferred publication only.
    # Does not skip Host validation, mounts, or publication locks. Off by default.
    auto_approve_publication: bool = False
    # Optional separate Wiki Reviewer model identity; falls back to ``model`` when unset.
    reviewer_model: ModelProviderConfig | None = None
    explicit_answers: dict[str, str] = Field(default_factory=dict)
    prior_run_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")] | None = None

    @model_validator(mode="after")
    def validate_repository_ids(self) -> "WikiRunRequest":
        _validate_unique_repository_ids(
            (repository.id for repository in self.repositories),
            "Repository Snapshot IDs must be unique",
        )
        return self

    @classmethod
    def from_yaml(cls, path: Path) -> "WikiRunRequest":
        from .run_config import _wiki_run_request_from_yaml

        return _wiki_run_request_from_yaml(path)

    @classmethod
    def from_run_record(
        cls,
        record: WikiRunRecord | Path | Mapping[str, object],
        *,
        staging: Path,
        publication: Path,
        model: Model | str | None = None,
        explicit_answers: Mapping[str, str] | None = None,
        retain_analysis_workspace: bool = False,
    ) -> "WikiRunRequest":
        """Build a Manual Retry Run from an immutable failed/cancelled run record."""
        from .run_records import _manual_retry_request

        return _manual_retry_request(
            record,
            staging=staging,
            publication=publication,
            model=model,
            explicit_answers=explicit_answers,
            retain_analysis_workspace=retain_analysis_workspace,
        )
