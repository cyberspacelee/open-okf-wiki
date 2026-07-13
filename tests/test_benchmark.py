import json
import os
from dataclasses import replace
from functools import wraps
from pathlib import Path

import pytest
from pydantic import ValidationError

import okf_wiki.query_agent as query_agent_module
import okf_wiki.source_investigation as source_investigation_module
from okf_wiki.benchmark import (
    BenchmarkReport,
    RunObservation,
    claim_concept_membership_error_rate,
    critical_unsupported_count,
    load_benchmark_corpus,
    materialize_corpus,
    mutation_effect_applied,
    reviewed_semantic_gold,
    run_benchmark,
    source_revisions_applied,
    verify_gateway_contract_requirement,
)
from okf_wiki.benchmark_agent_eval import execute_agent_eval
from okf_wiki.cli import main
from okf_wiki.query_agent import QueryAgent
from okf_wiki.security import git_read
from okf_wiki.source_investigation import SourceInvestigationAgent


def _semantic_observation() -> RunObservation:
    return RunObservation(
        run_id="run-1",
        source_revisions={"source-1": "1" * 40},
        obligations=(),
        claims=(
            {
                "id": "claim-1",
                "subject": "Order",
                "predicate": "requires",
                "statement": "Orders require an idempotency key.",
                "modality": "must",
                "conditions": [],
                "epistemic_status": "supported",
                "evidence": [
                    {
                        "id": "evidence-1",
                        "source_id": "source-1",
                        "revision": "1" * 40,
                        "path": "requirements.md",
                        "source_unit": "unit-1",
                        "start_line": 1,
                        "end_line": 1,
                        "digest": "sha256:digest",
                        "evidence_kind": "source",
                        "authority": "normative",
                    }
                ],
                "conflicts_with": [],
                "supersedes": [],
            },
        ),
        concepts=(
            {
                "id": "concept-1",
                "canonical_name": "Order",
                "aliases": [],
                "description": "An order.",
                "status": "active",
                "defining_claim_ids": ["claim-1"],
                "supporting_claim_ids": [],
            },
        ),
        refresh={},
        review={"verification_findings": []},
        bundle_errors=(),
        major_evidence_resolved=True,
        unexplained_deletions=(),
        obligation_resolutions=(
            {
                "id": "obligation-1",
                "source": "source-1",
                "path": "requirements.md",
                "span": {"start_line": 1, "end_line": 1},
                "kind": "normative_statement",
                "priority": "major",
                "disposition": "covered",
                "reason": "Grounded.",
                "claim_ids": ["claim-1"],
                "evidence": [("source-1", "1" * 40, "requirements.md", 1, 1)],
            },
        ),
        bundle_documents={"index.md": "# Knowledge Bundle\n"},
    )


def test_versioned_corpus_materializes_exact_git_revisions_and_every_mutation(
    tmp_path: Path,
) -> None:
    corpus = load_benchmark_corpus()
    materialized = materialize_corpus(corpus, tmp_path)

    assert {item.id for item in corpus.gold.major_obligations} == {
        "obligation:2b2dc8601e33e62da6de8caa6f504f8f9d8160d018bede4036fbdaf036ab5100",
        "obligation:29c0aaa7f21bd113bc70f901c99841f1298054ee555a422bf4fc06ffec52822c",
        "obligation:390ccb25ee7507a1c5e314f6bbba8b7ccf64325e6edecd93ec72d3ee2d6e025e",
        "obligation:73e9c42c9eed68c5d9db942c24d918f75fe8867c2bfdab5abb16bfca3ab8ae9b",
        "obligation:9e23b19192efde30ebcd9a5961d4a80e7358cfed6351b38f90e571bc80e7b419",
        "obligation:a1cb8dc5bd4c753937f29e82cdd76939b36f6618f8ec7642426265e579c3d329",
        "obligation:b580f8dfc31ab73f04e30185204c31aafa4d0cfd7d4de16c20df9b739106e334",
        "obligation:eef46cc418a517e2d8d3422b3be1cba71ea814420de54ee02c8e20d9fd632bde",
    }
    assert all(
        bool(item.evidence_key) != bool(item.reason) for item in corpus.gold.major_obligations
    )
    assert set(materialized.repositories) == {"contracts", "orders", "requirements"}
    assert materialized.base_revisions == corpus.source_revisions
    assert set(materialized.mutation_revisions) == {item.id for item in corpus.mutations}
    for source_id, revision in corpus.source_revisions.items():
        repository = materialized.repositories[source_id]
        assert git_read(repository, "rev-parse", f"{revision}^{{commit}}").strip() == revision
    for mutation in corpus.mutations:
        changed_source = mutation.change.source_id
        repository = materialized.repositories[changed_source]
        revision = materialized.mutation_revisions[mutation.id][changed_source]
        assert revision == mutation.source_revisions[changed_source]
        assert git_read(repository, "rev-parse", f"{revision}^{{commit}}").strip() == revision


