import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path

from okf_wiki.accepted_knowledge import AcceptedKnowledgeStore, evidence_record_id
from okf_wiki.knowledge_contracts import WorkerProposal, WorkerRunResult
from okf_wiki.review import evidence_excerpt, review_snapshot
from okf_wiki.state_schema import migrate_state
from okf_wiki.verification import VerificationFinding, VerificationStore


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def ledger(tmp_path: Path) -> dict:
    repository = tmp_path / "source"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "fixture@example.test")
    git(repository, "config", "user.name", "Fixture")
    (repository / "README.md").write_text("# Knowledge\nShared detail\nBase version\n")
    git(repository, "add", "README.md")
    git(repository, "commit", "-m", "base")
    base_revision = git(repository, "rev-parse", "HEAD")
    (repository / "README.md").write_text("# Knowledge\nShared detail\nCurrent version\n")
    git(repository, "add", "README.md")
    git(repository, "commit", "-m", "current")
    current_revision = git(repository, "rev-parse", "HEAD")
    database = tmp_path / "runs.db"
    with sqlite3.connect(database) as connection:
        migrate_state(connection)
    return {
        "base_revision": base_revision,
        "current_revision": current_revision,
        "database": database,
        "publish_dir": tmp_path / "published",
        "repository": repository,
        "staging_root": tmp_path / "staging",
    }


def source_unit(revision: str) -> dict:
    return {
        "path": "README.md",
        "revision": revision,
        "source_id": "code",
        "source_unit": "file:README.md",
        "source_unit_kind": "file",
    }


