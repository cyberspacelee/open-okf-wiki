import json
import pathlib
import sys

EVALS = pathlib.Path(__file__).parents[2] / "evals"
sys.path.insert(0, str(EVALS))

from grade_run import concurrency_metadata_valid, scope_has_seed, trace_data
from semantic_eval import QUESTIONS, grade_semantic, subject_digest


def test_evaluation_accepts_copied_runtime_packets_after_pins_are_released(tmp_path):
    import _state
    import _validate
    import _workspace
    from _models import CompositionMap, KnowledgePlan
    from run_live_eval import copy_runtime
    import test_lifecycle as fixture

    root = fixture.workspace(tmp_path)
    run = fixture.start(root)
    fixture.write_work(run)
    fixture.approve_plan(root, run)
    fixture.approve_composition(root, run)
    state = _state.read(root)
    plan = KnowledgePlan.model_validate_json(
        (run / "work/plan-ledger.json").read_text()
    )
    composition = CompositionMap.model_validate(
        fixture.parse_file(run / "work/composition.md").meta
    )
    copied = copy_runtime(tmp_path)
    _workspace.remove_pin(root, state["run_id"], _workspace.load(root).sources["src"])
    assert not _validate.source_area_coverage(
        root, state, [], plan.source_areas, run / "work/plan.md"
    )
    page = composition.pages[0]
    path = run / f"work/page-packets/{page.id}.json"
    packet = json.loads(path.read_text())
    packet.update(
        _state._page_inputs(root, state, plan, composition, page, skill_dir=copied)
    )
    fixture.write(path, json.dumps(packet))
    assert packet["template"].startswith(str(copied))
    assert not _validate.page_packet(
        root, state, plan, page, composition, skill_dir=copied
    )[1]
    assert (
        _validate.page_packet(root, state, plan, page, composition)[1][0].code
        == "page-packet-stale"
    )


def event(tool: str, receivers=(), states=None, prompt="", sender=None) -> str:
    return json.dumps(
        {
            "type": "item.completed",
            "item": {
                "type": "collab_tool_call",
                "tool": tool,
                "receiver_thread_ids": list(receivers),
                "agents_states": states or {},
                "prompt": prompt,
                "sender_thread_id": sender,
            },
        }
    )


def test_semantic_grade_rejects_wrong_answers_stale_reports_and_false_citations(
    tmp_path,
):
    import _state
    import test_lifecycle as fixture

    ws = fixture.workspace(tmp_path)
    fixture.start(ws)
    state = _state.read(ws)
    bundle = tmp_path / "bundle"
    fixture.write(
        bundle / "answer.md",
        fixture.render(
            {
                "id": "answer",
                "sources": [{"id": "ev-answer", "resource": "src/app.py#L1-L2"}],
            },
            "The answer is 42.[^ev-answer]\n\n[^ev-answer]: `src/app.py#L1-L2`",
        ),
    )
    generation = "a" * 64
    answers = {
        "generation": generation,
        "answers": [
            {
                "id": q["id"],
                "answer": "The fixture returns 42.",
                "page_ids": ["answer"],
                "citations": [{"page_id": "answer", "evidence_id": "ev-answer"}],
            }
            for q in QUESTIONS
        ],
    }
    report = {
        "subject_digest": subject_digest(generation, answers),
        "checks": [
            {
                "id": q["id"],
                "correct": True,
                "supported": True,
                "failure_paths": True,
                "reason": "Fixture judgment for report validation.",
                "source_locators": ["src/app.py#L1-L2"],
            }
            for q in QUESTIONS
        ],
    }
    fixture.write(ws / "semantic-answers.json", json.dumps(answers))
    fixture.write(ws / "semantic-review.json", json.dumps(report))
    assert grade_semantic(ws, bundle, generation, state) == []

    report["checks"][0]["supported"] = False
    fixture.write(ws / "semantic-review.json", json.dumps(report))
    assert any(
        "semantic check failed" in error
        for error in grade_semantic(ws, bundle, generation, state)
    )
    report["checks"][0]["supported"] = True
    answers["answers"][0]["answer"] = "The fixture returns 43."
    fixture.write(ws / "semantic-answers.json", json.dumps(answers))
    assert any(
        "does not bind" in error
        for error in grade_semantic(ws, bundle, generation, state)
    )

    answers["answers"][0]["citations"][0]["evidence_id"] = "invented"
    report["subject_digest"] = subject_digest(generation, answers)
    fixture.write(ws / "semantic-answers.json", json.dumps(answers))
    fixture.write(ws / "semantic-review.json", json.dumps(report))
    assert any(
        "invalid Wiki citations" in error
        for error in grade_semantic(ws, bundle, generation, state)
    )