def test_semantic_snapshot_normalizes_only_explicit_operational_metadata() -> None:
    observation = _semantic_observation()
    excluded = {
        **observation.obligation_resolutions[0],
        "disposition": "excluded",
        "reason": "Reviewed exclusion.",
        "claim_ids": ["incremental-only-grounding"],
        "evidence": [("source-1", "2" * 40, "requirements.md", 2, 2)],
    }
    operational = {
        **observation.obligation_resolutions[0],
        "id": "refresh-only",
        "kind": "impact_reverification",
        "reason": "Refresh bookkeeping.",
    }
    left = replace(observation, obligation_resolutions=(excluded, operational))
    right = replace(
        observation,
        obligation_resolutions=(
            {**excluded, "claim_ids": []},
            {**operational, "id": "different-refresh-only"},
        ),
    )

    assert left.semantic_snapshot() == right.semantic_snapshot()
    assert left.semantic_snapshot()["obligations"] == [
        {
            **{key: value for key, value in excluded.items() if key != "id"},
            "claim_ids": [],
            "evidence": [("source-1", "<source-revision:source-1>", "requirements.md", 2, 2)],
        }
    ]
    changed_evidence = replace(
        observation,
        obligation_resolutions=({**excluded, "claim_ids": [], "evidence": []},),
    )
    assert changed_evidence.semantic_snapshot() != left.semantic_snapshot()


def test_semantic_snapshot_detects_knowledge_coverage_review_and_bundle_drift() -> None:
    observation = _semantic_observation()
    obligation = observation.obligation_resolutions[0]
    claim = observation.claims[0]
    changed = {
        "covered obligation evidence": replace(
            observation,
            obligation_resolutions=(
                {**obligation, "evidence": [("source-1", "1" * 40, "other.md", 1, 1)]},
            ),
        ),
        "exclusion": replace(
            observation,
            obligation_resolutions=(
                {**obligation, "disposition": "excluded", "reason": "Reviewed exclusion."},
            ),
        ),
        "claim conflict": replace(
            observation,
            claims=({**claim, "conflicts_with": ["claim-2"]},),
        ),
        "non-pass review finding": replace(
            observation,
            review={
                "verification_findings": [
                    {
                        "perspective": "evidence_entailment",
                        "verdict": "fail",
                        "severity": "error",
                        "rationale": "The evidence does not support the claim.",
                        "evidence": ["evidence-1"],
                    }
                ]
            },
        ),
        "rendered Bundle": replace(
            observation,
            bundle_documents={"index.md": "# Changed Knowledge Bundle\n"},
        ),
    }
    baseline = observation.semantic_snapshot()

    for name, candidate in changed.items():
        assert candidate.semantic_snapshot() != baseline, name

    pass_finding = replace(
        observation,
        review={
            "verification_findings": [
                {
                    "perspective": "evidence_entailment",
                    "verdict": "pass",
                    "severity": "info",
                    "rationale": "Verified.",
                    "evidence": ["evidence-1"],
                }
            ]
        },
    )
    assert pass_finding.semantic_snapshot() == baseline


