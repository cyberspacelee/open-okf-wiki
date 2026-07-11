from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable, Literal, Mapping, TypedDict

from .accepted_knowledge import ClaimRecord, ConceptRecord, EvidenceRecord


class RenderedPage(TypedDict):
    concept_id: str
    path: str


@dataclass(frozen=True, order=True)
class SourceUnit:
    id: str
    source_id: str
    revision: str
    path: str
    kind: str
    digest: str | None
    label: str | None = None

    @classmethod
    def from_record(cls, record: Mapping[str, object]) -> "SourceUnit":
        label = record.get("name") or record.get("heading")
        return cls(
            id=str(record["source_unit"]),
            source_id=str(record["source_id"]),
            revision=str(record["revision"]),
            path=str(record["path"]),
            kind=str(record["source_unit_kind"]),
            digest=str(record["content_digest"]) if record.get("content_digest") else None,
            label=str(label) if label else None,
        )

    @property
    def locator(self) -> tuple[str, str, str, str | None]:
        return self.source_id, self.path, self.kind, self.label

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "source_id": self.source_id,
            "revision": self.revision,
            "path": self.path,
            "kind": self.kind,
            "digest": self.digest,
            "label": self.label,
        }


@dataclass(frozen=True)
class UnitChange:
    kind: Literal["changed", "moved"]
    before: SourceUnit
    after: SourceUnit

    def as_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "before": self.before.as_dict(),
            "after": self.after.as_dict(),
        }


@dataclass(frozen=True)
class RevisionDiff:
    added: tuple[SourceUnit, ...]
    changed: tuple[UnitChange, ...]
    moved: tuple[UnitChange, ...]
    removed: tuple[SourceUnit, ...]
    relocations: dict[str, str]
    full_analysis: bool = False
    fallback_reason: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "added": [item.as_dict() for item in self.added],
            "changed": [item.as_dict() for item in self.changed],
            "moved": [item.as_dict() for item in self.moved],
            "removed": [item.as_dict() for item in self.removed],
            "by_source": self.by_source(),
        }

    def by_source(self) -> dict[str, dict[str, list[dict[str, object]]]]:
        source_ids = {
            *(item.source_id for item in (*self.added, *self.removed)),
            *(item.before.source_id for item in (*self.changed, *self.moved)),
        }
        return {
            source_id: {
                "added": [item.as_dict() for item in self.added if item.source_id == source_id],
                "changed": [
                    item.as_dict() for item in self.changed if item.before.source_id == source_id
                ],
                "moved": [
                    item.as_dict() for item in self.moved if item.before.source_id == source_id
                ],
                "removed": [item.as_dict() for item in self.removed if item.source_id == source_id],
            }
            for source_id in sorted(source_ids)
        }


def diff_source_units(
    previous_records: Iterable[Mapping[str, object]],
    current_records: Iterable[Mapping[str, object]],
) -> RevisionDiff:
    previous = {item.id: item for item in map(SourceUnit.from_record, previous_records)}
    current = {item.id: item for item in map(SourceUnit.from_record, current_records)}
    old_left = set(previous)
    new_left = set(current)
    relocations: dict[str, str] = {}
    moved: list[UnitChange] = []
    changed: list[UnitChange] = []
    ambiguous = False

    def unique_matches(key) -> list[tuple[str, str]]:
        old_groups: dict[object, list[str]] = defaultdict(list)
        new_groups: dict[object, list[str]] = defaultdict(list)
        for item_id in old_left:
            old_groups[key(previous[item_id])].append(item_id)
        for item_id in new_left:
            new_groups[key(current[item_id])].append(item_id)
        return [
            (old_ids[0], new_groups[value][0])
            for value, old_ids in old_groups.items()
            if value is not None and len(old_ids) == 1 and len(new_groups.get(value, ())) == 1
        ]

    for old_id, new_id in unique_matches(
        lambda item: (item.source_id, item.path, item.kind, item.digest) if item.digest else None
    ):
        old_left.remove(old_id)
        new_left.remove(new_id)
        if old_id != new_id:
            relocations[old_id] = new_id

    def digest_key(item: SourceUnit) -> tuple[str, str, str] | None:
        return (item.source_id, item.kind, item.digest) if item.digest else None

    old_digest_counts: dict[object, int] = defaultdict(int)
    new_digest_counts: dict[object, int] = defaultdict(int)
    for item_id in old_left:
        old_digest_counts[digest_key(previous[item_id])] += 1
    for item_id in new_left:
        new_digest_counts[digest_key(current[item_id])] += 1
    ambiguous = any(
        key is not None
        and old_digest_counts[key]
        and new_digest_counts[key]
        and (old > 1 or new_digest_counts[key] > 1)
        for key, old in old_digest_counts.items()
    )
    for old_id, new_id in unique_matches(digest_key):
        before, after = previous[old_id], current[new_id]
        old_left.remove(old_id)
        new_left.remove(new_id)
        relocations[old_id] = new_id
        moved.append(UnitChange("moved", before, after))

    for old_id, new_id in unique_matches(lambda item: item.locator):
        before, after = previous[old_id], current[new_id]
        old_left.remove(old_id)
        new_left.remove(new_id)
        changed.append(UnitChange("changed", before, after))

    missing_digest = any(item.digest is None for item in (*previous.values(), *current.values()))
    full_analysis = missing_digest or ambiguous
    reason = (
        "Source Unit content digest is missing"
        if missing_digest
        else "Source Unit relocation is ambiguous"
        if ambiguous
        else None
    )
    return RevisionDiff(
        added=tuple(sorted((current[item] for item in new_left))),
        changed=tuple(sorted(changed, key=lambda item: item.before)),
        moved=tuple(sorted(moved, key=lambda item: item.before)),
        removed=tuple(sorted((previous[item] for item in old_left))),
        relocations=relocations,
        full_analysis=full_analysis,
        fallback_reason=reason,
    )


