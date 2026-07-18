"""Host package: Wiki Run orchestration, mounts, publication, and security.

Public API is re-exported here for ``from okf_wiki.host import ...`` call sites.
"""

from __future__ import annotations

from .adaptive import (
    AdaptiveOrchestrator,
    AdaptivePolicy,
    ReviewDefectsSummary,
    build_root_agent,
    run_host_wiki_reviewer,
    should_enable_adaptive,
)
from .analysis.workspace import (
    AnalysisReceipt,
    AnalysisWorkspace,
    ArtifactSlice,
    HandoffRef,
    ReceiptArtifact,
    ReceiptEvidence,
)
from .context import (
    ObservableTieredCompaction,
    build_context_capabilities,
)
from .errors import (
    ConfigError,
    HostValidationError,
    OkfWikiError,
    PublicationError,
    WikiRunResourceLimitError,
    operator_error,
)
from .lifecycle import RunLifecycle, WikiRunApplication
from .prepare import PreparedMounts, PreparedRun, prepare_mounts, prepare_run
from .models import (
    DEFAULT_SOURCE_IGNORES,
    Complete,
    ModelProviderConfig,
    NeedsInput,
    ProducerSkillFork,
    ProducerSkillVersion,
    RepositorySnapshot,
    WikiChangeSummary,
    WikiManifest,
    WikiRunEvent,
    WikiRunLimits,
    WikiRunRecord,
    WikiRunRequest,
    WikiRunResult,
    resolve_effective_source_ignores,
)
from .provider.env import (
    resolve_model_identity,
    resolve_model_settings,
)
from .provider.retry import (
    ProviderRetryState,
    prepare_model_with_provider_retry,
)
from .publication.finalize import PublicationOutcome, finalize
from .publication.gate import (
    PublicationApprovalHandler,
    build_approve_results,
    build_deny_results,
    build_publish_approval_request,
    decision_from_results,
    resolve_publication_approval,
)
from .records import load_run_record
from .security import (
    MAX_ANALYZABLE_FILE_BYTES,
    REDACTION,
    environment_secrets,
    git_read,
    git_read_bytes,
    redact_secrets,
    safe_error_message,
)

__all__ = [
    "AdaptiveOrchestrator",
    "AdaptivePolicy",
    "AnalysisReceipt",
    "AnalysisWorkspace",
    "ArtifactSlice",
    "Complete",
    "ConfigError",
    "DEFAULT_SOURCE_IGNORES",
    "HandoffRef",
    "HostValidationError",
    "MAX_ANALYZABLE_FILE_BYTES",
    "ModelProviderConfig",
    "NeedsInput",
    "ObservableTieredCompaction",
    "OkfWikiError",
    "PreparedMounts",
    "PreparedRun",
    "ProducerSkillFork",
    "ProducerSkillVersion",
    "ProviderRetryState",
    "PublicationApprovalHandler",
    "PublicationError",
    "PublicationOutcome",
    "REDACTION",
    "ReceiptArtifact",
    "ReceiptEvidence",
    "RepositorySnapshot",
    "ReviewDefectsSummary",
    "RunLifecycle",
    "WikiChangeSummary",
    "WikiManifest",
    "WikiRunApplication",
    "WikiRunEvent",
    "WikiRunLimits",
    "WikiRunRecord",
    "WikiRunRequest",
    "WikiRunResourceLimitError",
    "WikiRunResult",
    "build_approve_results",
    "build_context_capabilities",
    "build_deny_results",
    "build_publish_approval_request",
    "build_root_agent",
    "decision_from_results",
    "environment_secrets",
    "finalize",
    "git_read",
    "git_read_bytes",
    "load_run_record",
    "operator_error",
    "prepare_model_with_provider_retry",
    "prepare_mounts",
    "prepare_run",
    "redact_secrets",
    "resolve_effective_source_ignores",
    "resolve_model_identity",
    "resolve_model_settings",
    "resolve_publication_approval",
    "run_host_wiki_reviewer",
    "safe_error_message",
    "should_enable_adaptive",
]