def test_trace_data_reconstructs_rolling_subagent_peak(tmp_path):
    trace = tmp_path / "host-run.log"
    trace.write_text(
        "\n".join(
            (
                event("spawn_agent", ["a"], {"a": {"status": "running"}}, "A"),
                event("spawn_agent", ["b"], {"b": {"status": "running"}}, "B"),
                event("wait", states={"a": {"status": "completed"}}),
                event("spawn_agent", ["c"], {"c": {"status": "running"}}, "C"),
                event(
                    "wait",
                    states={
                        "b": {"status": "completed"},
                        "c": {"status": "completed"},
                    },
                ),
            )
        )
        + "\n"
    )

    parsed, commands, prompts, stats = trace_data(trace)

    assert parsed == 5
    assert commands == []
    assert prompts == ["A", "B", "C"]
    assert stats == {
        "peak_active": 2,
        "unique_children": 3,
        "max_depth": 1,
        "failed_spawns": 0,
        "rolling_refill_observed": True,
    }


def test_trace_data_detects_child_spawn_depth(tmp_path):
    trace = tmp_path / "host-run.log"
    trace.write_text(
        "\n".join(
            (
                event("spawn_agent", ["child"], sender="root"),
                event("spawn_agent", ["grandchild"], sender="child"),
            )
        )
        + "\n",
        encoding="utf-8",
    )

    *_, stats = trace_data(trace)
    assert stats["max_depth"] == 2


def test_concurrency_metadata_is_host_brand_neutral():
    assert concurrency_metadata_valid(
        {
            "host_adapter": "pi",
            "concurrency_enforcement": "host-native",
            "host_max_active_children": 4,
            "effective_max_active_children": 3,
        },
        requested_cap=3,
    )
    assert concurrency_metadata_valid(
        {
            "host_adapter": "grok",
            "concurrency_enforcement": "coordinator",
            "host_max_active_children": None,
            "effective_max_active_children": 4,
        },
        requested_cap=4,
    )
    assert not concurrency_metadata_valid(
        {
            "host_adapter": "any",
            "concurrency_enforcement": "host-native",
            "host_max_active_children": 2,
            "effective_max_active_children": 4,
        },
        requested_cap=4,
    )


def test_scope_seed_accepts_source_and_catalog_resources():
    catalogs = [
        {
            "name": "database",
            "resource": "opengauss://db/public",
            "tables": [
                {
                    "resource": "opengauss://db/public/orders",
                    "name": "orders",
                    "page_slug": "orders",
                },
                {
                    "resource": "opengauss://db/public/customers",
                    "name": "customers",
                    "page_slug": "customers",
                },
            ],
        }
    ]

    assert scope_has_seed(
        {"source": "service"}, ["service/src/App.java#L1-L2"], catalogs
    )
    assert scope_has_seed(
        {"source": "database", "paths": ["orders"]},
        ["opengauss://db/public/orders"],
        catalogs,
    )
    assert not scope_has_seed(
        {"source": "database", "paths": ["orders"]},
        ["opengauss://db/public/customers"],
        catalogs,
    )
    assert scope_has_seed(
        {"source": "database", "paths": ["."]},
        ["opengauss://db/public"],
        catalogs,
    )
