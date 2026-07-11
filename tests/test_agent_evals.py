import json
import sqlite3
import sys
from pathlib import Path
from typing import cast

from okf_wiki.agent_evals import (
    GATED_CHANGE_KINDS,
    ROLE_METRICS,
    ReleaseEvalManifest,
    evaluate_release,
    evaluate_role,
    evaluate_trajectory,
    load_role_dataset,
)
from okf_wiki.cli import main


def test_versioned_pydantic_eval_datasets_cover_every_agent_role_metric() -> None:
    for role, metrics in ROLE_METRICS.items():
        dataset = load_role_dataset(role)

        assert dataset.name == f"{role}-v1"
        assert dataset.cases
        metadata = cast(dict[str, object], dataset.cases[0].metadata)
        assert set(cast(dict[str, object], metadata["thresholds"])) == set(metrics)


def test_trajectory_eval_detects_every_declared_failure_mode() -> None:
    events = [
        {
            "event": "call",
            "tool": "search_text",
            "tool_call_id": "s1",
            "args": {"query": "missing"},
        },
        {"event": "return", "tool": "search_text", "tool_call_id": "s1", "result_empty": True},
        {
            "event": "call",
            "tool": "search_text",
            "tool_call_id": "s2",
            "args": {"query": "missing"},
        },
        {"event": "return", "tool": "search_text", "tool_call_id": "s2", "result_empty": True},
        {
            "event": "call",
            "tool": "read_text",
            "tool_call_id": "d1",
            "args": {"path": "src/dto/OrderRequest.java"},
        },
        {
            "event": "call",
            "tool": "read_text",
            "tool_call_id": "d2",
            "args": {"path": "src/dto/OrderResponse.java"},
        },
        {
            "event": "call",
            "tool": "read_text",
            "tool_call_id": "d3",
            "args": {"path": "src/dto/OrderPayload.java"},
        },
        {"event": "call", "tool": "shell", "tool_call_id": "x1", "args": {}},
        {"event": "retry", "tool": "read_text", "tool_call_id": "r1"},
        {"event": "retry", "tool": "read_text", "tool_call_id": "r2"},
        {"event": "retry", "tool": "read_text", "tool_call_id": "r3", "scope_violation": True},
    ]

    detected = evaluate_trajectory(
        events,
        allowed_tools=("list_paths", "search_text", "read_text"),
        allowed_paths=("src/Order.java",),
        tool_calls_limit=6,
    )

    assert set(detected) == {
        "repeated_low_value_search",
        "excessive_dto_attention",
        "needless_tools",
        "retry_loops",
        "scope_violations",
        "budget_waste",
    }


def test_planner_eval_measures_bounded_prioritized_non_overlapping_tasks() -> None:
    output = {
        "tasks": [
            {
                "obligation_ids": ["major-1", "supporting-1"],
                "source_id": "source-1",
                "allowed_paths": ["src/Order.java", "README.md"],
                "agent_role": "extraction",
                "allowed_tools": ["list_paths", "search_text", "read_text"],
                "prompt": "Extract the assigned obligations.",
                "budgets": {
                    "request_limit": 8,
                    "tool_calls_limit": 20,
                    "input_tokens_limit": 50000,
                    "output_tokens_limit": 8000,
                    "total_tokens_limit": 60000,
                    "wall_time_seconds": 60,
                    "tool_timeout_seconds": 15,
                },
            }
        ]
    }

    metrics = evaluate_role("planner", "bounded-priority-plan", output)

    assert metrics == {metric: 1.0 for metric in ROLE_METRICS["planner"]}
    assert (
        evaluate_role("planner", "bounded-priority-plan", {"tasks": []})["valid_bounded_tasks"] == 0
    )


