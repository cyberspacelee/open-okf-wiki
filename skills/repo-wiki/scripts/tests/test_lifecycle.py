import json
import pathlib
import subprocess

import _publish
import _state
import _workspace
import pytest
from _frontmatter import parse_file, render


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def workspace(tmp_path: pathlib.Path) -> pathlib.Path:
    root = tmp_path / "workspace"
    source = root / "source"
    source.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    subprocess.run(
        ["git", "-C", str(source), "config", "user.email", "qa@example.test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(source), "config", "user.name", "QA"], check=True)
    write(source / "app.py", "def answer():\n    return 42\n")
    write(source / "architecture.py", "class Service:\n    pass\n")
    subprocess.run(["git", "-C", str(source), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-qm", "initial"], check=True)
    _workspace.init(root, "en", 30)
    _workspace.add_git_link(root, str(source), "src")
    return root


def start(root: pathlib.Path) -> pathlib.Path:
    result = _state.start_run(root, "repo-wiki/test", "producer-session")
    assert result["contract"] == "knowledge-composition-late-bind"
    state = _state.read(root)
    return _state.run_dir(root, state["run_id"])


def checkpoint(root: pathlib.Path, packet: dict) -> None:
    write(
        pathlib.Path(packet["checkpoint"]),
        """# Progress

## Completed

Inventory read.

## Findings

Evidence is recorded in the artifact.

## Hypotheses

None.

## Gaps

None.

## Next actions

Submit the artifact.
""",
    )
    result = _state.task_checkpoint(root, packet["target"]["id"], packet["attempt"])
    assert result["ok"]


def unit(unit_id: str, source_path: str, kind: str) -> dict:
    return {
        "id": unit_id,
        "kind": kind,
        "owner": "src",
        "question": f"How does {unit_id} work?",
        "scopes": [{"source": "src", "paths": [source_path]}],
        "evidence_seeds": [f"src/{source_path}#L1-L2"],
    }


def knowledge_plan() -> str:
    return render(
        {
            "kind": "knowledge-plan",
            "units": [
                unit("workspace-overview", "app.py", "capability"),
                unit("system-architecture", "architecture.py", "integration"),
                unit("answer-details", "app.py", "flow"),
            ],
            "gaps": [],
        },
        "# Knowledge Plan\n\nThe workspace exposes one behavior and one architecture boundary.\n",
    )


def submit(root: pathlib.Path, target_id: str, content: str, *, with_checkpoint=False):
    packet = _state.task_start(root, target_id)
    write(pathlib.Path(packet["artifact"]), content)
    if with_checkpoint:
        checkpoint(root, packet)
    return packet, _state.task_complete(root, target_id, packet["attempt"])


def approve(root: pathlib.Path, target_id: str):
    state = _state.read(root)
    if "review" not in state:
        _state.review_start(root, "repo-wiki/reviewer", "review-session")
    packet = _state.task_start(root, target_id)
    input_targets = [
        item.get("target") for item in packet["inputs"] if "target" in item
    ]
    assert len(input_targets) == len(set(input_targets))
    write(
        pathlib.Path(packet["artifact"]),
        json.dumps(
            {
                "subject": packet["subject"],
                "subject_digest": packet["subject_digest"],
                "verdict": "approved",
                "issues": [],
            }
        ),
    )
    return _state.task_complete(root, target_id, packet["attempt"])


def dossier(unit_id: str) -> str:
    return render(
        {
            "kind": "knowledge-dossier",
            "unit_id": unit_id,
            "disposition": "ready",
            "children": [],
        },
        f"# {unit_id}\n\nThe implementation is anchored by the assigned evidence.\n",
    )


def composition(*, details_path="guides/answer-details.md") -> str:
    return render(
        {
            "kind": "composition-map",
            "pages": [
                {
                    "id": "answer-details",
                    "path": details_path,
                    "type": "Domain",
                    "owner": "src",
                    "title": "Answer details",
                    "description": "Answer behavior and invariants.",
                    "tags": ["answer"],
                    "units": ["answer-details"],
                    "scopes": [{"source": "src", "paths": ["app.py"]}],
                    "evidence_seeds": ["src/app.py#L1-L2"],
                    "parent": "architecture",
                    "depends_on": [],
                    "diagrams": [],
                },
                {
                    "id": "architecture",
                    "path": "architecture.md",
                    "type": "Architecture",
                    "owner": "workspace",
                    "title": "Architecture",
                    "description": "System dependency boundaries.",
                    "tags": ["architecture"],
                    "units": ["system-architecture"],
                    "scopes": [{"source": "src", "paths": ["architecture.py"]}],
                    "evidence_seeds": ["src/architecture.py#L1-L2"],
                    "parent": None,
                    "depends_on": ["answer-details"],
                    "diagrams": [
                        {
                            "id": "components",
                            "kind": "flowchart",
                            "question": "Which components depend on each other?",
                        }
                    ],
                },
                {
                    "id": "overview",
                    "path": "overview.md",
                    "type": "Overview",
                    "owner": "workspace",
                    "title": "Overview",
                    "description": "Workspace behavior and routing.",
                    "tags": ["overview"],
                    "units": ["workspace-overview"],
                    "scopes": [{"source": "src", "paths": ["app.py"]}],
                    "evidence_seeds": ["src/app.py#L1-L2"],
                    "parent": None,
                    "depends_on": ["architecture"],
                    "diagrams": [],
                },
            ],
            "gaps": [],
        },
        "# Composition\n\nThe overview routes readers to the architecture page.\n",
    )


def page_text(page_id: str) -> str:
    if page_id == "architecture":
        visual = """```mermaid
%% okf-id: components
flowchart LR
    accTitle: Component dependency map
    accDescr: The entry point depends on the service.
    Entry --> Service
```

The service boundary is visible in the source.[^code]
"""
        resource = "src/architecture.py#L1-L2"
    else:
        visual = "The answer is returned by the entry point.[^code]\n\nSee [the architecture][architecture].\n"
        resource = "src/app.py#L1-L2"
    return render(
        {
            "type": "Overview",
            "coverage": "full",
            "sources": [{"id": "code", "resource": resource}],
        },
        f"## Responsibility\n\n{visual}\n[^code]: Source implementation\n",
    )


def reach_writers(root: pathlib.Path) -> pathlib.Path:
    run = start(root)
    _, result = submit(root, "plan:workspace", knowledge_plan(), with_checkpoint=True)
    assert result["ok"]
    assert set(result["state"]["ready_targets"]) == {"review:plan"}
    assert approve(root, "review:plan")["ok"]

    for unit_id in ("workspace-overview", "system-architecture", "answer-details"):
        _, result = submit(root, f"page:research/{unit_id}", dossier(unit_id))
        assert result["ok"]
    assert _state.status(root)["ready_targets"] == ["page:compose"]

    _, result = submit(root, "page:compose", composition(), with_checkpoint=True)
    assert result["ok"]
    assert _state.status(root)["ready_targets"] == ["review:composition"]
    assert approve(root, "review:composition")["ok"]
    return run


def test_full_lifecycle_late_binds_ids_and_publishes(tmp_path):
    root = workspace(tmp_path)
    run = reach_writers(root)

    assert _state.status(root)["ready_targets"] == ["page:write/answer-details"]
    _, result = submit(root, "page:write/answer-details", page_text("answer-details"))
    assert result["ok"]
    assert approve(root, "review:answer-details")["ok"]
    assert _state.status(root)["ready_targets"] == ["page:write/architecture"]
    _, result = submit(root, "page:write/architecture", page_text("architecture"))
    assert result["ok"]
    assert approve(root, "review:architecture")["ok"]
    assert _state.status(root)["ready_targets"] == ["page:write/overview"]
    _, result = submit(root, "page:write/overview", page_text("overview"))
    assert result["ok"]
    result = approve(root, "review:overview")
    assert result["ok"] and result["state"]["status"] == "approved"

    candidate = run / "candidate"
    assert (candidate / "overview.md").is_file()
    assert (candidate / "architecture.md").is_file()
    assert (candidate / "guides/answer-details.md").is_file()
    assert "](/architecture.md)" in (candidate / "overview.md").read_text()
    assert parse_file(candidate / "overview.md").meta["id"] == "overview"

    published = _publish.publish(root)
    assert pathlib.Path(published["path"], "overview.md").is_file()


def test_plan_and_composition_require_a_current_checkpoint(tmp_path):
    root = workspace(tmp_path)
    start(root)
    packet = _state.task_start(root, "plan:workspace")
    write(pathlib.Path(packet["artifact"]), knowledge_plan())
    with pytest.raises(_state.StateError, match="require a current checkpoint"):
        _state.task_complete(root, "plan:workspace", packet["attempt"])

    write(pathlib.Path(packet["checkpoint"]), "# incomplete\n")
    with pytest.raises(_state.StateError, match="missing headings"):
        _state.task_checkpoint(root, "plan:workspace", packet["attempt"])


def test_failed_attempt_checkpoint_is_injected_into_retry(tmp_path):
    root = workspace(tmp_path)
    start(root)
    packet = _state.task_start(root, "plan:workspace")
    checkpoint(root, packet)
    _state.task_fail(root, "plan:workspace", "context exhausted", packet["attempt"])

    retry = _state.task_start(root, "plan:workspace")
    prior = [item for item in retry["inputs"] if item["role"] == "previous_checkpoint"]
    assert len(prior) == 1
    assert pathlib.Path(prior[0]["path"]).is_file()


def test_dossier_split_expands_research_before_composition(tmp_path):
    root = workspace(tmp_path)
    start(root)
    one_unit_plan = render(
        {
            "kind": "knowledge-plan",
            "units": [unit("answer", "app.py", "capability")],
            "gaps": [],
        },
        "# Plan\n\nInvestigate the answer.\n",
    )
    submit(root, "plan:workspace", one_unit_plan, with_checkpoint=True)
    approve(root, "review:plan")
    split = render(
        {
            "kind": "knowledge-dossier",
            "unit_id": "answer",
            "disposition": "split",
            "children": [
                unit("answer-read", "app.py", "flow"),
                unit("answer-write", "app.py", "flow"),
            ],
        },
        "# Split\n\nRead and write paths require separate evidence passes.\n",
    )
    _, result = submit(root, "page:research/answer", split)
    assert result["ok"]
    assert set(_state.status(root)["ready_targets"]) == {
        "page:research/answer-read",
        "page:research/answer-write",
    }
    assert "page:compose" not in _state.read(root)["targets"]


def test_one_unit_plan_can_compose_one_page(tmp_path):
    root = workspace(tmp_path)
    start(root)
    plan = render(
        {
            "kind": "knowledge-plan",
            "units": [unit("answer", "app.py", "capability")],
            "gaps": [],
        },
        "# Plan\n\nInvestigate the answer.\n",
    )
    invalid_plan = plan.replace("owner: src", "owner: missing")
    packet, result = submit(root, "plan:workspace", invalid_plan, with_checkpoint=True)
    assert not result["ok"]
    assert "owner-invalid" in {item["code"] for item in result["issues"]}
    write(pathlib.Path(packet["artifact"]), plan)
    result = _state.task_complete(root, "plan:workspace", packet["attempt"])
    assert result["ok"]
    assert approve(root, "review:plan")["ok"]
    _, result = submit(root, "page:research/answer", dossier("answer"))
    assert result["ok"]

    one_page = render(
        {
            "kind": "composition-map",
            "pages": [
                {
                    "id": "answer",
                    "path": "answer.md",
                    "type": "Domain",
                    "owner": "src",
                    "title": "Answer",
                    "description": "Answer behavior and invariants.",
                    "tags": ["answer"],
                    "units": ["answer"],
                    "scopes": [{"source": "src", "paths": ["app.py"]}],
                    "evidence_seeds": ["src/app.py#L1-L2"],
                    "parent": None,
                    "depends_on": [],
                    "diagrams": [],
                }
            ],
            "gaps": [],
        },
        "# Composition\n\nOne coherent unit needs one page.\n",
    )
    invalid_page = one_page.replace("    - app.py", "    - architecture.py")
    packet, result = submit(root, "page:compose", invalid_page, with_checkpoint=True)
    assert not result["ok"]
    assert "composition-scope-coverage-invalid" in {
        item["code"] for item in result["issues"]
    }
    write(pathlib.Path(packet["artifact"]), one_page)
    result = _state.task_complete(root, "page:compose", packet["attempt"])
    assert result["ok"]
    assert _state.status(root)["ready_targets"] == ["review:composition"]


def test_composition_move_preserves_stable_draft_and_rechecks_structure(tmp_path):
    root = workspace(tmp_path)
    run = reach_writers(root)
    submit(root, "page:write/answer-details", page_text("answer-details"))
    approve(root, "review:answer-details")
    submit(root, "page:write/architecture", page_text("architecture"))
    approve(root, "review:architecture")
    submit(root, "page:write/overview", page_text("overview"))
    before = _state.read(root)["targets"]["page:write/answer-details"]["output_digest"]

    packet = _state.task_start(root, "review:overview")
    write(
        pathlib.Path(packet["artifact"]),
        json.dumps(
            {
                "subject": packet["subject"],
                "subject_digest": packet["subject_digest"],
                "verdict": "changes_requested",
                "issues": [
                    {
                        "category": "routing",
                        "claim": "The overview belongs under the guides hierarchy.",
                        "resolution": "Move it without rewriting its content.",
                        "reopen_target": "page:compose",
                        "operation": "move",
                    }
                ],
            }
        ),
    )
    result = _state.task_complete(root, "review:overview", packet["attempt"])
    assert result["ok"]
    assert _state.status(root)["ready_targets"] == ["page:compose"]

    submit(
        root,
        "page:compose",
        composition(details_path="reference/answer-details.md"),
        with_checkpoint=True,
    )
    state = _state.read(root)
    assert state["targets"]["page:write/answer-details"]["output_digest"] == before
    assert state["targets"]["review:answer-details"]["status"] == "complete"
    assert state["targets"]["review:architecture"]["status"] == "complete"
    assert state["targets"]["review:overview"]["status"] == "pending"

    approve(root, "review:composition")
    assert _state.status(root)["ready_targets"] == ["review:overview"]
    result = approve(root, "review:overview")
    assert result["state"]["status"] == "approved"
    assert (run / "candidate/reference/answer-details.md").is_file()
    assert not (run / "candidate/guides/answer-details.md").exists()


def test_contract_rejects_legacy_state_without_migration(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    path = run / "state.json"
    state = json.loads(path.read_text())
    state["contract"] = "source-plan-diagram-dag"
    write(path, json.dumps(state))
    with pytest.raises(_state.StateError, match="knowledge-composition-late-bind"):
        _state.read(root)
