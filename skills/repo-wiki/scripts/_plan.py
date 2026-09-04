import hashlib
import json
from dataclasses import dataclass
from urllib.parse import quote

from pydantic import ValidationError

from _models import (
    CatalogTableRef,
    ConceptModelBasis,
    DomainConcept,
    KnowledgePlan,
    KnowledgePlanIntent,
    KnowledgeUnit,
    PageScope,
    TableGroup,
    model_unit_id,
    model_errors,
)


@dataclass(frozen=True)
class PlanDiagnostic:
    code: str
    category: str
    pointer: str
    message: str
    actual: str
    suggestion: str


@dataclass(frozen=True)
class CompileResult:
    plan: KnowledgePlan | None
    diagnostics: list[PlanDiagnostic]


def intent_digest(intent: KnowledgePlanIntent) -> str:
    payload = json.dumps(
        intent.model_dump(mode="json", exclude_defaults=True),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def normalize_participants(participants, catalog_sources: set[str]):
    grouped: dict[str, dict[str, list[str]]] = {}
    for participant in participants:
        target = grouped.setdefault(
            participant.source, {"roles": [], "paths": [], "evidence": []}
        )
        target["roles"].extend(participant.roles)
        target["paths"].extend(participant.paths)
        target["evidence"].extend(participant.evidence)
        if participant.source in catalog_sources and not participant.evidence:
            target["evidence"].extend(
                f"{participant.source}/{'.' if path == '.' else quote(path, safe='')}"
                for path in participant.paths
            )
    scopes = [
        PageScope(
            source=source,
            roles=list(dict.fromkeys(item["roles"])),
            paths=list(dict.fromkeys(item["paths"])),
        )
        for source, item in grouped.items()
    ]
    evidence = list(
        dict.fromkeys(
            resource for item in grouped.values() for resource in item["evidence"]
        )
    )
    return scopes, evidence


def compile_intent(intent: KnowledgePlanIntent, catalogs: list[dict]) -> CompileResult:
    diagnostics: list[PlanDiagnostic] = []

    def report(
        code: str,
        category: str,
        pointer: str,
        message: str,
        actual,
        suggestion: str,
    ) -> None:
        diagnostics.append(
            PlanDiagnostic(
                code,
                category,
                pointer,
                message,
                json.dumps(actual, ensure_ascii=False, sort_keys=True, default=str),
                suggestion,
            )
        )

    collections = {
        "source-area": (intent.source_areas, "/source_areas"),
        "domain": (intent.domains, "/domains"),
        "concept": (intent.concepts, "/concepts"),
        "relationship": (intent.relationships, "/relationships"),
        "unit": (intent.units, "/units"),
        "gap": (intent.gaps, "/gaps"),
    }
    for label, (items, pointer) in collections.items():
        positions: dict[str, list[int]] = {}
        for index, item in enumerate(items):
            positions.setdefault(item.id, []).append(index)
        for item_id, indexes in positions.items():
            if len(indexes) > 1:
                report(
                    f"{label}-id-duplicate",
                    "structural",
                    pointer,
                    f"{label} id must be unique",
                    {"id": item_id, "indexes": indexes},
                    f"keep one {label} record for {item_id}",
                )

    domains = {item.id: item for item in intent.domains}
    concepts = {item.id: item for item in intent.concepts}
    units = {item.id: item for item in intent.units}
    gaps = {item.id for item in intent.gaps}
    catalog_tables = {
        (catalog["name"], table["name"])
        for catalog in catalogs
        for table in catalog.get("tables", [])
    }
    catalog_sources = {catalog["name"] for catalog in catalogs}

    for index, area in enumerate(intent.source_areas):
        unknown = sorted(set(area.domain_ids) - set(domains))
        if unknown:
            report(
                "source-area-domain-invalid",
                "cross-artifact",
                f"/source_areas/{index}/domain_ids",
                "source area references unknown domains",
                unknown,
                "use domain ids declared in /domains",
            )
    area_paths = [
        (index, area.source, path)
        for index, area in enumerate(intent.source_areas)
        for path in area.paths
    ]
    for position, (index, source, path) in enumerate(area_paths):
        for other_index, other_source, other in area_paths[position + 1 :]:
            if source == other_source and (
                path == other
                or path == "."
                or other == "."
                or path.startswith(other + "/")
                or other.startswith(path + "/")
            ):
                report(
                    "source-area-overlap",
                    "coverage",
                    f"/source_areas/{index}/paths",
                    "source area paths must form a non-overlapping partition",
                    {"path": path, "other_index": other_index, "other": other},
                    "keep the parent or its children, not both",
                )

    classified: dict[tuple[str, str], list[int]] = {}
    concept_tables: dict[str, list[CatalogTableRef]] = {
        concept.id: [] for concept in intent.concepts
    }
    normalized_groups: dict[tuple[str, str | None, str], dict] = {}
    for index, group in enumerate(intent.catalog_groups):
        if len(group.tables) != len(set(group.tables)):
            report(
                "catalog-group-table-duplicate",
                "structural",
                f"/catalog_groups/{index}/tables",
                "table names within one catalog group must be unique",
                group.tables,
                "remove duplicate table names",
            )
        if group.source not in catalog_sources:
            report(
                "catalog-source-invalid",
                "cross-artifact",
                f"/catalog_groups/{index}/source",
                "catalog group references an uncaptured source",
                group.source,
                "use a captured OpenGauss source",
            )
        if group.domain_id is not None and group.domain_id not in domains:
            report(
                "catalog-group-domain-invalid",
                "cross-artifact",
                f"/catalog_groups/{index}/domain_id",
                "catalog group references an unknown domain",
                group.domain_id,
                "use a domain id declared in /domains",
            )
        unknown_concepts = sorted(set(group.concept_ids) - set(concepts))
        if unknown_concepts:
            report(
                "catalog-group-concept-invalid",
                "cross-artifact",
                f"/catalog_groups/{index}/concept_ids",
                "catalog group references unknown concepts",
                unknown_concepts,
                "use concept ids declared in /concepts",
            )
        if group.concept_ids and group.domain_id is None:
            report(
                "catalog-group-domain-missing",
                "structural",
                f"/catalog_groups/{index}/domain_id",
                "tables assigned to concepts require a domain",
                group.concept_ids,
                "set the owning domain_id",
            )
        wrong_domain = sorted(
            concept_id
            for concept_id in group.concept_ids
            if concept_id in concepts
            and concepts[concept_id].domain_id != group.domain_id
        )
        if wrong_domain:
            report(
                "catalog-group-concept-domain-invalid",
                "cross-artifact",
                f"/catalog_groups/{index}/concept_ids",
                "catalog concepts must belong to the catalog group domain",
                wrong_domain,
                "split the tables by the concepts' owning domains",
            )
        if group.role == "unresolved" and not group.gap_ids:
            report(
                "catalog-group-gap-missing",
                "coverage",
                f"/catalog_groups/{index}/gap_ids",
                "unresolved catalog tables require a gap",
                group.tables,
                "reference a declared model-coverage gap",
            )
        if group.role == "unresolved":
            report(
                "table-disposition-unresolved",
                "coverage",
                f"/catalog_groups/{index}",
                "captured table classification remains unresolved",
                group.tables,
                "investigate and assign a resolved role before Plan approval",
            )
        if group.role != "unresolved" and group.gap_ids:
            report(
                "catalog-group-gap-unexpected",
                "structural",
                f"/catalog_groups/{index}/gap_ids",
                "resolved catalog groups cannot carry gaps",
                group.gap_ids,
                "remove gap_ids or mark the group unresolved",
            )
        if group.role == "excluded" and not group.evidence:
            report(
                "catalog-group-evidence-missing",
                "evidence",
                f"/catalog_groups/{index}/evidence",
                "excluded catalog tables require classification evidence",
                group.tables,
                "cite the evidence supporting exclusion",
            )
        unknown_gaps = sorted(set(group.gap_ids) - gaps)
        if unknown_gaps:
            report(
                "catalog-group-gap-invalid",
                "cross-artifact",
                f"/catalog_groups/{index}/gap_ids",
                "catalog group references unknown gaps",
                unknown_gaps,
                "use gap ids declared in /gaps",
            )
        key = (group.source, group.domain_id, group.role)
        target = normalized_groups.setdefault(
            key,
            {
                "source": group.source,
                "domain_id": group.domain_id,
                "role": group.role,
                "tables": [],
                "evidence": [],
                "gap_ids": [],
            },
        )
        target["tables"].extend(group.tables)
        target["evidence"].extend(group.evidence)
        target["gap_ids"].extend(group.gap_ids)
        for table in group.tables:
            table_key = (group.source, table)
            classified.setdefault(table_key, []).append(index)
            if table_key not in catalog_tables:
                report(
                    "catalog-table-invalid",
                    "cross-artifact",
                    f"/catalog_groups/{index}/tables",
                    "catalog group references a table outside the captured catalog",
                    {"source": group.source, "table": table},
                    "use a table returned by catalog tables",
                )
            for concept_id in group.concept_ids:
                if concept_id in concept_tables:
                    concept_tables[concept_id].append(
                        CatalogTableRef(source=group.source, table=table)
                    )

    for table, indexes in classified.items():
        if len(indexes) > 1:
            report(
                "catalog-table-classified-twice",
                "coverage",
                "/catalog_groups",
                "each captured table must have one semantic classification",
                {"source": table[0], "table": table[1], "indexes": indexes},
                "keep the table in one catalog group",
            )
    for source, table in sorted(catalog_tables - set(classified)):
        report(
            "catalog-table-unclassified",
            "coverage",
            "/catalog_groups",
            "captured table has no semantic classification",
            {"source": source, "table": table},
            "add the table to a domain, infrastructure, excluded, or unresolved group",
        )

    replica_positions: dict[tuple[str, str], list[int]] = {}
    for index, replica in enumerate(intent.table_replicas):
        table = (replica.table.source, replica.table.table)
        target = (replica.replica_of.source, replica.replica_of.table)
        replica_positions.setdefault(table, []).append(index)
        for label, reference in (("table", table), ("replica_of", target)):
            if reference not in catalog_tables:
                report(
                    "replica-table-invalid",
                    "cross-artifact",
                    f"/table_replicas/{index}/{label}",
                    "replica mapping references a table outside captured catalogs",
                    {"source": reference[0], "table": reference[1]},
                    "use a table returned by catalog tables",
                )
        group_indexes = classified.get(table, [])
        if (
            len(group_indexes) == 1
            and intent.catalog_groups[group_indexes[0]].role != "replica"
        ):
            report(
                "replica-role-invalid",
                "structural",
                f"/table_replicas/{index}/table",
                "replica mapping source table must use the replica role",
                {"source": table[0], "table": table[1]},
                "classify the source table as replica or remove the mapping",
            )
    for table, indexes in replica_positions.items():
        if len(indexes) > 1:
            report(
                "replica-mapping-duplicate",
                "coverage",
                "/table_replicas",
                "each replica table must have exactly one mapping",
                {"source": table[0], "table": table[1], "indexes": indexes},
                "keep one proven replica mapping",
            )
    for table, indexes in classified.items():
        if len(indexes) == 1 and intent.catalog_groups[indexes[0]].role == "replica":
            mappings = replica_positions.get(table, [])
            if len(mappings) != 1:
                report(
                    "replica-mapping-missing",
                    "coverage",
                    "/table_replicas",
                    "each table classified as replica requires exactly one mapping",
                    {"source": table[0], "table": table[1]},
                    "add one evidence-backed replica mapping",
                )

    compiled_concepts: list[DomainConcept] = []
    for index, concept in enumerate(intent.concepts):
        basis = concept.model_basis
        unknown_gaps = sorted(set(basis.gap_ids) - gaps)
        if concept.domain_id not in domains:
            report(
                "concept-domain-invalid",
                "cross-artifact",
                f"/concepts/{index}/domain_id",
                "concept references an unknown domain",
                concept.domain_id,
                "use a domain id declared in /domains",
            )
        if basis.coverage == "partial" and not basis.gap_ids:
            report(
                "concept-gap-missing",
                "coverage",
                f"/concepts/{index}/model_basis/gap_ids",
                "partial model coverage requires a gap",
                concept.id,
                "reference a declared model-coverage gap",
            )
        if basis.coverage == "full" and basis.gap_ids:
            report(
                "concept-gap-unexpected",
                "structural",
                f"/concepts/{index}/model_basis/gap_ids",
                "full model coverage cannot carry gaps",
                basis.gap_ids,
                "remove gap_ids or mark coverage partial",
            )
        if unknown_gaps:
            report(
                "concept-gap-invalid",
                "cross-artifact",
                f"/concepts/{index}/model_basis/gap_ids",
                "concept references unknown gaps",
                unknown_gaps,
                "use gap ids declared in /gaps",
            )
        table_keys = dict.fromkeys(
            (table.source, table.table) for table in concept_tables[concept.id]
        )
        tables = [
            CatalogTableRef(source=source, table=table) for source, table in table_keys
        ]
        if basis.basis == "opengauss" and not tables:
            report(
                "concept-catalog-model-missing",
                "coverage",
                f"/concepts/{index}/model_basis",
                "OpenGauss concept is not linked from any catalog group",
                concept.id,
                "add the concept id to the relevant catalog group",
            )
        if basis.basis == "opengauss" and basis.structure_evidence:
            report(
                "concept-structure-evidence-unexpected",
                "structural",
                f"/concepts/{index}/model_basis/structure_evidence",
                "OpenGauss structure is derived from catalog groups",
                basis.structure_evidence,
                "remove structure_evidence",
            )
        if basis.basis == "code" and not basis.structure_evidence:
            report(
                "concept-structure-evidence-missing",
                "evidence",
                f"/concepts/{index}/model_basis/structure_evidence",
                "code model basis requires structural evidence",
                concept.id,
                "cite DDL, ORM, mapper, or persistence evidence",
            )
        if basis.basis == "none" and (
            basis.coverage != "full" or basis.structure_evidence or basis.gap_ids
        ):
            report(
                "concept-none-model-invalid",
                "structural",
                f"/concepts/{index}/model_basis",
                "non-persistent concepts cannot carry model evidence or gaps",
                basis.model_dump(mode="json"),
                "use basis none with default full coverage only",
            )
        if not diagnostics:
            compiled_concepts.append(
                DomainConcept(
                    **concept.model_dump(exclude={"model_basis"}),
                    model_basis=ConceptModelBasis(
                        **basis.model_dump(), catalog_tables=tables
                    ),
                )
            )

    compiled_units: list[KnowledgeUnit] = []
    derived_ids = {
        model_unit_id(concept.id)
        for concept in intent.concepts
        if concept.model_basis.basis != "none"
    }
    for index, unit in enumerate(intent.units):
        if unit.id in derived_ids:
            report(
                "unit-id-reserved",
                "structural",
                f"/units/{index}/id",
                "persistent concept model unit ids are kernel-derived",
                unit.id,
                "choose a non-model authored unit id",
            )
        unknown_domains = sorted(set(unit.domain_ids) - set(domains))
        unknown_concepts = sorted(set(unit.concept_ids) - set(concepts))
        if unknown_domains:
            report(
                "unit-domain-invalid",
                "cross-artifact",
                f"/units/{index}/domain_ids",
                "unit references unknown domains",
                unknown_domains,
                "use domain ids declared in /domains",
            )
        if unknown_concepts:
            report(
                "unit-concept-invalid",
                "cross-artifact",
                f"/units/{index}/concept_ids",
                "unit references unknown concepts",
                unknown_concepts,
                "use concept ids declared in /concepts",
            )
        wrong_domains = sorted(
            concept_id
            for concept_id in unit.concept_ids
            if concept_id in concepts
            and concepts[concept_id].domain_id not in unit.domain_ids
        )
        if wrong_domains:
            report(
                "unit-concept-domain-invalid",
                "cross-artifact",
                f"/units/{index}",
                "unit must include each covered concept's domain",
                wrong_domains,
                "add the owning domains or remove the concepts",
            )
        scopes, evidence = normalize_participants(unit.participants, catalog_sources)
        for participant_index, participant in enumerate(unit.participants):
            if participant.source not in catalog_sources and not participant.evidence:
                report(
                    "unit-participant-evidence-missing",
                    "evidence",
                    f"/units/{index}/participants/{participant_index}/evidence",
                    "code and file participants require at least one evidence anchor",
                    participant.source,
                    "add an opened locator inside the participant paths",
                )
            wrong_source = [
                resource
                for resource in participant.evidence
                if not resource.startswith(participant.source + "/")
            ]
            if wrong_source:
                report(
                    "unit-participant-evidence-source-invalid",
                    "evidence",
                    f"/units/{index}/participants/{participant_index}/evidence",
                    "participant evidence must use the participant source",
                    wrong_source,
                    "move the evidence to the matching participant",
                )
        roles = {role for scope in scopes for role in scope.roles}
        if unit.kind == "integration" and (
            len(scopes) < 2 or not {"producer", "consumer"} <= roles
        ):
            report(
                "integration-participants-invalid",
                "structural",
                f"/units/{index}/participants",
                "integration requires producer and consumer roles across at least two sources",
                {scope.source: scope.roles for scope in scopes},
                "add the missing participant roles and source",
            )
        if not diagnostics:
            compiled_units.append(
                KnowledgeUnit(
                    id=unit.id,
                    kind=unit.kind,
                    question=unit.question,
                    domain_ids=unit.domain_ids,
                    concept_ids=unit.concept_ids,
                    scopes=scopes,
                    evidence_seeds=evidence,
                )
            )

    owners: dict[str, list[str]] = {}
    for domain in intent.domains:
        owners.setdefault(domain.owner_unit_id, []).append(domain.id)
    for owner_unit_id, domain_ids in owners.items():
        if len(domain_ids) > 1:
            report(
                "domain-owner-unit-shared",
                "structural",
                "/domains",
                "each Domain requires a dedicated owner unit",
                {"owner_unit_id": owner_unit_id, "domain_ids": domain_ids},
                "assign a distinct capability unit to each Domain",
            )

    for index, domain in enumerate(intent.domains):
        owner = units.get(domain.owner_unit_id)
        if (
            owner is None
            or owner.kind != "capability"
            or domain.id not in owner.domain_ids
        ):
            report(
                "domain-owner-invalid",
                "cross-artifact",
                f"/domains/{index}/owner_unit_id",
                "domain owner unit must cover the domain",
                domain.owner_unit_id,
                "reference an authored capability unit covering this domain",
            )
    for index, concept in enumerate(intent.concepts):
        owner = units.get(concept.owner_unit_id)
        if owner is None or concept.id not in owner.concept_ids:
            report(
                "concept-owner-invalid",
                "cross-artifact",
                f"/concepts/{index}/owner_unit_id",
                "concept owner unit must cover the concept",
                concept.owner_unit_id,
                "reference an authored unit covering this concept",
            )
    for index, relationship in enumerate(intent.relationships):
        unknown = sorted(
            {
                relationship.from_concept_id,
                relationship.to_concept_id,
            }
            - set(concepts)
        )
        if unknown:
            report(
                "relationship-concept-invalid",
                "cross-artifact",
                f"/relationships/{index}",
                "relationship endpoints must reference declared concepts",
                unknown,
                "use concept ids declared in /concepts",
            )

    if diagnostics:
        return CompileResult(None, diagnostics)

    table_groups = [
        TableGroup(
            **{
                **group,
                "tables": list(dict.fromkeys(group["tables"])),
                "evidence": list(dict.fromkeys(group["evidence"])),
                "gap_ids": list(dict.fromkeys(group["gap_ids"])),
            }
        )
        for group in normalized_groups.values()
    ]
    try:
        plan = KnowledgePlan(
            kind="knowledge-plan-ledger",
            intent_digest=intent_digest(intent),
            source_areas=intent.source_areas,
            domains=intent.domains,
            concepts=compiled_concepts,
            table_groups=table_groups,
            table_replicas=intent.table_replicas,
            relationships=intent.relationships,
            units=compiled_units,
            gaps=intent.gaps,
        )
    except ValidationError as exc:
        return CompileResult(
            None,
            [
                PlanDiagnostic(
                    "compiled-ledger-invalid",
                    "structural",
                    "/",
                    "; ".join(model_errors(exc)),
                    "kernel output",
                    "report this compiler defect",
                )
            ],
        )
    return CompileResult(plan, [])
