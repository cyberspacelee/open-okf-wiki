import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .cli import inspect_source, load_profile
from .security import git_read


CORPUS_ROOT = Path(__file__).with_name("benchmark_corpus")
REQUIRED_FEATURES = {
    "conflicting_sources",
    "dto_heavy_java",
    "java_spring",
    "markdown_requirements",
    "multi_module",
    "multi_repository",
}
REQUIRED_MUTATION_KINDS = {
    "concept_rename",
    "file_move",
    "injected_conflict",
    "large_dto",
    "new_requirement",
    "permission_change",
    "removed_defining_evidence",
}
COMMIT_ENV = {
    "GIT_AUTHOR_NAME": "OKF Benchmark",
    "GIT_AUTHOR_EMAIL": "benchmark@example.invalid",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00+00:00",
    "GIT_COMMITTER_NAME": "OKF Benchmark",
    "GIT_COMMITTER_EMAIL": "benchmark@example.invalid",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00+00:00",
}
MutationKind = Literal[
    "concept_rename",
    "file_move",
    "injected_conflict",
    "large_dto",
    "new_requirement",
    "permission_change",
    "removed_defining_evidence",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CorpusFile(StrictModel):
    path: str = Field(min_length=1)
    mode: Literal["100644", "100755"] = "100644"
    content: str = Field(min_length=1)


class CorpusRepository(StrictModel):
    id: str = Field(min_length=1)
    role: str = Field(min_length=1)
    revision: str = Field(min_length=1)
    files: tuple[CorpusFile, ...] = Field(min_length=1)


class CorpusProject(StrictModel):
    id: str = Field(min_length=1)
    source_ids: tuple[str, ...] = Field(min_length=2)


class ReleaseBaseline(StrictModel):
    pydantic_ai: str = Field(min_length=1)


class CorpusDefinition(StrictModel):
    version: str
    release_baseline: ReleaseBaseline
    features: tuple[str, ...]
    producer_project: CorpusProject
    repositories: tuple[CorpusRepository, ...] = Field(min_length=2)


class MutationChange(StrictModel):
    operation: Literal["add", "chmod", "move", "remove", "replace"]
    source_id: str = Field(min_length=1)
    path: str = Field(min_length=1)
    target: str | None = None
    content: str | None = None
    mode: str | None = None

    @model_validator(mode="after")
    def complete_change(self):
        required = {
            "add": self.content,
            "chmod": self.mode,
            "move": self.target,
            "remove": True,
            "replace": self.content,
        }
        if not required[self.operation]:
            raise ValueError(f"Mutation {self.operation} lacks its required value")
        return self


class ExpectedObligation(StrictModel):
    source_id: str
    path: str
    kind: str
    text: str
    priority: Literal["major"]
    disposition: Literal["covered", "excluded"]


class ExpectedConceptMembership(StrictModel):
    canonical_name: str
    claim_statement: str
    role: Literal["defining", "supporting"]


class SemanticUnchangedExpectation(StrictModel):
    effect: Literal["semantic_unchanged"]
    semantic_snapshot: Literal["unchanged"]


class NewMajorObligationExpectation(StrictModel):
    effect: Literal["new_major_obligation"]
    claim_statement: str
    obligation: ExpectedObligation


class RemovedDefiningEvidenceExpectation(StrictModel):
    effect: Literal["removed_defining_evidence"]
    claim_statement: str


class EvidenceRelocatedExpectation(StrictModel):
    effect: Literal["evidence_relocated"]
    claim_statement: str
    evidence_path: str


class ConceptIdentityExpectation(StrictModel):
    effect: Literal["concept_identity_preserved"]
    previous_concept_name: str
    concept_name: str


class CriticalConflictExpectation(StrictModel):
    effect: Literal["critical_conflict_resolved"]
    claim_statement: str
    epistemic_status: Literal["disputed"]


class DataContractExpectation(StrictModel):
    effect: Literal["data_contract_added"]
    concept_membership: ExpectedConceptMembership


MutationExpectation = Annotated[
    SemanticUnchangedExpectation
    | NewMajorObligationExpectation
    | RemovedDefiningEvidenceExpectation
    | EvidenceRelocatedExpectation
    | ConceptIdentityExpectation
    | CriticalConflictExpectation
    | DataContractExpectation,
    Field(discriminator="effect"),
]


class MutationCase(StrictModel):
    id: str
    kind: MutationKind
    description: str
    change: MutationChange
    expected: MutationExpectation
    source_revisions: dict[str, str]


class MutationDefinition(StrictModel):
    version: str
    cases: tuple[MutationCase, ...]


class SemanticClaim(StrictModel):
    key: str
    subject: str
    predicate: str
    statement: str
    source_id: str
    marker: str
    major: bool
    critical: bool
    epistemic_status: Literal["supported", "disputed"] = "supported"
    conflicts_with: tuple[str, ...] = ()
    exclusion_reason: str | None = None


class SemanticConcept(StrictModel):
    key: str
    canonical_name: str
    aliases: tuple[str, ...]
    defining_claims: tuple[str, ...]
    supporting_claims: tuple[str, ...]


class SemanticFixture(StrictModel):
    version: str
    claims: tuple[SemanticClaim, ...]
    concepts: tuple[SemanticConcept, ...]
    renames: dict[str, dict[str, str]]


class GoldEvidence(StrictModel):
    key: str
    source_id: str
    revision: str
    path: str
    source_unit: str
    start_line: int
    end_line: int
    digest: str


class GoldClaim(StrictModel):
    key: str
    statement: str
    major: bool
    critical: bool
    evidence_key: str


class GoldConcept(StrictModel):
    key: str
    canonical_name: str
    aliases: tuple[str, ...]
    claim_keys: tuple[str, ...] = Field(min_length=1)


class GoldReview(StrictModel):
    status: Literal["approved"]
    reviewers: tuple[str, ...] = Field(min_length=1)
    reviewed_at: str = Field(min_length=1)


class GoldObligation(StrictModel):
    id: str
    source_id: str
    path: str
    kind: str
    disposition: Literal["covered", "excluded"]
    evidence_key: str | None = None
    reason: str | None = None

    @model_validator(mode="after")
    def reviewed_resolution(self):
        if self.disposition == "covered" and (not self.evidence_key or self.reason):
            raise ValueError("Covered Gold Obligations require Evidence and no exclusion reason")
        if self.disposition == "excluded" and (self.evidence_key or not self.reason):
            raise ValueError("Excluded Gold Obligations require a reviewed reason and no Evidence")
        return self


class GoldConflict(StrictModel):
    key: str
    critical: bool
    resolved_by: str


class GoldExclusion(StrictModel):
    source_id: str
    path: str
    reason: str


class GoldDefinition(StrictModel):
    version: str
    review: GoldReview
    major_obligations: tuple[GoldObligation, ...]
    evidence: tuple[GoldEvidence, ...]
    claims: tuple[GoldClaim, ...]
    concepts: tuple[GoldConcept, ...]
    conflicts: tuple[GoldConflict, ...]
    exclusions: tuple[GoldExclusion, ...]
    data_contracts: tuple[str, ...]


class ReleaseManifest(StrictModel):
    corpus_version: str


class BenchmarkCorpus(StrictModel):
    version: str
    release_baseline: ReleaseBaseline
    project: CorpusProject
    features: tuple[str, ...]
    repositories: tuple[CorpusRepository, ...]
    source_revisions: dict[str, str]
    mutations: tuple[MutationCase, ...]
    semantic: SemanticFixture
    gold: GoldDefinition


@dataclass(frozen=True)
class MaterializedCorpus:
    repositories: dict[str, Path]
    base_revisions: dict[str, str]
    mutation_revisions: dict[str, dict[str, str]]


def load_benchmark_corpus(version: str = "v1") -> BenchmarkCorpus:
    root = CORPUS_ROOT / version
    try:
        corpus = CorpusDefinition.model_validate_json((root / "corpus.json").read_text())
        mutations = MutationDefinition.model_validate_json((root / "mutations.json").read_text())
        semantic = SemanticFixture.model_validate_json((root / "semantic.json").read_text())
        gold = GoldDefinition.model_validate_json((root / "gold.json").read_text())
    except OSError as error:
        raise ValueError(f"Unknown Benchmark Corpus version: {version}") from error
    if {corpus.version, mutations.version, semantic.version, gold.version} != {version}:
        raise ValueError("Benchmark Corpus artifacts must share one version")
    source_revisions = {item.id: item.revision for item in corpus.repositories}
    source_ids = set(source_revisions)
    if set(corpus.features) != REQUIRED_FEATURES:
        raise ValueError("Benchmark Corpus lacks a required representative source shape")
    if set(corpus.producer_project.source_ids) != source_ids:
        raise ValueError("Producer Project must include every Benchmark Corpus repository")
    if any(set(item.source_revisions) != source_ids for item in mutations.cases):
        raise ValueError("Every Mutation Case must fix every source revision")
    if {item.kind for item in mutations.cases} != REQUIRED_MUTATION_KINDS:
        raise ValueError("Benchmark Corpus lacks a required Mutation Case")
    if {item.evidence_key for item in gold.claims} - {item.key for item in gold.evidence}:
        raise ValueError("Gold Claim references unknown Evidence")
    if {item.evidence_key for item in gold.major_obligations if item.evidence_key} - {
        item.key for item in gold.evidence
    }:
        raise ValueError("Covered Gold Obligation references unknown Evidence")
    gold_claim_keys = {item.key for item in gold.claims}
    if any(set(item.claim_keys) - gold_claim_keys for item in gold.concepts):
        raise ValueError("Gold Concept references unknown Claims")
    if any(
        item.key not in gold_claim_keys or item.resolved_by not in gold_claim_keys
        for item in gold.conflicts
    ):
        raise ValueError("Gold Conflict references unknown Claims")
    if set(gold.data_contracts) - {item.key for item in gold.concepts}:
        raise ValueError("Gold Data Contract references unknown Concepts")
    return BenchmarkCorpus(
        version=version,
        release_baseline=corpus.release_baseline,
        project=corpus.producer_project,
        features=corpus.features,
        repositories=corpus.repositories,
        source_revisions=source_revisions,
        mutations=mutations.cases,
        semantic=semantic,
        gold=gold,
    )


def git_write(repository: Path, *arguments: str, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    )
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Git command failed")
    return result.stdout.strip()


def source_text(repository: Path, revision: str, path: str) -> str:
    return git_read(repository, "show", f"{revision}:{path}")


def resolve_marker(
    repositories: dict[str, Path], revisions: dict[str, str], claim: SemanticClaim
) -> dict | None:
    repository = repositories[claim.source_id]
    revision = revisions[claim.source_id]
    paths = git_read(repository, "ls-tree", "-r", "--name-only", revision).splitlines()
    matches = []
    for path in paths:
        if not path.lower().endswith((".java", ".md")):
            continue
        lines = source_text(repository, revision, path).splitlines()
        matches.extend(
            (path, index, line) for index, line in enumerate(lines, 1) if claim.marker in line
        )
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError(f"Semantic marker is ambiguous: {claim.marker}")
    path, line_number, text = matches[0]
    import hashlib

    return {
        "id": f"evidence:{claim.key}",
        "source_id": claim.source_id,
        "path": path,
        "revision": revision,
        "start_line": line_number,
        "end_line": line_number,
        "digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
    }


def _commit(repository: Path, message: str, day: int) -> str:
    timestamp = f"2026-01-{day:02d}T00:00:00+00:00"
    env = {**COMMIT_ENV, "GIT_AUTHOR_DATE": timestamp, "GIT_COMMITTER_DATE": timestamp}
    git_write(repository, "add", "-A", env=env)
    git_write(repository, "commit", "--quiet", "-m", message, env=env)
    return git_write(repository, "rev-parse", "HEAD")


def _write_file(repository: Path, item: CorpusFile) -> None:
    path = repository / item.path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(item.content, encoding="utf-8")
    path.chmod(0o755 if item.mode == "100755" else 0o644)


def _apply_change(repository: Path, change: MutationChange) -> None:
    path = repository / change.path
    if change.operation in {"add", "replace"}:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(cast(str, change.content), encoding="utf-8")
    elif change.operation == "remove":
        path.unlink()
    elif change.operation == "move":
        target = repository / cast(str, change.target)
        target.parent.mkdir(parents=True, exist_ok=True)
        path.rename(target)
    else:
        path.chmod(0o755 if change.mode == "100755" else 0o644)


def materialize_corpus(corpus: BenchmarkCorpus, root: Path) -> MaterializedCorpus:
    repositories: dict[str, Path] = {}
    base_revisions: dict[str, str] = {}
    root.mkdir(parents=True, exist_ok=True)
    for source in corpus.repositories:
        repository = root / source.id
        repository.mkdir()
        git_write(repository, "init", "--quiet", "--initial-branch=main")
        for item in source.files:
            _write_file(repository, item)
        revision = _commit(repository, f"benchmark {source.id} v1", 1)
        if revision != source.revision:
            raise ValueError(f"Corpus revision mismatch for {source.id}: {revision}")
        repositories[source.id] = repository
        base_revisions[source.id] = revision
    mutation_revisions: dict[str, dict[str, str]] = {}
    for index, mutation in enumerate(corpus.mutations, 2):
        source_id = mutation.change.source_id
        repository = repositories[source_id]
        git_write(repository, "reset", "--hard", base_revisions[source_id])
        git_write(repository, "clean", "-fd")
        _apply_change(repository, mutation.change)
        revision = _commit(repository, mutation.id, index)
        revisions = {**base_revisions, source_id: revision}
        if revisions != mutation.source_revisions:
            raise ValueError(f"Mutation revision mismatch for {mutation.id}: {revision}")
        mutation_revisions[mutation.id] = revisions
    for source_id, repository in repositories.items():
        git_write(repository, "reset", "--hard", base_revisions[source_id])
        git_write(repository, "clean", "-fd")
    materialized = MaterializedCorpus(repositories, base_revisions, mutation_revisions)
    _validate_gold_evidence(corpus, materialized)
    return materialized


def _validate_gold_evidence(corpus: BenchmarkCorpus, materialized: MaterializedCorpus) -> None:
    profile = load_profile(
        {
            "profile": {
                "dispositions": {
                    "major": {"disposition": "open"},
                    "supporting": {"disposition": "open"},
                }
            }
        }
    )
    units = []
    obligations = []
    roles = {item.id: item.role for item in corpus.repositories}
    for source_id in corpus.project.source_ids:
        _, source_units, _, source_obligations, _ = inspect_source(
            {
                "id": source_id,
                "role": roles[source_id],
                "repository": str(materialized.repositories[source_id]),
                "revision": materialized.base_revisions[source_id],
            },
            profile,
        )
        units.extend(source_units)
        obligations.extend(source_obligations)
    observed_major = {item["id"]: item for item in obligations if item["priority"] == "major"}
    expected_major = {item.id: item for item in corpus.gold.major_obligations}
    if set(observed_major) != set(expected_major):
        raise ValueError("Gold Major Obligations do not match the baseline Source Set")
    evidence_by_key = {item.key: item for item in corpus.gold.evidence}
    for obligation_id, expected in expected_major.items():
        observed = observed_major[obligation_id]
        if (observed["source"], observed["path"], observed["kind"]) != (
            expected.source_id,
            expected.path,
            expected.kind,
        ):
            raise ValueError(
                f"Gold Major Obligation does not match source inventory: {obligation_id}"
            )
        if expected.evidence_key:
            evidence = evidence_by_key[expected.evidence_key]
            if (
                evidence.source_id != expected.source_id
                or evidence.path != expected.path
                or not (
                    observed["span"]["start_line"]
                    <= evidence.start_line
                    <= evidence.end_line
                    <= observed["span"]["end_line"]
                )
            ):
                raise ValueError(
                    f"Gold Major Obligation Evidence is outside its span: {obligation_id}"
                )
    claims = {item.key: item for item in corpus.semantic.claims}
    for expected in corpus.gold.evidence:
        observed = resolve_marker(
            materialized.repositories, materialized.base_revisions, claims[expected.key]
        )
        if observed is None:
            raise ValueError(f"Gold Evidence cannot be resolved: {expected.key}")
        matches = [
            item
            for item in units
            if item["source_id"] == observed["source_id"]
            and item["path"] == observed["path"]
            and (
                "span" not in item
                or item["span"]["start_line"]
                <= observed["start_line"]
                <= observed["end_line"]
                <= item["span"]["end_line"]
            )
        ]
        matches.sort(
            key=lambda item: (
                item.get("span", {}).get("end_line", 10**12)
                - item.get("span", {}).get("start_line", 0)
            )
        )
        actual = {
            "key": expected.key,
            **{
                key: observed[key]
                for key in ("source_id", "revision", "path", "start_line", "end_line", "digest")
            },
            "source_unit": matches[0]["source_unit"],
        }
        if actual != expected.model_dump():
            raise ValueError(f"Gold Evidence does not match the Source Snapshot: {expected.key}")
    for exclusion in corpus.gold.exclusions:
        try:
            source_text(
                materialized.repositories[exclusion.source_id],
                materialized.base_revisions[exclusion.source_id],
                exclusion.path,
            )
        except ValueError as error:
            raise ValueError(f"Gold Exclusion path cannot be resolved: {exclusion.path}") from error
