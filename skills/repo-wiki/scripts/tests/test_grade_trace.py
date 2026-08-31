import json
import pathlib
import sys

EVALS = pathlib.Path(__file__).parents[2] / "evals"
sys.path.insert(0, str(EVALS))

from grade_run import concurrency_metadata_valid, scope_has_seed, trace_data


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
