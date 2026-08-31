import pathlib
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
ShortText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
]
ClaimText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=800)
]
PagePath = Annotated[
    str,
    StringConstraints(max_length=240, pattern=r"^[a-z0-9][a-z0-9/_.-]*\.md$"),
]
StableId = Annotated[
    str,
    StringConstraints(max_length=64, pattern=r"^[a-z0-9][a-z0-9.-]*$"),
]
ScopePath = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
]
PageType = Literal[
    "Overview",
    "Architecture",
    "Domain",
    "Procedure",
    "Flow",
    "Lifecycle",
    "DataModel",
    "Table",
]
DiagramKind = Literal["flowchart", "sequence", "state", "er"]
DiagramId = Annotated[
    str,
    StringConstraints(max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$"),
]
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class SearchPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    max_results: Annotated[int, Field(ge=1, le=100)]
    max_output_bytes: Annotated[int, Field(ge=4096, le=64 * 1024)]


class ReadPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    default_lines: Annotated[int, Field(ge=1, le=1000)]
    max_lines: Annotated[int, Field(ge=1, le=1000)]
    max_output_bytes: Annotated[int, Field(ge=4096, le=256 * 1024)]

    @model_validator(mode="after")
    def default_fits_maximum(self):
        if self.default_lines > self.max_lines:
            raise ValueError("default_lines must not exceed max_lines")
        return self


class EvidencePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    search: SearchPolicy
    read: ReadPolicy


class AgentPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    max_active_children: Annotated[int, Field(ge=1, le=16)]
    max_spawn_depth: Literal[1]
    max_children_per_run: Annotated[int, Field(ge=1, le=512)]


class RunPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    evidence: EvidencePolicy
    agents: AgentPolicy

    @classmethod
    def defaults(cls) -> "RunPolicy":
        return cls(
            evidence=EvidencePolicy(
                search=SearchPolicy(max_results=20, max_output_bytes=8 * 1024),
                read=ReadPolicy(
                    default_lines=40,
                    max_lines=200,
                    max_output_bytes=64 * 1024,
                ),
            ),
            agents=AgentPolicy(
                max_active_children=4,
                max_spawn_depth=1,
                max_children_per_run=128,
            ),
        )


class Generated(BaseModel):
    by: NonEmpty
    at: datetime


class Verification(BaseModel):
    by: NonEmpty
    at: datetime


class EvidenceSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    resource: NonEmpty
    title: NonEmpty | None = None
    author: NonEmpty | None = None
    usage_count: Annotated[int, Field(ge=0)] | None = None
    last_modified: date | None = None


class DiagramSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: DiagramId
    kind: DiagramKind
    question: ShortText
    sources: list[ShortText] = Field(min_length=1, max_length=16)

    @field_validator("sources")
    @classmethod
    def unique_sources(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("diagram sources must be unique")
        return values


def _check_diagram_contract(page_type: str, diagrams: list[DiagramSpec]) -> None:
    ids = [diagram.id for diagram in diagrams]
    if len(ids) != len(set(ids)):
        raise ValueError("diagram ids must be unique within a page")
    kinds = {diagram.kind for diagram in diagrams}
    required = {
        "Architecture": {"flowchart"},
        "Flow": {"flowchart", "sequence"},
        "Lifecycle": {"state"},
        "DataModel": {"er"},
    }
    if page_type in {"Overview", "Table"} and diagrams:
        raise ValueError(f"{page_type} pages must not plan diagrams")
    if page_type in required and not (kinds & required[page_type]):
        expected = " or ".join(sorted(required[page_type]))
        raise ValueError(f"{page_type} pages require a {expected} diagram")


class ConceptFrontmatter(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    type: PageType
    title: NonEmpty | None = None
    description: NonEmpty | None = None
    resource: NonEmpty | None = None
    tags: list[NonEmpty] = Field(default_factory=list)
    generated: Generated | None = None
    verified: list[Verification] = Field(default_factory=list)
    status: Literal["draft", "stable", "deprecated"] = "stable"
    stale_after: date | None = None
    coverage: Literal["full", "partial"] | None = None
    language: Literal["en", "zh"] | None = None
    diagrams: list[DiagramSpec] = Field(max_length=4)
    sources: list[EvidenceSource] = Field(default_factory=list)

    @field_validator("verified", mode="before")
    @classmethod
    def normalize_verified(cls, value):
        return [value] if isinstance(value, dict) else value

    @model_validator(mode="after")
    def diagrams_match_page_type(self):
        _check_diagram_contract(self.type, self.diagrams)
        return self


class DraftFrontmatter(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    coverage: Literal["full", "partial"]
    sources: list[EvidenceSource] = Field(max_length=64)


def _portable_page_path(value: str) -> str:
    if ".." in value.split("/") or "//" in value:
        raise ValueError("path must be a normalized bundle-relative path")
    for part in value.split("/"):
        if (
            part.endswith((".", " "))
            or part.split(".", 1)[0].upper() in _WINDOWS_RESERVED
        ):
            raise ValueError("path must be portable to Windows")
    return value


class PageScope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    role: Literal["owner", "producer", "contract", "consumer", "feedback"]
    paths: list[ScopePath] = Field(min_length=1, max_length=32)

    @field_validator("paths")
    @classmethod
    def normalized_relative_paths(cls, values: list[str]) -> list[str]:
        return _normalized_scope_paths(values)


def _normalized_scope_paths(values: list[str]) -> list[str]:
    for value in values:
        pure = pathlib.PurePosixPath(value)
        windows = pathlib.PureWindowsPath(value)
        if value != "." and (
            "\\" in value
            or pure.is_absolute()
            or bool(windows.drive)
            or ".." in pure.parts
            or pure.as_posix() != value
            or value.endswith("/")
            or value.startswith("./")
        ):
            raise ValueError("scope paths must be normalized relative POSIX paths")
    return values


class KnowledgeUnit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    kind: Literal[
        "capability",
        "lifecycle",
        "flow",
        "data-model",
        "integration",
        "operations",
    ]
    question: ClaimText
    scopes: list[PageScope] = Field(min_length=1, max_length=16)
    evidence_seeds: list[ScopePath] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def integration_and_scopes_are_unambiguous(self):
        sources = [scope.source for scope in self.scopes]
        if len(sources) != len(set(sources)):
            raise ValueError("each source must appear in exactly one scope per unit")
        if self.kind == "integration":
            roles = {scope.role for scope in self.scopes}
            if len(sources) < 2 or not {"producer", "consumer"} <= roles:
                raise ValueError(
                    "integration units require producer and consumer scopes from at least two sources"
                )
        return self


class UnitMergeProbe(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    unit_ids: list[StableId] = Field(min_length=2, max_length=8)
    decision: Literal["merge", "keep-separate"]
    rationale: ClaimText

    @field_validator("unit_ids")
    @classmethod
    def unique_unit_ids(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("merge probe unit ids must be unique")
        return values


class KnowledgePlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["knowledge-plan"]
    units: list[KnowledgeUnit] = Field(max_length=64)
    gaps: list[ClaimText] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def unique_units(self):
        ids = [item.id for item in self.units]
        if len(ids) != len(set(ids)):
            raise ValueError("knowledge unit ids must be unique")
        if not self.units and not self.gaps:
            raise ValueError("an empty knowledge plan must explain why in gaps")
        return self


class PlanReviewIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    status: Literal["open", "resolved"]
    category: Literal[
        "domain-coverage",
        "source-role",
        "lifecycle",
        "failure-path",
        "cross-source-contract",
        "grep-test",
        "gap",
        "routing",
    ]
    claim: ClaimText
    resolution: ClaimText
    unit_ids: list[StableId] = Field(default_factory=list, max_length=16)
    operation: Literal["repair", "split", "merge"] = "repair"

    @model_validator(mode="after")
    def structural_changes_name_units(self):
        if self.operation == "split" and len(self.unit_ids) != 1:
            raise ValueError("split issues require exactly one unit id")
        if self.operation == "merge" and len(self.unit_ids) < 2:
            raise ValueError("merge issues require at least two unit ids")
        return self


class PlanReviewReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    subject_digest: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    verdict: Literal["approved", "changes_requested"]
    merge_probes: list[UnitMergeProbe] = Field(max_length=64)
    issues: list[PlanReviewIssue] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def verdict_matches_issues(self):
        ids = [item.id for item in self.issues]
        if len(ids) != len(set(ids)):
            raise ValueError("plan review issue ids must be unique")
        open_issues = [item for item in self.issues if item.status == "open"]
        if self.verdict == "approved" and open_issues:
            raise ValueError("approved plan review must not contain open issues")
        if self.verdict == "changes_requested" and not open_issues:
            raise ValueError("changes_requested plan review must contain open issues")
        open_merges = {
            tuple(sorted(item.unit_ids))
            for item in open_issues
            if item.operation == "merge"
        }
        requested_merges = {
            tuple(sorted(probe.unit_ids))
            for probe in self.merge_probes
            if probe.decision == "merge"
        }
        if requested_merges != open_merges:
            raise ValueError("merge probes and open Plan merge issues must match")
        return self


class CompositionPage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    path: PagePath
    type: PageType
    title: ShortText
    description: ClaimText
    tags: list[ShortText] = Field(default_factory=list, max_length=16)
    units: list[StableId] = Field(min_length=1, max_length=32)
    merge_rationale: ClaimText | None = None
    diagrams: list[DiagramSpec] = Field(max_length=4)

    @field_validator("path", mode="after")
    @classmethod
    def portable_relative_path(cls, value: str) -> str:
        return _portable_page_path(value)

    @model_validator(mode="after")
    def diagrams_match_page_type(self):
        _check_diagram_contract(self.type, self.diagrams)
        if len(self.units) > 1 and self.merge_rationale is None:
            raise ValueError("multi-unit pages require a merge rationale")
        if len(self.units) == 1 and self.merge_rationale is not None:
            raise ValueError("single-unit pages must not declare a merge rationale")
        return self


class PageMergeProbe(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    page_ids: list[StableId] = Field(min_length=2, max_length=8)
    decision: Literal["merge", "keep-separate"]
    rationale: ClaimText

    @field_validator("page_ids")
    @classmethod
    def unique_page_ids(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("merge probe page ids must be unique")
        return values


class CompositionMap(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["composition-map"]
    pages: list[CompositionPage] = Field(max_length=64)
    gaps: list[ClaimText] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def unique_bindings(self):
        ids = [page.id for page in self.pages]
        paths = [page.path for page in self.pages]
        if len(ids) != len(set(ids)):
            raise ValueError("page ids must be unique")
        if len(paths) != len(set(paths)):
            raise ValueError("page paths must be unique")
        return self


class ReviewIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    status: Literal["open", "resolved"]
    category: Literal[
        "domain-coverage",
        "concept-boundary",
        "grep-test",
        "unsupported-claim",
        "invented-rationale",
        "padded-gap",
        "routing",
        "coverage",
        "language",
        "representation",
    ]
    claim: ClaimText
    resolution: ClaimText
    area: Literal["plan", "composition", "page"]
    page_ids: list[StableId] = Field(default_factory=list, max_length=16)
    operation: Literal["repair", "split", "merge", "move"] = "repair"

    @model_validator(mode="after")
    def structural_changes_belong_to_composition(self):
        if self.operation != "repair" and self.area != "composition":
            raise ValueError("split, merge and move issues belong to composition")
        if self.operation in {"split", "move"} and not self.page_ids:
            raise ValueError("split and move issues require at least one page id")
        if self.operation == "merge" and len(self.page_ids) < 2:
            raise ValueError("merge issues require at least two page ids")
        if self.area == "page" and not self.page_ids:
            raise ValueError("page issues require at least one page id")
        return self


class ReviewReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    subject_digest: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    verdict: Literal["approved", "changes_requested"]
    issues: list[ReviewIssue] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def verdict_matches_issues(self):
        ids = [item.id for item in self.issues]
        if len(ids) != len(set(ids)):
            raise ValueError("review issue ids must be unique")
        open_issues = [item for item in self.issues if item.status == "open"]
        if self.verdict == "approved" and open_issues:
            raise ValueError("approved review must not contain open issues")
        if self.verdict == "changes_requested" and not open_issues:
            raise ValueError("changes_requested review must contain open issues")
        return self


class CompositionReviewReport(ReviewReport):
    merge_probes: list[PageMergeProbe] = Field(max_length=64)

    @model_validator(mode="after")
    def merge_probes_match_open_issues(self):
        open_merges = {
            tuple(sorted(item.page_ids))
            for item in self.issues
            if item.status == "open" and item.operation == "merge"
        }
        requested_merges = {
            tuple(sorted(probe.page_ids))
            for probe in self.merge_probes
            if probe.decision == "merge"
        }
        if requested_merges != open_merges:
            raise ValueError(
                "merge probes and open Composition merge issues must match"
            )
        return self


def model_errors(exc: Exception) -> list[str]:
    errors = getattr(exc, "errors", None)
    if not callable(errors):
        return [str(exc)]
    result = []
    for issue in errors(include_url=False):
        loc = ".".join(str(part) for part in issue["loc"])
        result.append(f"{loc}: {issue['msg']}" if loc else issue["msg"])
    return result
