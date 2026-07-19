"""Run Boundary package: Wiki Run orchestration, mounts, publication, and security.

Public API is re-exported here for ``from okf_wiki.run import ...`` call sites.
"""

from __future__ import annotations

from .adaptive import (
    AdaptiveOrchestrator,
    AdaptivePolicy,
    CriticalBranchesIncomplete,
    WikiReviewer,
    ReviewDefectsSummary,
    RootAssembly,
    build_root_agent,
    build_root_assembly,
    run_wiki_reviewer,
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
    RunValidationError,
    OkfWikiError,
    PublicationError,
    WikiRunResourceLimitError,
    operator_error,
)
from .lifecycle import WikiRunApplication
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
from .publication.accept import StagingChangeAssessment, assess_staging_changes
from .publication.finalize import (
    PublicationContext,
    PublicationOutcome,
    StagingReviewer,
    finalize,
)
from .publication.gate import (
    PublicationApprovalHandler,
    build_approve_results,
    build_deny_results,
    build_publish_approval_request,
    decision_from_results,
    resolve_publication_approval,
)
from .events import exception_chain, safe_model_error, sanitize_event_payload
from .filesystem import (
    check_directory_path,
    create_directory_path,
    write_bytes_atomically,
)
from .readiness import RunReadiness, open_run_readiness
from .records import load_run_record, record_publication_path, write_run_record
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
    "CriticalBranchesIncomplete",
    "DEFAULT_SOURCE_IGNORES",
    "HandoffRef",
    "RunReadiness",
    "RunValidationError",
    "WikiReviewer",
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
    "PublicationContext",
    "PublicationError",
    "PublicationOutcome",
    "REDACTION",
    "ReceiptArtifact",
    "ReceiptEvidence",
    "RepositorySnapshot",
    "ReviewDefectsSummary",
    "RootAssembly",
    "StagingChangeAssessment",
    "StagingReviewer",
    "WikiChangeSummary",
    "WikiManifest",
    "WikiRunApplication",
    "WikiRunEvent",
    "WikiRunLimits",
    "WikiRunRecord",
    "WikiRunRequest",
    "WikiRunResourceLimitError",
    "WikiRunResult",
    "assess_staging_changes",
    "build_approve_results",
    "build_context_capabilities",
    "build_deny_results",
    "build_publish_approval_request",
    "build_root_agent",
    "build_root_assembly",
    "check_directory_path",
    "create_directory_path",
    "decision_from_results",
    "environment_secrets",
    "exception_chain",
    "finalize",
    "git_read",
    "git_read_bytes",
    "load_run_record",
    "open_run_readiness",
    "operator_error",
    "prepare_model_with_provider_retry",
    "prepare_mounts",
    "prepare_run",
    "record_publication_path",
    "redact_secrets",
    "resolve_effective_source_ignores",
    "resolve_model_identity",
    "resolve_model_settings",
    "resolve_publication_approval",
    "run_wiki_reviewer",
    "safe_error_message",
    "safe_model_error",
    "sanitize_event_payload",
    "should_enable_adaptive",
    "write_bytes_atomically",
    "write_run_record",
]
