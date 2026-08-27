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
ShortId = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
]
ClaimText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=800)
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


class Finding(BaseModel):
    id: ShortId
    claim: ClaimText
    evidence: list[Locator] = Field(min_length=1, max_length=8)
    domain: ShortId


class TriageScope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    paths: list[NonEmpty] = Field(min_length=1, max_length=64)
    tier: Literal["deep", "standard", "inventory"]
    orientation: ClaimText | None = None
    themes: list[ShortId] = Field(default_factory=list, max_length=8)
    reason: ClaimText | None = None
    samples: list[Locator] = Field(default_factory=list, max_length=3)


class Triage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: NonEmpty
    scopes: list[TriageScope] = Field(max_length=256)


class Survey(BaseModel):
    source: NonEmpty
    target: NonEmpty
    findings: list[Finding] = Field(max_length=32)
    gaps: list[ClaimText] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def unique_findings(self):
        ids = [finding.id for finding in self.findings]
        if len(ids) != len(set(ids)):
            raise ValueError("finding ids must be unique within a survey")
        return self


class Participant(BaseModel):
    source: NonEmpty
    evidence: list[Locator] = Field(min_length=1, max_length=8)


class Connection(BaseModel):
    id: NonEmpty
    participants: list[Participant] = Field(min_length=2)
    contract: NonEmpty
    contract_evidence: list[Locator] = Field(default_factory=list)
    failure_propagation: NonEmpty

    @model_validator(mode="after")
    def unique_participants(self):
        names = [item.source for item in self.participants]
        if len(names) != len(set(names)):
            raise ValueError("participant sources must be unique")
        return self


class Connect(BaseModel):
    source: NonEmpty
    connections: list[Connection]
    gaps: list[NonEmpty] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def unique_connections(self):
        ids = [item.id for item in self.connections]
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
    source: NonEmpty | None = None
    pages: list[PagePlanEntry] = Field(default_factory=list)
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
    batch: NonEmpty
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
