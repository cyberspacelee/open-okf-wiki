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
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=320)
]
Locator = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
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


class ConceptFrontmatter(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)

    type: NonEmpty
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
    sources: list[EvidenceSource] = Field(default_factory=list)

    @field_validator("verified", mode="before")
    @classmethod
    def normalize_verified(cls, value):
        return [value] if isinstance(value, dict) else value


class SurveyTarget(BaseModel):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]*$")]
    source: NonEmpty
    scope: list[Locator] = Field(min_length=1, max_length=16)


class Inspection(BaseModel):
    source: NonEmpty
    survey_targets: list[SurveyTarget] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_targets(self):
        ids = [target.id for target in self.survey_targets]
        if len(ids) != len(set(ids)):
            raise ValueError("survey target ids must be unique")
        if any(target.source != self.source for target in self.survey_targets):
            raise ValueError("every survey target must belong to the inspection source")
        return self


class Finding(BaseModel):
    id: ShortText
    claim: ShortText
    evidence: list[Locator] = Field(min_length=1, max_length=4)
    domain: ShortText


class Survey(BaseModel):
    source: NonEmpty
    target: NonEmpty
    findings: list[Finding] = Field(max_length=16)
    gaps: list[ShortText] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def unique_findings(self):
        ids = [finding.id for finding in self.findings]
        if len(ids) != len(set(ids)):
            raise ValueError("finding ids must be unique within a survey")
        return self


class Connection(BaseModel):
    id: NonEmpty
    source_a: NonEmpty
    source_b: NonEmpty
    evidence_a: list[NonEmpty] = Field(min_length=1)
    evidence_b: list[NonEmpty] = Field(min_length=1)
    contract: NonEmpty
    failure_propagation: NonEmpty


class Synthesis(BaseModel):
    connections: list[Connection]
    gaps: list[NonEmpty] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_connections(self):
        ids = [connection.id for connection in self.connections]
        if len(ids) != len(set(ids)):
            raise ValueError("connection ids must be unique")
        return self


class PagePlanEntry(BaseModel):
    path: Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9/_.-]*\.md$")]
    type: NonEmpty
    owner: NonEmpty
    title: NonEmpty
    description: NonEmpty
    tags: list[NonEmpty] = Field(default_factory=list)
    finding_ids: list[NonEmpty] = Field(default_factory=list)
    connection_ids: list[NonEmpty] = Field(default_factory=list)

    @field_validator("path")
    @classmethod
    def portable_relative_path(cls, value: str) -> str:
        if ".." in value.split("/") or "//" in value:
            raise ValueError("path must be a normalized bundle-relative path")
        for part in value.split("/"):
            if (
                part.endswith((".", " "))
                or part.split(".", 1)[0].upper() in _WINDOWS_RESERVED
            ):
                raise ValueError("path must be portable to Windows")
        return value


class PageExclusion(BaseModel):
    finding_id: NonEmpty
    reason: NonEmpty


class PagePlan(BaseModel):
    pages: list[PagePlanEntry] = Field(min_length=2)
    exclusions: list[PageExclusion] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_pages(self):
        paths = [page.path for page in self.pages]
        if len(paths) != len(set(paths)):
            raise ValueError("page paths must be unique")
        return self


class ReviewIssue(BaseModel):
    category: Literal[
        "grep-test",
        "unsupported-claim",
        "invented-rationale",
        "padded-gap",
        "ownership",
        "routing",
        "coverage",
        "language",
    ]
    target: NonEmpty
    claim: NonEmpty
    resolution: NonEmpty
    reopen: Literal["page", "plan"] = "page"


class ReviewReport(BaseModel):
    candidate_digest: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    verdict: Literal["approved", "changes_requested"]
    issues: list[ReviewIssue] = Field(default_factory=list)

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