def add_run(
    context: dict,
    run_id: str,
    revision: str,
    obligations: list[str],
    *,
    base_run_id: str | None = None,
) -> None:
    staging = context["staging_root"] / run_id
    staging.mkdir(parents=True)
    source_set = {
        "base_run_id": base_run_id,
        "digest": hashlib.sha256(run_id.encode()).hexdigest(),
        "source_universe": [source_unit(revision)],
        "sources": [
            {
                "id": "code",
                "repository": str(context["repository"]),
                "revision": revision,
                "role": "implementation",
            }
        ],
    }
    with sqlite3.connect(context["database"]) as connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                coverage_json, error, created_at, updated_at, source_set_json)
               VALUES (?, 'catalog', ?, ?, ?, ?, 'exploring', ?, NULL,
                       '2026-07-13T00:00:00+00:00', '2026-07-13T00:00:00+00:00', ?)""",
            (
                run_id,
                str(context["repository"]),
                revision,
                str(context["publish_dir"]),
                str(staging),
                json.dumps({"total": len(obligations)}),
                json.dumps(source_set, sort_keys=True),
            ),
        )
        connection.executemany(
            """INSERT INTO coverage_obligations
               (id, run_id, source, role, path, source_unit, kind, priority,
                disposition, reason, span, text)
               VALUES (?, ?, 'code', 'implementation', 'README.md', 'file:README.md',
                       'normative_statement', 'major', 'open', NULL,
                       '{"start_line":1,"end_line":3}', ?)""",
            [(obligation_id, run_id, obligation_id) for obligation_id in obligations],
        )


def accepted_candidate(
    candidate_id: str,
    revision: str,
    claims: list[dict],
    concepts: list[dict],
    dispositions: list[dict],
    *,
    extra_evidence: bool = False,
) -> WorkerRunResult:
    line_one_digest = f"sha256:{hashlib.sha256(b'# Knowledge').hexdigest()}"
    evidence = [
        {
            "id": f"evidence:{claim['id']}",
            "source_id": "code",
            "path": "README.md",
            "revision": revision,
            "start_line": 1,
            "end_line": 1,
            "digest": line_one_digest,
        }
        for claim in claims
    ]
    if extra_evidence:
        evidence.append(
            {
                "id": "evidence:unclaimed",
                "source_id": "code",
                "path": "README.md",
                "revision": revision,
                "start_line": 2,
                "end_line": 2,
                "digest": f"sha256:{hashlib.sha256(b'Shared detail').hexdigest()}",
            }
        )
    proposal = WorkerProposal.model_validate(
        {
            "task_id": f"task:{candidate_id}",
            "obligation_ids": [item["obligation_id"] for item in dispositions],
            "evidence": evidence,
            "claims": [
                {
                    "id": claim["id"],
                    "text": claim["text"],
                    "epistemic_status": claim.get("status", "supported"),
                    "supersedes": claim.get("supersedes", []),
                    "evidence_ids": [f"evidence:{claim['id']}"],
                }
                for claim in claims
            ],
            "concepts": [
                {
                    "id": concept["id"],
                    "name": concept["name"],
                    "description": concept["name"],
                    "claim_ids": concept["defining"],
                    "defining_claim_ids": concept["defining"],
                    "status": concept.get("status", "active"),
                }
                for concept in concepts
            ],
            "relations": [],
            "dispositions": [
                {
                    "obligation_id": item["obligation_id"],
                    "disposition": item.get("disposition", "covered"),
                    "reason": item.get("reason", "Accepted for the Review fixture."),
                    "evidence_ids": [f"evidence:{item['evidence_claim']}"],
                }
                for item in dispositions
            ],
        }
    )
    return WorkerRunResult(
        status="accepted",
        candidate_id=candidate_id,
        proposal=proposal,
        errors=[],
    )


def claim(claim_id: str, text: str, *, supersedes: list[str] | None = None) -> dict:
    return {"id": claim_id, "text": text, "supersedes": supersedes or []}


def concept(concept_id: str, name: str, *defining: str) -> dict:
    return {"id": concept_id, "name": name, "defining": list(defining)}


def disposition(
    obligation_id: str,
    evidence_claim: str,
    *,
    value: str = "covered",
) -> dict:
    return {
        "obligation_id": obligation_id,
        "evidence_claim": evidence_claim,
        "disposition": value,
    }


def clone_refresh(
    context: dict,
    base_obligations: list[str],
    current_obligations: list[str],
    *,
    stale_claim_ids: set[str] | None = None,
    stale_concept_ids: set[str] | None = None,
) -> None:
    add_run(
        context,
        "current",
        context["current_revision"],
        current_obligations,
        base_run_id="base",
    )
    store = AcceptedKnowledgeStore(context["database"])
    with sqlite3.connect(context["database"]) as connection:
        connection.row_factory = sqlite3.Row
        store.clone_for_refresh(
            connection,
            "base",
            "current",
            previous_units={"file:README.md": source_unit(context["base_revision"])},
            current_units={"file:README.md": source_unit(context["current_revision"])},
            relocations={"file:README.md": "file:README.md"},
            stale_claim_ids=stale_claim_ids or set(),
            stale_concept_ids=stale_concept_ids or set(),
            obligation_ids={item: item for item in base_obligations},
        )


def finish_review(context: dict) -> dict:
    with sqlite3.connect(context["database"]) as connection:
        connection.execute("UPDATE runs SET state = 'published' WHERE id = 'base'")
        connection.execute("UPDATE runs SET state = 'review_required' WHERE id = 'current'")
    return review_snapshot(context["database"], "current")


def ids(snapshot: dict, kind: str, bucket: str) -> set[str]:
    return {item["id"] for item in snapshot["knowledge_changes"][kind][bucket]}


def test_unchanged_refresh_does_not_reclassify_inherited_merge_or_split_relations(
    tmp_path: Path,
) -> None:
    context = ledger(tmp_path)
    obligations = ["old-a", "old-b", "old-split", "inherited-merge", "inherited-1", "inherited-2"]
    add_run(context, "base", context["base_revision"], obligations)
    store = AcceptedKnowledgeStore(context["database"])
    base_claims = [
        claim("old-a", "Old A"),
        claim("old-b", "Old B"),
        claim("old-split", "Old split"),
        claim("inherited-merge", "Inherited merge", supersedes=["old-a", "old-b"]),
        claim("inherited-1", "Inherited one", supersedes=["old-split"]),
        claim("inherited-2", "Inherited two", supersedes=["old-split"]),
    ]
    store.accept(
        "base",
        accepted_candidate(
            "base-candidate",
            context["base_revision"],
            base_claims,
            [
                concept("concept-a", "Concept A", "old-a"),
                concept("concept-overlap", "Concept Overlap", "old-a", "old-b"),
            ],
            [disposition(item["id"], item["id"]) for item in base_claims],
        ),
    )
    clone_refresh(context, obligations, obligations)

    snapshot = finish_review(context)

    assert ids(snapshot, "claims", "merged") == set()
    assert ids(snapshot, "claims", "split") == set()
    assert ids(snapshot, "concepts", "merged") == set()
    assert ids(snapshot, "concepts", "split") == set()
    assert ids(snapshot, "claims", "removed") == set()
    assert ids(snapshot, "concepts", "removed") == set()


def test_real_supersession_classifies_new_merge_split_and_retired_knowledge(
    tmp_path: Path,
) -> None:
    context = ledger(tmp_path)
    base_obligations = ["old-a", "old-b", "old-c", "old-d", "old-split"]
    current_obligations = [
        *base_obligations,
        "new-merge",
        "new-c",
        "new-d",
        "new-split-1",
        "new-split-2",
    ]
    add_run(context, "base", context["base_revision"], base_obligations)
    store = AcceptedKnowledgeStore(context["database"])
    base_claims = [
        claim("old-a", "Old A"),
        claim("old-b", "Old B"),
        claim("old-c", "Old C"),
        claim("old-d", "Old D"),
        claim("old-split", "Old split"),
    ]
    store.accept(
        "base",
        accepted_candidate(
            "base-candidate",
            context["base_revision"],
            base_claims,
            [
                concept("base-a", "Base A", "old-a"),
                concept("base-b", "Base B", "old-b"),
                concept("base-split", "Base Split", "old-c", "old-d"),
            ],
            [disposition(item["id"], item["id"]) for item in base_claims],
        ),
    )
    base_by_statement = {item["statement"]: item["id"] for item in store.list_claims("base")}
    clone_refresh(context, base_obligations, current_obligations)
    current_claims = [
        claim("old-a-copy", "Old A"),
        claim("old-b-copy", "Old B"),
        claim("old-c-copy", "Old C"),
        claim("old-d-copy", "Old D"),
        claim(
            "new-merge",
            "Merged replacement",
            supersedes=[base_by_statement["Old A"], base_by_statement["Old B"]],
        ),
        claim("new-c", "C replacement", supersedes=[base_by_statement["Old C"]]),
        claim("new-d", "D replacement", supersedes=[base_by_statement["Old D"]]),
        claim(
            "new-split-1",
            "Split replacement one",
            supersedes=[base_by_statement["Old split"]],
        ),
        claim(
            "new-split-2",
            "Split replacement two",
            supersedes=[base_by_statement["Old split"]],
        ),
    ]
    store.accept(
        "current",
        accepted_candidate(
            "replacement-candidate",
            context["current_revision"],
            current_claims,
            [
                concept("merged-concept", "Merged Concept", "old-a-copy", "old-b-copy"),
                concept("split-concept-c", "Split Concept C", "old-c-copy", "new-c"),
                concept("split-concept-d", "Split Concept D", "old-d-copy", "new-d"),
            ],
            [
                disposition("old-a", "old-a-copy"),
                disposition("old-b", "old-b-copy"),
                disposition("old-c", "old-c-copy"),
                disposition("old-d", "old-d-copy"),
                disposition("new-merge", "new-merge"),
                disposition("new-c", "new-c"),
                disposition("new-d", "new-d"),
                disposition("new-split-1", "new-split-1"),
                disposition("new-split-2", "new-split-2"),
            ],
        ),
    )
    current_by_statement = {item["statement"]: item["id"] for item in store.list_claims("current")}
    current_concepts = {
        item["canonical_name"]: item["id"] for item in store.list_concepts("current")
    }
    base_concepts = {item["canonical_name"]: item["id"] for item in store.list_concepts("base")}

    snapshot = finish_review(context)

    assert ids(snapshot, "claims", "merged") == {current_by_statement["Merged replacement"]}
    assert ids(snapshot, "claims", "split") == {
        current_by_statement["Split replacement one"],
        current_by_statement["Split replacement two"],
    }
    assert ids(snapshot, "claims", "removed") >= {
        base_by_statement["Old A"],
        base_by_statement["Old B"],
        base_by_statement["Old C"],
        base_by_statement["Old D"],
        base_by_statement["Old split"],
    }
    assert ids(snapshot, "concepts", "merged") == {current_concepts["Merged Concept"]}
    assert ids(snapshot, "concepts", "split") == {
        current_concepts["Split Concept C"],
        current_concepts["Split Concept D"],
    }
    assert ids(snapshot, "concepts", "removed") >= {
        base_concepts["Base A"],
        base_concepts["Base B"],
        base_concepts["Base Split"],
    }
    for kind in ("claims", "concepts"):
        grouped_ids = [
            item["id"] for items in snapshot["knowledge_changes"][kind].values() for item in items
        ]
        assert len(grouped_ids) == len(set(grouped_ids))


def test_real_exclusion_overrides_stale_for_claim_and_concept(tmp_path: Path) -> None:
    context = ledger(tmp_path)
    base_obligations = ["excluded"]
    current_obligations = ["excluded", "control"]
    add_run(context, "base", context["base_revision"], base_obligations)
    store = AcceptedKnowledgeStore(context["database"])
    receipt = store.accept(
        "base",
        accepted_candidate(
            "base-candidate",
            context["base_revision"],
            [claim("excluded", "Explicitly excluded knowledge")],
            [concept("excluded-concept", "Excluded Concept", "excluded")],
            [disposition("excluded", "excluded")],
        ),
    )
    clone_refresh(
        context,
        base_obligations,
        current_obligations,
        stale_claim_ids=set(receipt.claim_ids),
        stale_concept_ids=set(receipt.concept_ids),
    )
    store.accept(
        "current",
        accepted_candidate(
            "exclusion-candidate",
            context["current_revision"],
            [claim("control", "Control knowledge")],
            [concept("control-concept", "Control Concept", "control")],
            [
                disposition("control", "control"),
                disposition("excluded", "control", value="excluded"),
            ],
        ),
    )

    snapshot = finish_review(context)

    assert ids(snapshot, "claims", "excluded") == set(receipt.claim_ids)
    assert ids(snapshot, "concepts", "excluded") == set(receipt.concept_ids)
    assert not (set(receipt.claim_ids) & ids(snapshot, "claims", "stale"))
    assert not (set(receipt.concept_ids) & ids(snapshot, "concepts", "stale"))


def test_review_snapshot_uses_all_accepted_evidence_and_opens_it_by_id(tmp_path: Path) -> None:
    context = ledger(tmp_path)
    base_obligations = ["base"]
    current_obligations = ["base", "current"]
    add_run(context, "base", context["base_revision"], base_obligations)
    store = AcceptedKnowledgeStore(context["database"])
    store.accept(
        "base",
        accepted_candidate(
            "base-candidate",
            context["base_revision"],
            [claim("base", "Base knowledge")],
            [concept("base-concept", "Base Concept", "base")],
            [disposition("base", "base")],
            extra_evidence=True,
        ),
    )
    clone_refresh(context, base_obligations, current_obligations)
    store.accept(
        "current",
        accepted_candidate(
            "current-candidate",
            context["current_revision"],
            [claim("current", "Current knowledge")],
            [concept("current-concept", "Current Concept", "current")],
            [disposition("current", "current")],
            extra_evidence=True,
        ),
    )
    digest = f"sha256:{hashlib.sha256(b'Shared detail').hexdigest()}"
    base_evidence_id = evidence_record_id(
        source_id="code",
        revision=context["base_revision"],
        path="README.md",
        source_unit="file:README.md",
        start_line=2,
        end_line=2,
        digest=digest,
        evidence_kind="source_span",
        authority="source_snapshot",
    )
    current_evidence_id = evidence_record_id(
        source_id="code",
        revision=context["current_revision"],
        path="README.md",
        source_unit="file:README.md",
        start_line=2,
        end_line=2,
        digest=digest,
        evidence_kind="source_span",
        authority="source_snapshot",
    )
    verification = VerificationStore(context["database"])
    verification.stage(
        "current",
        "candidate-unclaimed-evidence",
        "task-unclaimed-evidence",
        {
            "evidence": [
                {
                    "id": "proposal-evidence",
                    "source_id": "code",
                    "revision": context["current_revision"],
                    "path": "README.md",
                    "start_line": 2,
                    "end_line": 2,
                    "digest": digest,
                }
            ]
        },
    )
    verification.record_findings(
        "current",
        "candidate-unclaimed-evidence",
        (
            VerificationFinding(
                target_id="candidate-unclaimed-evidence",
                perspective="evidence_entailment",
                verdict="pass",
                severity="info",
                evidence=("proposal-evidence",),
                rationale="The accepted Evidence Reference is fixed-revision data.",
            ),
        ),
    )

    snapshot = finish_review(context)
    finding = next(
        item
        for item in snapshot["verification_findings"]
        if item["candidate_id"] == "candidate-unclaimed-evidence"
    )

    assert {item["id"] for item in snapshot["evidence_references"]} >= {
        base_evidence_id,
        current_evidence_id,
    }
    assert finding["evidence_reference_ids"] == [current_evidence_id]
    assert evidence_excerpt(context["database"], "current", base_evidence_id)["text"] == (
        "Shared detail"
    )
    assert evidence_excerpt(context["database"], "current", current_evidence_id)["text"] == (
        "Shared detail"
    )
