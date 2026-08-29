import pathlib
import re
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
ScopePath = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
]
SourceRole = Literal[
    "business-domain-owner",
    "public-contract",
    "shared-infrastructure",
    "extension-surface",
    "evidence-only-dependency",
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


class SourceConcept(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: ShortText
    description: ClaimText
    paths: list[ScopePath] = Field(min_length=1, max_length=16)
    evidence_seeds: list[ScopePath] = Field(min_length=1, max_length=3)

    @field_validator("paths", mode="after")
    @classmethod
    def normalized_relative_paths(cls, values: list[str]) -> list[str]:
        return _normalized_scope_paths(values)


class SourceConnection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: ShortText
    description: ClaimText
    evidence_seeds: list[ScopePath] = Field(min_length=1, max_length=3)
    counterpart_sources: list[ShortText] = Field(min_length=1, max_length=8)
    counterpart_queries: list[ShortText] = Field(min_length=1, max_length=8)


class SourceBrief(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    roles: list[SourceRole] = Field(min_length=1, max_length=5)
    concepts: list[SourceConcept] = Field(default_factory=list, max_length=32)
    connections: list[SourceConnection] = Field(default_factory=list, max_length=32)
    gaps: list[ClaimText] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def unique_items(self):
        if len(self.roles) != len(set(self.roles)):
            raise ValueError("source roles must be unique")
        for label, values in (
            ("concept", [item.name for item in self.concepts]),
            ("connection", [item.name for item in self.connections]),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"{label} names must be unique")
        return self


class PagePlanEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    path: PagePath
    type: ShortText
    owner: ShortText
    title: ShortText
    description: ClaimText
    tags: list[ShortText] = Field(default_factory=list, max_length=16)
    scopes: list[PageScope] = Field(min_length=1, max_length=16)
    evidence_seeds: list[ScopePath] = Field(max_length=3)
    depends_on: list[PagePath] = Field(default_factory=list, max_length=64)

    @field_validator("path", mode="after")
    @classmethod
    def portable_relative_path(cls, value: str) -> str:
        return _portable_page_path(value)

    @field_validator("depends_on", mode="after")
    @classmethod
    def portable_dependencies(cls, values: list[str]) -> list[str]:
        return [_portable_page_path(value) for value in values]


class PagePlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    pages: list[PagePlanEntry] = Field(min_length=1, max_length=64)
    gaps: list[ClaimText] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def valid_dependency_graph(self):
        paths = [page.path for page in self.pages]
        if len(paths) != len(set(paths)):
            raise ValueError("page paths must be unique")
        known = set(paths)
        graph = {page.path: page.depends_on for page in self.pages}
        for page, dependencies in graph.items():
            unknown = set(dependencies) - known
            if unknown:
                raise ValueError(
                    f"page dependencies must name planned pages: {sorted(unknown)}"
                )
            if page in dependencies:
                raise ValueError(f"page must not depend on itself: {page}")

        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(page: str) -> None:
            if page in visiting:
                raise ValueError("page dependencies must not contain a cycle")
            if page in visited:
                return
            visiting.add(page)
            for dependency in graph[page]:
                visit(dependency)
            visiting.remove(page)
            visited.add(page)

        for page in paths:
            visit(page)
        return self


class ReviewIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    category: Literal[
        "domain-coverage",
        "concept-boundary",
        "dependency",
        "grep-test",
        "unsupported-claim",
        "invented-rationale",
        "padded-gap",
        "ownership",
        "routing",
        "coverage",
        "language",
    ]
    claim: ClaimText
    resolution: ClaimText
    reopen_target: NonEmpty


class ReviewReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    subject: NonEmpty
    subject_digest: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    verdict: Literal["approved", "changes_requested"]
    issues: list[ReviewIssue] = Field(default_factory=list, max_length=64)

    @field_validator("subject", mode="after")
    @classmethod
    def valid_subject(cls, value: str) -> str:
        if value == "plan:workspace":
            return value
        kind, separator, path = value.partition(":")
        if kind != "page" or not separator:
            raise ValueError("subject must be plan:workspace or page:<path>")
        _portable_page_path(path)
        return value

    @model_validator(mode="after")
    def verdict_matches_issues(self):
        if self.verdict == "approved" and self.issues:
            raise ValueError("approved review must not contain issues")
        if self.verdict == "changes_requested" and not self.issues:
            raise ValueError("changes_requested review must contain issues")
        if self.subject == "plan:workspace":
            invalid = any(
                not re.fullmatch(
                    r"plan:(workspace|[A-Za-z0-9][A-Za-z0-9-]*)", issue.reopen_target
                )
                for issue in self.issues
            )
        else:
            invalid = any(
                issue.reopen_target not in {"plan:workspace", self.subject}
                for issue in self.issues
            )
        if invalid:
            raise ValueError("review issue reopens an invalid target")
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