def test_worker_eval_measures_grounded_atomic_data_contract_output(tmp_path) -> None:
    output = json.loads(
        (Path(__file__).parents[1] / "src/okf_wiki/benchmark_corpus/v1/worker-eval.json").read_text(
            encoding="utf-8"
        )
    )

    metrics = evaluate_role("worker", "grounded-data-contract", output)

    assert metrics == {metric: 1.0 for metric in ROLE_METRICS["worker"]}
    audit = tmp_path / "worker.db"
    with sqlite3.connect(audit) as connection:
        connection.execute(
            """CREATE TABLE worker_candidates (
                id TEXT PRIMARY KEY, status TEXT NOT NULL,
                proposal_json TEXT, trajectory_json TEXT NOT NULL
            )"""
        )
        connection.execute(
            "INSERT INTO worker_candidates VALUES (?, 'accepted', ?, ?)",
            (
                "candidate-1",
                json.dumps(output, sort_keys=True),
                json.dumps(
                    [
                        {
                            "event": "call",
                            "tool": "read_text",
                            "tool_call_id": "read-1",
                            "args": {"path": "src/main/java/example/CreateOrderRequest.java"},
                        },
                        {
                            "event": "return",
                            "tool": "read_text",
                            "tool_call_id": "read-1",
                            "result_empty": False,
                        },
                    ]
                ),
            ),
        )
    manifest = ReleaseEvalManifest.model_validate(
        {
            "change_kinds": ["prompt"],
            "versions": {
                "model": "model-v1",
                "prompt": "prompt-v1",
                "tool_schema": "tools-v1",
                "workflow": "workflow-v1",
            },
            "worker_audit_path": str(audit),
            "cost_usd": 0,
            "latency_ms": 1,
            "semantic_judges": [],
            "human_adjudications": [],
            "results": [
                {
                    "role": "worker",
                    "case": "grounded-data-contract",
                    "candidate_id": "candidate-1",
                    "output": output,
                }
            ],
        }
    )
    report = evaluate_release(manifest)
    assert not any(
        failure.startswith("worker:grounded-data-contract:trajectory:")
        for failure in report.trajectory_failures
    )
    missing_audit = manifest.model_copy(
        update={"worker_audit_path": tmp_path / "missing-worker.db"}
    )
    assert (
        "worker:grounded-data-contract:trajectory:missing_audit"
        in evaluate_release(missing_audit).trajectory_failures
    )
    missing_candidate = manifest.model_copy(
        update={"results": (manifest.results[0].model_copy(update={"candidate_id": "missing"}),)}
    )
    assert (
        "worker:grounded-data-contract:trajectory:missing_candidate"
        in evaluate_release(missing_candidate).trajectory_failures
    )
    with sqlite3.connect(audit) as connection:
        connection.execute(
            "UPDATE worker_candidates SET trajectory_json = '[]' WHERE id = 'candidate-1'"
        )
    assert (
        "worker:grounded-data-contract:trajectory:missing_trajectory"
        in evaluate_release(manifest).trajectory_failures
    )
    output["claims"][0]["text"] = "Order payload is always valid and never fails."
    assert evaluate_role("worker", "grounded-data-contract", output)["unsupported_output"] == 0


def test_verifier_eval_measures_recall_false_positives_and_independent_reading() -> None:
    output = {
        "findings": [
            {
                "target_id": "claim-critical",
                "verdict": "fail",
                "severity": "critical",
                "evidence": ["evidence-semantic"],
            },
            {
                "target_id": "claim-semantic",
                "verdict": "fail",
                "severity": "error",
                "evidence": ["evidence-semantic"],
            },
        ]
    }

    metrics = evaluate_role("verifier", "independent-critical-review", output)

    assert metrics == {
        "critical_issue_recall": 1.0,
        "semantic_issue_recall": 1.0,
        "false_positive_rate": 0.0,
        "independent_evidence_reading": 1.0,
    }
    output["findings"][0]["evidence"] = ["invented:reference"]
    assert (
        evaluate_role("verifier", "independent-critical-review", output)[
            "independent_evidence_reading"
        ]
        == 0
    )
    output["findings"][0]["evidence"] = ["evidence-semantic"]
    output["findings"] = output["findings"][1:]
    assert (
        evaluate_role("verifier", "independent-critical-review", output)["critical_issue_recall"]
        == 0
    )


def test_renderer_eval_measures_grounding_conflicts_duplication_and_readability() -> None:
    output = {
        "pages": {
            "concepts/order.md": (
                "# Order payload\n\n"
                "An order payload requires an identifier when creating an order.\n\n"
                "<!-- claims: claim-a -->\n"
            )
        },
        "claim_ids_by_page": {"concepts/order.md": ["claim-a"]},
    }

    metrics = evaluate_role("renderer", "grounded-readable-concept", output)

    assert metrics == {metric: 1.0 for metric in ROLE_METRICS["renderer"]}
    output["pages"]["concepts/conflict.md"] = (
        "# Conflicting claim\n\nA conflicting statement.\n\n<!-- claims: claim-b -->\n"
    )
    output["claim_ids_by_page"]["concepts/conflict.md"] = ["claim-b"]
    assert evaluate_role("renderer", "grounded-readable-concept", output)["contradiction"] == 0
    del output["pages"]["concepts/conflict.md"]
    del output["claim_ids_by_page"]["concepts/conflict.md"]
    output["pages"]["concepts/order.md"] += (
        "\nAn order payload requires an identifier when creating an order.\n"
    )
    assert evaluate_role("renderer", "grounded-readable-concept", output)["duplication"] == 0


