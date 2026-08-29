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


class Generated(BaseModel):
    by: NonEmpty
    at: datetime


class Verification(BaseModel):
    by: NonEmpty
    at: datetime


class EvidenceSource(BaseModel):
    id: NonEmpty | None = None
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
    model_config = ConfigDict(extra="allow", strict=True)

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
    evidence_seeds: list[ScopePath] = Field(min_length=1, max_length=3)


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


class CompositionPage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    path: PagePath
    type: PageType
    title: ShortText
    description: ClaimText
    tags: list[ShortText] = Field(default_factory=list, max_length=16)
    units: list[StableId] = Field(min_length=1, max_length=32)
    diagrams: list[DiagramSpec] = Field(max_length=4)

    @field_validator("path", mode="after")
    @classmethod
    def portable_relative_path(cls, value: str) -> str:
        return _portable_page_path(value)

    @model_validator(mode="after")
    def diagrams_match_page_type(self):
        _check_diagram_contract(self.type, self.diagrams)
        return self


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
        if self.verdict == "approved" and self.issues:
            raise ValueError("approved review must not contain issues")
        if self.verdict == "changes_requested" and not self.issues:
            raise ValueError("changes_requested review must contain issues")
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
