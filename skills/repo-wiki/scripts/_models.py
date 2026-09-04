import hashlib
import pathlib
from datetime import date, datetime
from typing import Annotated, Literal
from urllib.parse import quote, unquote

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
ReferencePath = Annotated[
    str,
    StringConstraints(max_length=230, pattern=r"^[a-z0-9](?:[a-z0-9/_.-]*[a-z0-9_])?$"),
]
StableId = Annotated[
    str,
    StringConstraints(max_length=64, pattern=r"^[a-z0-9][a-z0-9.-]*$"),
]
Digest = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
ScopePath = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
]
PageType = Literal[
    "Overview",
    "Architecture",
    "Domain",
    "Concept",
    "Procedure",
    "Flow",
    "Lifecycle",
    "DataModel",
    "Schema",
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
                search=SearchPolicy(max_results=100, max_output_bytes=64 * 1024),
                read=ReadPolicy(
                    default_lines=200,
                    max_lines=1000,
                    max_output_bytes=256 * 1024,
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
    }
    if page_type in {"Overview", "Schema", "Table"} and diagrams:
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


class PlanNarrative(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["knowledge-plan-narrative"]
    intent: Literal["plan-intent.json"]
    ledger: Literal["plan-ledger.json"]


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
    roles: list[
        Literal["owner", "producer", "contract", "consumer", "feedback", "model"]
    ] = Field(min_length=1, max_length=6)
    paths: list[ScopePath] = Field(min_length=1, max_length=32)

    @field_validator("paths")
    @classmethod
    def normalized_relative_paths(cls, values: list[str]) -> list[str]:
        return _normalized_scope_paths(values)

    @field_validator("roles")
    @classmethod
    def unique_roles(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("scope roles must be unique")
        return values


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
    domain_ids: list[StableId] = Field(min_length=1)
    concept_ids: list[StableId]
    scopes: list[PageScope] = Field(min_length=1, max_length=16)
    evidence_seeds: list[ScopePath] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def integration_and_scopes_are_unambiguous(self):
        sources = [scope.source for scope in self.scopes]
        if len(sources) != len(set(sources)):
            raise ValueError("each source must appear in exactly one scope per unit")
        if self.kind == "integration":
            roles = {role for scope in self.scopes for role in scope.roles}
            if len(sources) < 2 or not {"producer", "consumer"} <= roles:
                raise ValueError(
                    "integration units require producer and consumer scopes from at least two sources"
                )
        return self


class UnitMergeProbe(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    unit_ids: list[StableId] = Field(min_length=2)
    decision: Literal["merge", "keep-separate"]
    rationale: ClaimText

    @field_validator("unit_ids")
    @classmethod
    def unique_unit_ids(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("merge probe unit ids must be unique")
        return values


class KnowledgeGap(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    category: Literal[
        "catalog-selection",
        "source-coverage",
        "model-coverage",
        "relationship-confidence",
        "other",
    ]
    claim: ClaimText
    evidence: list[ScopePath]


class SourceArea(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    source: ShortText
    paths: list[ScopePath] = Field(min_length=1)
    disposition: Literal["domain", "shared", "test", "generated", "excluded"]
    domain_ids: list[StableId]

    @field_validator("paths")
    @classmethod
    def normalized_relative_paths(cls, values: list[str]) -> list[str]:
        return _normalized_scope_paths(values)

    @model_validator(mode="after")
    def domain_disposition_names_a_domain(self):
        if self.disposition == "domain" and not self.domain_ids:
            raise ValueError("domain source areas require at least one domain id")
        return self


class Domain(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    name: ShortText
    definition: ClaimText
    owner_unit_id: StableId


class CatalogTableRef(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    table: NonEmpty


class ConceptModelBasis(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    basis: Literal["opengauss", "code", "none"]
    coverage: Literal["full", "partial"] = "full"
    catalog_tables: list[CatalogTableRef] = Field(default_factory=list)
    structure_evidence: list[ScopePath] = Field(default_factory=list)
    gap_ids: list[StableId] = Field(default_factory=list)

    @model_validator(mode="after")
    def evidence_matches_basis(self):
        if self.coverage == "partial" and not self.gap_ids:
            raise ValueError("partial model coverage requires at least one gap id")
        if self.coverage == "full" and self.gap_ids:
            raise ValueError("full model coverage must not reference gaps")
        if self.basis == "opengauss":
            if not self.catalog_tables:
                raise ValueError("opengauss model basis requires catalog tables")
            if self.structure_evidence:
                raise ValueError("opengauss structure comes from catalog_tables")
        elif self.basis == "code":
            if self.catalog_tables:
                raise ValueError("code model basis must not reference catalog tables")
            if not self.structure_evidence:
                raise ValueError("code model basis requires structure evidence")
        elif (
            self.coverage != "full"
            or self.gap_ids
            or self.catalog_tables
            or self.structure_evidence
        ):
            raise ValueError(
                "none model basis must be full and carry no structure resources or gaps"
            )
        return self


class IntentModelBasis(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    basis: Literal["opengauss", "code", "none"]
    coverage: Literal["full", "partial"] = "full"
    structure_evidence: list[ScopePath] = Field(default_factory=list)
    gap_ids: list[StableId] = Field(default_factory=list)


class IntentConcept(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    domain_id: StableId
    kind: Literal[
        "entity",
        "value-object",
        "event",
        "service",
        "policy",
        "process",
        "read-model",
    ]
    name: ShortText
    definition: ClaimText
    owner_unit_id: StableId
    model_basis: IntentModelBasis


class PlanParticipant(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    roles: list[
        Literal["owner", "producer", "contract", "consumer", "feedback", "model"]
    ] = Field(min_length=1, max_length=6)
    paths: list[ScopePath] = Field(min_length=1, max_length=32)
    evidence: list[ScopePath] = Field(default_factory=list, max_length=16)

    @field_validator("paths")
    @classmethod
    def normalized_relative_paths(cls, values: list[str]) -> list[str]:
        return _normalized_scope_paths(values)


class IntentKnowledgeUnit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    kind: Literal["capability", "lifecycle", "flow", "integration", "operations"]
    question: ClaimText
    domain_ids: list[StableId] = Field(min_length=1)
    concept_ids: list[StableId]
    participants: list[PlanParticipant] = Field(min_length=1, max_length=16)


def model_unit_id(concept_id: str) -> str:
    candidate = f"model.{concept_id}"
    if len(candidate) <= 64:
        return candidate
    digest = hashlib.sha256(concept_id.encode()).hexdigest()[:10]
    return f"model.{concept_id[:47].rstrip('.-')}.{digest}"


class DomainConcept(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    domain_id: StableId
    kind: Literal[
        "entity",
        "value-object",
        "event",
        "service",
        "policy",
        "process",
        "read-model",
    ]
    name: ShortText
    definition: ClaimText
    owner_unit_id: StableId
    model_basis: ConceptModelBasis

    @property
    def model_unit_id(self) -> str | None:
        if self.model_basis.basis == "none":
            return None
        return model_unit_id(self.id)


TableRole = Literal[
    "entity",
    "association",
    "history",
    "reference",
    "read-model",
    "working",
    "infrastructure",
    "replica",
    "excluded",
    "unresolved",
]


class CatalogGroup(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    role: TableRole
    tables: list[NonEmpty] = Field(min_length=1)
    domain_id: StableId | None = None
    concept_ids: list[StableId] = Field(default_factory=list)
    evidence: list[ScopePath] = Field(default_factory=list)
    gap_ids: list[StableId] = Field(default_factory=list)


class TableGroup(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    role: TableRole
    tables: list[NonEmpty] = Field(min_length=1)
    domain_id: StableId | None = None
    evidence: list[ScopePath] = Field(default_factory=list)
    gap_ids: list[StableId] = Field(default_factory=list)

    @model_validator(mode="after")
    def role_has_required_context(self):
        if len(self.tables) != len(set(self.tables)):
            raise ValueError("table names must be unique within a group")
        if self.role == "unresolved" and not self.gap_ids:
            raise ValueError("unresolved table groups require at least one gap id")
        if self.role != "unresolved" and self.gap_ids:
            raise ValueError("gap_ids are only valid for unresolved table groups")
        if self.role == "excluded" and not self.evidence:
            raise ValueError("excluded table groups require classification evidence")
        return self


class TableReplica(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    table: CatalogTableRef
    replica_of: CatalogTableRef
    evidence: list[ScopePath] = Field(min_length=1)

    @model_validator(mode="after")
    def target_is_distinct(self):
        if self.table == self.replica_of:
            raise ValueError("replica_of must reference another catalog table")
        return self


class TableDisposition(BaseModel):
    """Expanded in-memory table classification; never authored in Plan YAML."""

    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    table: NonEmpty
    role: TableRole
    domain_id: StableId | None = None
    concept_ids: list[StableId]
    evidence: list[ScopePath] = Field(default_factory=list)
    gap_ids: list[StableId] = Field(default_factory=list)
    replica_of: CatalogTableRef | None = None


class DomainRelationship(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    from_concept_id: StableId
    to_concept_id: StableId
    level: Literal["declared", "mapped", "observed", "heuristic"]
    cardinality: Literal[
        "one-to-one", "one-to-many", "many-to-one", "many-to-many", "unknown"
    ]
    evidence: list[ScopePath] = Field(min_length=1)
    include_in_er: bool

    @model_validator(mode="after")
    def heuristics_are_not_formal_model_edges(self):
        if self.level == "heuristic" and self.include_in_er:
            raise ValueError("heuristic relationships must not appear in ER diagrams")
        return self


class KnowledgePlanIntent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["knowledge-plan-intent"]
    source_areas: list[SourceArea] = Field(min_length=1)
    domains: list[Domain] = Field(min_length=1)
    concepts: list[IntentConcept] = Field(min_length=1)
    catalog_groups: list[CatalogGroup] = Field(default_factory=list)
    table_replicas: list[TableReplica] = Field(default_factory=list)
    relationships: list[DomainRelationship] = Field(default_factory=list)
    units: list[IntentKnowledgeUnit] = Field(min_length=1)
    gaps: list[KnowledgeGap] = Field(default_factory=list)


class KnowledgePlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["knowledge-plan-ledger"]
    intent_digest: Digest
    source_areas: list[SourceArea] = Field(min_length=1)
    domains: list[Domain] = Field(min_length=1)
    concepts: list[DomainConcept] = Field(min_length=1)
    table_groups: list[TableGroup] = Field(default_factory=list)
    table_replicas: list[TableReplica] = Field(default_factory=list)
    relationships: list[DomainRelationship] = Field(default_factory=list)
    units: list[KnowledgeUnit] = Field(min_length=1)
    gaps: list[KnowledgeGap] = Field(default_factory=list)

    @property
    def effective_units(self) -> list[KnowledgeUnit]:
        return [
            *self.units,
            *(
                self._model_unit(concept)
                for concept in self.concepts
                if concept.model_unit_id
            ),
        ]

    def _model_unit(self, concept: DomainConcept) -> KnowledgeUnit:
        scopes: dict[str, list[str]] = {}
        if concept.model_basis.basis == "opengauss":
            evidence = [
                f"{table.source}/{quote(table.table, safe='')}"
                for table in concept.model_basis.catalog_tables
            ]
            for table in concept.model_basis.catalog_tables:
                scopes.setdefault(table.source, []).append(table.table)
        else:
            evidence = list(concept.model_basis.structure_evidence)
        evidence.extend(
            resource
            for relationship in self.relationships
            if concept.id in (relationship.from_concept_id, relationship.to_concept_id)
            for resource in relationship.evidence
        )
        catalog_scopes = {
            (table.source, table.table) for table in concept.model_basis.catalog_tables
        }
        for resource in evidence:
            source, separator, path = resource.partition("/")
            if not separator:
                continue
            relative = unquote(path.split("#", 1)[0])
            if (source, relative) not in catalog_scopes:
                scopes.setdefault(source, []).append(relative)
        return KnowledgeUnit(
            id=concept.model_unit_id,
            kind="data-model",
            question=f"How is {concept.name} represented, persisted, and related?",
            domain_ids=[concept.domain_id],
            concept_ids=[concept.id],
            scopes=[
                PageScope(
                    source=source,
                    roles=["model"],
                    paths=list(dict.fromkeys(paths)),
                )
                for source, paths in scopes.items()
            ],
            evidence_seeds=list(dict.fromkeys(evidence)),
        )

    @property
    def table_dispositions(self) -> list[TableDisposition]:
        concept_ids: dict[tuple[str, str], list[str]] = {}
        for concept in self.concepts:
            for table in concept.model_basis.catalog_tables:
                concept_ids.setdefault((table.source, table.table), []).append(
                    concept.id
                )
        replicas = {
            (item.table.source, item.table.table): item for item in self.table_replicas
        }
        return [
            TableDisposition(
                source=group.source,
                table=table,
                role=group.role,
                domain_id=group.domain_id,
                concept_ids=concept_ids.get((group.source, table), []),
                evidence=(
                    [*group.evidence, *replicas[(group.source, table)].evidence]
                    if (group.source, table) in replicas
                    else group.evidence
                ),
                gap_ids=group.gap_ids,
                replica_of=(
                    replicas[(group.source, table)].replica_of
                    if (group.source, table) in replicas
                    else None
                ),
            )
            for group in self.table_groups
            for table in group.tables
        ]


class PlanReviewIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    status: Literal["open", "resolved"]
    category: Literal[
        "domain-coverage",
        "concept-coverage",
        "model-basis",
        "table-disposition",
        "relationship-confidence",
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
    merge_probes: list[UnitMergeProbe]
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
    units: list[StableId] = Field(min_length=1)
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

    page_ids: list[StableId] = Field(min_length=2)
    decision: Literal["merge", "keep-separate"]
    rationale: ClaimText

    @field_validator("page_ids")
    @classmethod
    def unique_page_ids(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("merge probe page ids must be unique")
        return values


class ReferenceRoot(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: ShortText
    path: ReferencePath

    @field_validator("path")
    @classmethod
    def normalized_directory_path(cls, value: str) -> str:
        _normalized_scope_paths([value])
        _portable_page_path(value + "/page.md")
        if any(part.endswith(".md") for part in value.split("/")):
            raise ValueError("reference root must be a named bundle directory")
        return value


class CompositionMap(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["composition-map"]
    reference_roots: list[ReferenceRoot]
    pages: list[CompositionPage]
    gaps: list[ClaimText] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def unique_bindings(self):
        ids = [page.id for page in self.pages]
        paths = [page.path for page in self.pages]
        if len(ids) != len(set(ids)):
            raise ValueError("page ids must be unique")
        if len(paths) != len(set(paths)):
            raise ValueError("page paths must be unique")
        root_sources = [item.source for item in self.reference_roots]
        if len(root_sources) != len(set(root_sources)):
            raise ValueError("each source must have exactly one reference root")
        root_paths = [item.path for item in self.reference_roots]
        if len(root_paths) != len(set(root_paths)):
            raise ValueError("reference root paths must be unique")
        return self


class ReviewIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: StableId
    status: Literal["open", "resolved"]
    category: Literal[
        "domain-coverage",
        "concept-boundary",
        "model-basis",
        "table-disposition",
        "relationship-confidence",
        "reference-coverage",
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
    merge_probes: list[PageMergeProbe]

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