def test_executable_benchmark_runs_real_producer_and_matches_release_fixture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    query_invocations = 0
    source_investigation_invocations = 0
    original_ask = QueryAgent.ask
    original_investigate = SourceInvestigationAgent.investigate

    async def tracked_ask(self, *args, **kwargs):
        nonlocal query_invocations
        query_invocations += 1
        return await original_ask(self, *args, **kwargs)

    async def tracked_investigate(self, *args, **kwargs):
        nonlocal source_investigation_invocations
        source_investigation_invocations += 1
        return await original_investigate(self, *args, **kwargs)

    monkeypatch.setattr(QueryAgent, "ask", tracked_ask)
    monkeypatch.setattr(SourceInvestigationAgent, "investigate", tracked_investigate)
    report = run_benchmark(workspace=tmp_path)
    expected = BenchmarkReport.model_validate_json(
        (
            Path(__file__).parents[1] / "src/okf_wiki/benchmark_corpus/v1/release-report.json"
        ).read_text(encoding="utf-8")
    )
    actual_payload = report.model_dump(mode="json")
    expected_payload = expected.model_dump(mode="json")

    assert actual_payload["costs"].pop("latency_ms") >= 0
    assert expected_payload["costs"].pop("latency_ms") >= 0
    assert actual_payload == expected_payload

    assert report.passed is True
    assert report.blocked is False
    assert report.blocking_metric is None
    assert report.executed_runs == 18
    assert report.repeated_runs == 3
    assert report.hard_gates["reviewed_major_inventory"] is True
    assert source_investigation_invocations == 2
    assert report.hard_gates["reviewed_conflicts_exclusions_data_contracts"] is True
    assert report.incremental_full_equivalent is True
    assert all(item.applied and item.equivalent and item.passed for item in report.mutations)
    assert report.security.read_only_sources is True
    assert report.security.bundle_validation is True
    assert report.agent_eval_passed is True
    assert report.agent_eval.passed is True
    assert len(report.agent_eval.semantic_judges) == 8
    assert len(report.agent_eval.human_adjudications) == 8
    assert report.role_trajectories["planner"].invocations > 0
    assert report.role_trajectories["planner"].function_tools == ()
    assert report.role_trajectories["worker"].invocations > 0
    assert report.role_trajectories["worker"].function_tools == ("read_text",)
    assert report.role_trajectories["verifier"].invocations > 0
    assert report.role_trajectories["verifier"].function_tools == ()
    assert report.role_trajectories["renderer"].invocations == 1
    assert report.role_trajectories["renderer"].function_tools == ()
    assert report.role_trajectories["query"].invocations == 2
    assert query_invocations == 2
    assert report.role_trajectories["query"].function_tools == (
        "get_claim",
        "read_evidence",
        "renderable_claims",
    )
    assert report.role_trajectories["source_investigation"].invocations == 2
    assert report.role_trajectories["source_investigation"].function_tools == ("read_text",)
    assert report.gateway.live is False
    assert report.gateway.status == "not_required"
    assert report.costs.tokens >= 0
    assert report.costs.tool_calls > 0
    assert report.costs.worker_candidates == report.role_trajectories["worker"].invocations
    assert report.costs.sources == ("production_worker_audit", "agent_eval_worker_audit")
    assert report.costs.aggregation == "sum"
    assert report.costs.human_reviews == 18
    assert report.versions.model == "function-model-v1"
    assert report.versions.prompt == "benchmark-semantic-v1"
    assert report.versions.tool_schema == "git-snapshot-v1"
    assert report.versions.gateway_capability_tests == "gateway-contract-v1"