def test_agent_eval_report_blocks_every_gated_change_and_records_operational_metadata(
    tmp_path,
) -> None:
    manifest = ReleaseEvalManifest.model_validate(
        {
            "change_kinds": list(GATED_CHANGE_KINDS),
            "versions": {
                "model": "gateway/model-2",
                "prompt": "roles-v2",
                "tool_schema": "snapshot-tools-v2",
                "workflow": "producer-v2",
            },
            "cost_usd": 1.25,
            "latency_ms": 4321,
            "worker_audit_path": str(tmp_path / "missing-worker.db"),
            "semantic_judges": [
                {
                    "role": "planner",
                    "case": "bounded-priority-plan",
                    "version": "semantic-judge-v1",
                    "outcome": "fail",
                    "evidence": ["recording:planner-v1"],
                    "rationale": "The bounded plan was not acceptable.",
                }
            ],
            "human_adjudications": [
                {
                    "role": "planner",
                    "case": "bounded-priority-plan",
                    "version": "adjudication-v1",
                    "outcome": "rejected",
                    "evidence": ["review:planner-v1"],
                    "rationale": "Human review rejected the plan.",
                }
            ],
            "results": [
                {
                    "role": "planner",
                    "case": "bounded-priority-plan",
                    "output": {},
                }
            ],
        }
    )

    report = evaluate_release(manifest)

    assert report.blocked is True
    assert report.passed is False
    assert report.change_kinds == GATED_CHANGE_KINDS
    assert report.versions.model == "gateway/model-2"
    assert report.cost_usd == 1.25
    assert report.latency_ms == 4321
    assert report.semantic_judges[0].version == "semantic-judge-v1"
    assert report.human_adjudications[0].outcome == "rejected"
    assert report.trajectory_failures == (
        "worker:grounded-data-contract:trajectory:missing_result",
    )
    assert "planner:bounded-priority-plan:semantic_judge:fail" in report.judge_failures
    assert "worker:grounded-data-contract:semantic_judge:missing" in report.judge_failures
    assert (
        "worker:grounded-data-contract:human_adjudication:missing" in report.adjudication_failures
    )
    approved = manifest.model_copy(
        update={
            "semantic_judges": (
                manifest.semantic_judges[0].model_copy(update={"outcome": "pass"}),
            ),
            "human_adjudications": (
                manifest.human_adjudications[0].model_copy(update={"outcome": "approved"}),
            ),
        }
    )
    approved_report = evaluate_release(approved)
    assert not any(
        failure.startswith("planner:bounded-priority-plan:semantic_judge:")
        for failure in approved_report.judge_failures
    )
    assert not any(
        failure.startswith("planner:bounded-priority-plan:human_adjudication:")
        for failure in approved_report.adjudication_failures
    )
    assert {failure.split(":", 1)[0] for failure in report.failures} == {
        *ROLE_METRICS,
    }


def test_eval_cli_returns_failure_for_a_blocked_release_gate(tmp_path, monkeypatch, capsys) -> None:
    manifest = tmp_path / "agent-eval.json"
    manifest.write_text(
        json.dumps(
            {
                "change_kinds": ["prompt"],
                "versions": {
                    "model": "gateway/model-2",
                    "prompt": "roles-v2",
                    "tool_schema": "snapshot-tools-v2",
                    "workflow": "producer-v2",
                },
                "cost_usd": 0,
                "latency_ms": 1,
                "worker_audit_path": str(tmp_path / "missing-worker.db"),
                "semantic_judges": [],
                "human_adjudications": [],
                "results": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sys, "argv", ["okf-wiki", "eval", str(manifest)])

    exit_code = main()

    payload = json.loads(capsys.readouterr().out)
    assert exit_code == 1
    assert payload["blocked"] is True
    assert payload["versions"]["prompt"] == "roles-v2"
