from okf_wiki.impact_graph import (
    KnowledgeImpactGraph,
    diff_source_units,
    plan_refresh,
)


def unit(unit_id: str, path: str, digest: str) -> dict:
    return {
        "content_digest": digest,
        "path": path,
        "revision": "a" * 40,
        "source_id": "implementation",
        "source_unit": unit_id,
        "source_unit_kind": "file",
    }


def test_revision_diff_relocates_moves_and_graph_finds_downstream_impact() -> None:
    previous = [
        unit("unit:moved-old", "old.md", "same"),
        unit("unit:changed-old", "changed.md", "before"),
    ]
    current = [
        unit("unit:moved-new", "new.md", "same"),
        unit("unit:changed-new", "changed.md", "after"),
    ]

    diff = diff_source_units(previous, current)

    assert [(change.before.path, change.after.path) for change in diff.moved] == [
        ("old.md", "new.md")
    ]
    assert [(change.before.id, change.after.id) for change in diff.changed] == [
        ("unit:changed-old", "unit:changed-new")
    ]
    assert diff.relocations == {"unit:moved-old": "unit:moved-new"}
    assert len(diff.by_source()["implementation"]["moved"]) == 1
    graph = KnowledgeImpactGraph.from_records(
        source_units=previous,
        evidence=[
            {
                "id": "evidence:1",
                "source_id": "implementation",
                "revision": "a" * 40,
                "path": "changed.md",
                "source_unit": "unit:changed-old",
                "start_line": 1,
                "end_line": 1,
                "digest": "sha256:before",
                "evidence_kind": "source_span",
                "authority": "source_snapshot",
            }
        ],
        claims=[
            {
                "id": "claim:1",
                "subject": "source",
                "predicate": "states",
                "statement": "Changed knowledge.",
                "modality": "asserted",
                "conditions": [],
                "epistemic_status": "supported",
                "evidence": [
                    {
                        "id": "evidence:1",
                        "source_id": "implementation",
                        "revision": "a" * 40,
                        "path": "changed.md",
                        "source_unit": "unit:changed-old",
                        "start_line": 1,
                        "end_line": 1,
                        "digest": "sha256:before",
                        "evidence_kind": "source_span",
                        "authority": "source_snapshot",
                    }
                ],
                "conflicts_with": [],
                "supersedes": [],
            }
        ],
        concepts=[
            {
                "id": "concept:1",
                "canonical_name": "One",
                "aliases": [],
                "description": "One concept.",
                "status": "active",
                "defining_claim_ids": ["claim:1"],
                "supporting_claim_ids": [],
            }
        ],
        pages=[{"concept_id": "concept:1", "path": "concepts/one.md"}],
    )

    assert graph.downstream({"unit:changed-old"}).as_dict() == {
        "source_units": ["unit:changed-old"],
        "evidence": ["evidence:1"],
        "claims": ["claim:1"],
        "concepts": ["concept:1"],
        "pages": ["concepts/one.md"],
    }

    plan = plan_refresh(diff, graph)
    assert plan.as_dict() == {
        "mode": "incremental",
        "fallback_reason": None,
        "new_source_units": [],
        "reverify_claims": ["claim:1"],
        "reverify_concepts": ["concept:1"],
        "rerender_pages": ["concepts/one.md"],
        "relocations": {"unit:moved-old": "unit:moved-new"},
    }


def test_refresh_falls_back_when_relocation_is_ambiguous() -> None:
    previous = [unit("old:1", "one.md", "same"), unit("old:2", "two.md", "same")]
    current = [unit("new:1", "three.md", "same"), unit("new:2", "four.md", "same")]

    diff = diff_source_units(previous, current)

    assert diff.full_analysis is True
    assert diff.fallback_reason == "Source Unit relocation is ambiguous"