def test_agent_eval_blocks_when_query_agent_execution_breaks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    corpus = load_benchmark_corpus()
    materialized = materialize_corpus(corpus, tmp_path / "repositories")

    async def broken_ask(*_args, **_kwargs):
        raise RuntimeError("broken Query Agent")

    monkeypatch.setattr(QueryAgent, "ask", broken_ask)

    execution = execute_agent_eval(corpus, materialized, tmp_path, "function-model-v1")

    assert execution.report.blocked is True
    assert {
        "query:grounded-answer:trajectory:missing_trajectory",
        "query:prompt-injection-refusal:trajectory:missing_trajectory",
    } <= set(execution.report.failures)


def test_agent_eval_blocks_when_source_investigation_agent_execution_breaks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    corpus = load_benchmark_corpus()
    materialized = materialize_corpus(corpus, tmp_path / "repositories")

    async def broken_investigation(*_args, **_kwargs):
        raise RuntimeError("broken Source Investigation Agent")

    monkeypatch.setattr(SourceInvestigationAgent, "investigate", broken_investigation)

    execution = execute_agent_eval(corpus, materialized, tmp_path, "function-model-v1")

    assert execution.report.blocked is True
    assert {
        "source_investigation:grounded-provisional-answer:trajectory:missing_trajectory",
        "source_investigation:prompt-injection-mutation-refusal:trajectory:missing_trajectory",
        "source_investigation:grounded-provisional-answer:citation_completeness",
        "source_investigation:prompt-injection-mutation-refusal:read_only_authority",
    } <= set(execution.report.failures)


def test_agent_eval_blocks_when_source_investigation_safety_instructions_are_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    corpus = load_benchmark_corpus()
    materialized = materialize_corpus(corpus, tmp_path / "repositories")
    monkeypatch.setattr(
        source_investigation_module,
        "INVESTIGATION_INSTRUCTIONS",
        "",
    )

    execution = execute_agent_eval(corpus, materialized, tmp_path, "function-model-v1")

    assert execution.report.blocked is True
    assert {
        "source_investigation:prompt-injection-mutation-refusal:refusal_quality",
        "source_investigation:prompt-injection-mutation-refusal:prompt_injection_resistance",
    } <= set(execution.report.failures)


def test_agent_eval_blocks_when_prompt_injection_expands_query_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    corpus = load_benchmark_corpus()
    materialized = materialize_corpus(corpus, tmp_path / "repositories")
    original_get_claim = query_agent_module.get_claim

    @wraps(original_get_claim)
    async def unsafe_get_claim(ctx, claim_id):
        ctx.deps.claim_ids.add(claim_id)
        return await original_get_claim(ctx, claim_id)

    monkeypatch.setattr(query_agent_module, "get_claim", unsafe_get_claim)

    execution = execute_agent_eval(corpus, materialized, tmp_path, "function-model-v1")

    assert execution.report.blocked is True
    assert {
        "query:prompt-injection-refusal:refusal_quality",
        "query:prompt-injection-refusal:scope",
    } <= set(execution.report.failures)


def test_benchmark_report_rejects_incomplete_incremental_equivalence() -> None:
    path = Path(__file__).parents[1] / "src/okf_wiki/benchmark_corpus/v1/release-report.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["mutations"][0]["equivalent"] = False

    with pytest.raises(ValidationError, match="incremental_full_equivalent"):
        BenchmarkReport.model_validate(payload)


def test_mutation_requires_both_incremental_and_full_source_revisions() -> None:
    observation = _semantic_observation()
    expected = observation.source_revisions
    wrong_full = replace(observation, source_revisions={"source-1": "2" * 40})

    assert source_revisions_applied(expected, observation, wrong_full) is False


def test_mutation_effect_rejects_identically_wrong_incremental_and_full_results() -> None:
    mutation = next(
        item for item in load_benchmark_corpus().mutations if item.kind == "new_requirement"
    )
    unchanged = _semantic_observation()

    assert mutation_effect_applied(mutation, unchanged, unchanged, unchanged) is False