@dataclass(frozen=True)
class Impact:
    source_units: tuple[str, ...]
    evidence: tuple[str, ...]
    claims: tuple[str, ...]
    concepts: tuple[str, ...]
    pages: tuple[str, ...]

    def as_dict(self) -> dict[str, list[str]]:
        return {
            "source_units": list(self.source_units),
            "evidence": list(self.evidence),
            "claims": list(self.claims),
            "concepts": list(self.concepts),
            "pages": list(self.pages),
        }


@dataclass(frozen=True)
class KnowledgeImpactGraph:
    unit_evidence: dict[str, frozenset[str]]
    evidence_claims: dict[str, frozenset[str]]
    claim_concepts: dict[str, frozenset[str]]
    concept_pages: dict[str, frozenset[str]]

    @classmethod
    def from_records(
        cls,
        *,
        source_units: Iterable[Mapping[str, object]],
        evidence: Iterable[EvidenceRecord],
        claims: Iterable[ClaimRecord],
        concepts: Iterable[ConceptRecord],
        pages: Iterable[RenderedPage],
    ) -> "KnowledgeImpactGraph":
        units = {str(item["source_unit"]) for item in source_units}
        unit_evidence: dict[str, set[str]] = defaultdict(set)
        for item in evidence:
            source_unit = str(item["source_unit"])
            if source_unit in units:
                unit_evidence[source_unit].add(str(item["id"]))
        evidence_claims: dict[str, set[str]] = defaultdict(set)
        for claim in claims:
            for item in claim["evidence"]:
                evidence_claims[item["id"]].add(claim["id"])
        claim_concepts: dict[str, set[str]] = defaultdict(set)
        for concept in concepts:
            for claim_id in [
                *concept["defining_claim_ids"],
                *concept["supporting_claim_ids"],
            ]:
                claim_concepts[claim_id].add(concept["id"])
        concept_pages: dict[str, set[str]] = defaultdict(set)
        for page in pages:
            concept_pages[page["concept_id"]].add(page["path"])
        return cls(
            {key: frozenset(value) for key, value in unit_evidence.items()},
            {key: frozenset(value) for key, value in evidence_claims.items()},
            {key: frozenset(value) for key, value in claim_concepts.items()},
            {key: frozenset(value) for key, value in concept_pages.items()},
        )

    def downstream(self, source_unit_ids: Iterable[str]) -> Impact:
        units = set(source_unit_ids)
        evidence = {item for unit in units for item in self.unit_evidence.get(unit, ())}
        claims = {item for item_id in evidence for item in self.evidence_claims.get(item_id, ())}
        concepts = {item for claim in claims for item in self.claim_concepts.get(claim, ())}
        pages = {item for concept in concepts for item in self.concept_pages.get(concept, ())}
        return Impact(
            tuple(sorted(units)),
            tuple(sorted(evidence)),
            tuple(sorted(claims)),
            tuple(sorted(concepts)),
            tuple(sorted(pages)),
        )


@dataclass(frozen=True)
class RefreshPlan:
    mode: Literal["incremental", "full"]
    fallback_reason: str | None
    new_source_units: tuple[str, ...]
    reverify_claims: tuple[str, ...]
    reverify_concepts: tuple[str, ...]
    rerender_pages: tuple[str, ...]
    relocations: dict[str, str]

    def as_dict(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "fallback_reason": self.fallback_reason,
            "new_source_units": list(self.new_source_units),
            "reverify_claims": list(self.reverify_claims),
            "reverify_concepts": list(self.reverify_concepts),
            "rerender_pages": list(self.rerender_pages),
            "relocations": dict(sorted(self.relocations.items())),
        }


def plan_refresh(diff: RevisionDiff, graph: KnowledgeImpactGraph) -> RefreshPlan:
    affected = graph.downstream(
        {
            *(item.before.id for item in diff.changed),
            *(item.id for item in diff.removed),
        }
    )
    return RefreshPlan(
        mode="full" if diff.full_analysis else "incremental",
        fallback_reason=diff.fallback_reason,
        new_source_units=tuple(sorted(item.id for item in diff.added)),
        reverify_claims=affected.claims,
        reverify_concepts=affected.concepts,
        rerender_pages=affected.pages,
        relocations=diff.relocations,
    )