def test_permission_change_compares_the_complete_semantic_snapshot() -> None:
    mutation = next(
        item for item in load_benchmark_corpus().mutations if item.kind == "permission_change"
    )
    baseline = _semantic_observation()
    bundle_drift = replace(baseline, bundle_documents={"index.md": "# Wrong Bundle\n"})

    assert mutation_effect_applied(mutation, baseline, bundle_drift, bundle_drift) is False


def test_large_dto_requires_claim_membership_in_the_aggregated_data_contract() -> None:
    mutation = next(item for item in load_benchmark_corpus().mutations if item.kind == "large_dto")
    baseline = _semantic_observation()
    claim = baseline.claims[0]
    assert mutation.expected.effect == "data_contract_added"
    membership = mutation.expected.concept_membership
    ungrouped = replace(
        baseline,
        claims=(
            *baseline.claims,
            {**claim, "id": "claim-export", "statement": membership.claim_statement},
        ),
    )

    assert mutation_effect_applied(mutation, baseline, ungrouped, ungrouped) is False


def test_reviewed_exclusion_requires_exact_rationale_locator_and_status() -> None:
    observation = _semantic_observation()
    exclusion = load_benchmark_corpus().gold.exclusions[0]
    claim = observation.claims[0]
    evidence = claim["evidence"][0]
    gold = load_benchmark_corpus().gold.model_copy(update={"conflicts": (), "data_contracts": ()})
    disputed = {
        **claim,
        "conditions": ["Different rationale."],
        "epistemic_status": "disputed",
        "evidence": [
            {
                **evidence,
                "source_id": exclusion.source_id,
                "path": exclusion.path,
            }
        ],
    }

    assert reviewed_semantic_gold(replace(observation, claims=(disputed,)), gold) is False
    assert (
        reviewed_semantic_gold(
            replace(
                observation,
                claims=({**disputed, "conditions": [exclusion.reason]},),
            ),
            gold,
        )
        is True
    )


def test_semantic_metrics_detect_equal_count_wrong_membership() -> None:
    expected = {("Order", "claim-a"), ("Status", "claim-b")}
    observed = {("Order", "claim-b"), ("Status", "claim-a")}

    assert claim_concept_membership_error_rate(observed, expected) == 1.0


def test_critical_unsupported_counts_observed_failures_not_missing_gold() -> None:
    claim = _semantic_observation().claims[0]

    assert critical_unsupported_count((), {"missing critical"}, {"missing critical"}) == 0
    assert (
        critical_unsupported_count(
            ({**claim, "statement": "unexpected critical", "evidence": []},),
            {"unexpected critical"},
            {"missing critical"},
        )
        == 1
    )
    assert (
        critical_unsupported_count(
            ({**claim, "statement": "reviewed conflict", "epistemic_status": "disputed"},),
            {"reviewed conflict"},
            {"reviewed conflict"},
        )
        == 0
    )


def test_pydantic_ai_change_requires_command_verified_live_gateway(monkeypatch) -> None:
    monkeypatch.delenv("OKF_GATEWAY_BASE_URL", raising=False)
    monkeypatch.delenv("OKF_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("OKF_GATEWAY_MODEL", raising=False)

    status = verify_gateway_contract_requirement("2.9.0", "2.8.0")

    assert status.live is False
    assert status.passed is False
    assert status.status == "required_credentials_unavailable"


def test_benchmark_cli_executes_release_manifest(tmp_path: Path, monkeypatch, capsys) -> None:
    manifest = Path(__file__).parents[1] / "src/okf_wiki/benchmark_corpus/v1/release-manifest.json"
    called = []
    monkeypatch.setattr("okf_wiki.cli.benchmark", lambda path: called.append(path) or 0)
    monkeypatch.setattr("sys.argv", ["okf-wiki", "benchmark", str(manifest)])

    assert main() == 0
    assert called == [str(manifest)]
    assert os.environ.get("OKF_GATEWAY_API_KEY") is None
    assert capsys.readouterr().out == ""
