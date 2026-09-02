import json
import os
import pathlib
import subprocess
from datetime import datetime

import _publish
import _state
import _validate
import _workspace
import pytest
from _files import compact_json_size, directory_digest
from _frontmatter import parse_file, render
from _models import RunPolicy


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def workspace(
    tmp_path: pathlib.Path, language: str = "en", policy: dict | None = None
) -> pathlib.Path:
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
    _workspace.init(root, language, 30, policy)
    _workspace.add_git_link(root, str(source), "src")
    return root


def start(root: pathlib.Path) -> pathlib.Path:
    result = _state.start_run(root)
    assert result["contract"] == "domain-concept-model-coverage"
    assert result["language"] in ("en", "zh")
    assert result["sources"] == ["src"]
    assert result["phase"] == "plan"
    run = _state.run_dir(root, _state.read(root)["run_id"])
    assert "repo-wiki-progress:initial" in (run / "work/progress.md").read_text(
        encoding="utf-8"
    )
    return run


def unit(
    unit_id: str, source_path: str, kind: str, concept_id: str | None = None
) -> dict:
    return {
        "id": unit_id,
        "kind": kind,
        "question": f"How does {unit_id} work?",
        "domain_ids": ["answers"],
        "concept_ids": [concept_id or unit_id],
        "scopes": [{"source": "src", "role": "owner", "paths": [source_path]}],
        "evidence_seeds": [f"src/{source_path}#L1-L2"],
    }


def plan_meta(units: list[dict] | None = None) -> dict:
    units = units or [
        unit("answer", "app.py", "flow"),
        unit("architecture", "architecture.py", "capability"),
    ]
    concept_units = {}
    for item in units:
        for concept_id in item["concept_ids"]:
            concept_units.setdefault(concept_id, item)
    concepts = []
    for concept_id, owner in concept_units.items():
        source_path = owner["scopes"][0]["paths"][0]
        concepts.append(
            {
                "id": concept_id,
                "domain_id": "answers",
                "kind": "service" if concept_id == "architecture" else "entity",
                "name": concept_id.replace("-", " ").title(),
                "definition": f"The {concept_id} concept owned by the answers domain.",
                "owner_unit_id": owner["id"],
                "model_unit_id": None,
                "owner_evidence": [f"src/{source_path}#L1-L2"],
                "behavior_seeds": [f"src/{source_path}#L1-L2"],
                "model_basis": {
                    "basis": "none",
                    "coverage": "full",
                    "catalog_tables": [],
                    "structure_evidence": [],
                    "gap_ids": [],
                },
            }
        )
    return {
        "kind": "knowledge-plan",
        "source_areas": [
            {
                "id": "src.answers",
                "source": "src",
                "paths": ["."],
                "disposition": "domain",
                "domain_ids": ["answers"],
                "evidence_seeds": ["src/app.py#L1-L2"],
            }
        ],
        "domains": [
            {
                "id": "answers",
                "name": "Answers",
                "definition": "Owns answer behavior and its service boundary.",
                "owner_unit_id": units[0]["id"],
                "evidence": ["src/app.py#L1-L2"],
            }
        ],
        "concepts": concepts,
        "table_dispositions": [],
        "relationships": [],
        "units": units,
        "gaps": [],
    }


def plan() -> str:
    return render(
        plan_meta(),
        "# Knowledge Plan\n\nThe answer crosses an explicit service boundary.\n",
    )


def test_code_model_evidence_must_be_inside_the_model_unit_scope(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    value = plan_meta(
        [
            unit("answer", "app.py", "capability", "answer"),
            unit("answer-model", "architecture.py", "data-model", "answer"),
        ]
    )
    concept = value["concepts"][0]
    concept["model_unit_id"] = "answer-model"
    concept["model_basis"] = {
        "basis": "code",
        "coverage": "full",
        "catalog_tables": [],
        "structure_evidence": ["src/app.py#L1-L2"],
        "gap_ids": [],
    }
    path = run / "work/plan.md"
    write(path, render(value, "# Knowledge Plan\n"))

    _plan, issues = _validate.validate_plan_artifact(root, _state.read(root), path)

    assert "model-evidence-outside-scope" in {issue.code for issue in issues}


def composition() -> str:
    return render(
        {
            "kind": "composition-map",
            "reference_roots": [],
            "pages": [
                {
                    "id": "answer",
                    "path": "guides/answer.md",
                    "type": "Domain",
                    "title": "Answer behavior",
                    "description": "Open before changing answer behavior.",
                    "tags": ["answer"],
                    "units": ["answer"],
                    "diagrams": [],
                },
                {
                    "id": "architecture",
                    "path": "system/service-boundary.md",
                    "type": "Domain",
                    "title": "Service boundary",
                    "description": "Open before changing service boundaries.",
                    "tags": ["architecture"],
                    "units": ["architecture"],
                    "diagrams": [],
                },
            ],
            "gaps": [],
        },
        "# Composition\n\nPaths provide the final information hierarchy.\n",
    )


def draft(resource: str, related_id: str, related_title: str) -> str:
    return render(
        {
            "coverage": "full",
            "sources": [{"id": "entry", "resource": resource}],
        },
        "## Responsibility and public surface\n\n"
        "The captured entry point defines this responsibility.[^entry]\n\n"
        "## Invariants and rules\n\n"
        "| Rule | Enforcement point | Observable failure |\n"
        "| --- | --- | --- |\n"
        "| The entry point remains authoritative. | Captured function | Call failure |\n\n"
        f"## Concepts\n\nSee [{related_title}][{related_id}].\n\n"
        "## Change points\n\nChange the captured entry point and its tests.[^entry]\n\n"
        "[^entry]: Frozen source entry point.\n",
    )


def merge_probes(path: pathlib.Path, field: str) -> list[dict]:
    ids = [item["id"] for item in parse_file(path).meta[field]]
    if len(ids) < 2:
        return []
    return [
        {
            f"{field[:-1]}_ids": [ids[index], ids[index + 1]],
            "decision": "keep-separate",
            "rationale": "The neighboring records have independent change surfaces.",
        }
        for index in range(len(ids) - 1)
    ]


def write_work(run: pathlib.Path) -> None:
    write(run / "work/plan.md", plan())
    write(run / "work/progress.md", "# Progress\n\nPlan complete; pages remain.\n")
    write(run / "work/composition.md", composition())
    write(
        run / "work/drafts/answer.md",
        draft("src/app.py#L1-L2", "architecture", "service boundary"),
    )
    write(
        run / "work/drafts/architecture.md",
        draft("src/architecture.py#L1-L2", "answer", "answer behavior"),
    )


def review(path: pathlib.Path, digest: str, verdict: str) -> None:
    issues = (
        [
            {**item, "status": "resolved"}
            for item in json.loads(path.read_text(encoding="utf-8")).get("issues", [])
        ]
        if path.is_file() and verdict == "approved"
        else []
    )
    if verdict == "changes_requested":
        issues = [
            {
                "id": "coverage.answer-failure",
                "status": "open",
                "category": "coverage",
                "claim": "The answer page omits its failure behavior.",
                "resolution": "Add the failure behavior with evidence.",
                "area": "page",
                "page_ids": ["answer"],
                "operation": "repair",
            }
        ]
    write(
        path,
        json.dumps({"subject_digest": digest, "verdict": verdict, "issues": issues}),
    )


def plan_review(path: pathlib.Path, digest: str, verdict: str) -> None:
    issues = (
        [
            {**item, "status": "resolved"}
            for item in json.loads(path.read_text(encoding="utf-8")).get("issues", [])
        ]
        if path.is_file() and verdict == "approved"
        else []
    )
    if verdict == "changes_requested":
        issues = [
            {
                "id": "domain.visible-subsystem",
                "status": "open",
                "category": "domain-coverage",
                "claim": "A visible subsystem is absent from units and gaps.",
                "resolution": "Account for it in a unit or evidence-backed gap.",
            }
        ]
    write(
        path,
        json.dumps(
            {
                "subject_digest": digest,
                "verdict": verdict,
                "merge_probes": merge_probes(path.with_name("plan.md"), "units"),
                "issues": issues,
            }
        ),
    )


def composition_review(path: pathlib.Path, digest: str, verdict: str) -> None:
    issues = (
        [
            {**item, "status": "resolved"}
            for item in json.loads(path.read_text(encoding="utf-8")).get("issues", [])
        ]
        if path.is_file() and verdict == "approved"
        else []
    )
    if verdict == "changes_requested":
        issues = [
            {
                "id": "routing.shared-route",
                "status": "open",
                "category": "routing",
                "claim": "Two independently maintained units share one route.",
                "resolution": "Split the change surfaces or explain the causal merge.",
                "area": "composition",
                "page_ids": ["answer"],
                "operation": "split",
            }
        ]
    write(
        path,
        json.dumps(
            {
                "subject_digest": digest,
                "verdict": verdict,
                "merge_probes": merge_probes(path.with_name("composition.md"), "pages"),
                "issues": issues,
            }
        ),
    )


def approve_plan(root: pathlib.Path, run: pathlib.Path) -> None:
    progress = run / "work/progress.md"
    if "repo-wiki-progress:initial" in progress.read_text(encoding="utf-8"):
        write(progress, "# Progress\n\nPlan complete; review is next.\n")
    packet = _state.plan_review_prepare(root)
    assert packet["ok"]
    plan_review(run / "work/plan-review.json", packet["subject_digest"], "approved")


def approve_composition(root: pathlib.Path, run: pathlib.Path) -> None:
    packet = _state.composition_review_prepare(root)
    assert packet["ok"]
    composition_review(
        run / "work/composition-review.json", packet["subject_digest"], "approved"
    )


def test_artifact_loop_reaches_publication_and_rechecks_changes(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    assert (run / "index/src.md").is_file()

    search = _state.evidence_search(root, "src", "return 42")
    assert search["items"][0]["locator"] == "src/app.py#L2"
    assert "return 42" in _state.evidence_read(root, "src/app.py#L1-L2")["text"]

    write_work(run)
    assert _state.status(root)["next_actions"] == ["review plan"]
    plan_packet = _state.plan_review_prepare(root)
    plan_review(
        run / "work/plan-review.json",
        plan_packet["subject_digest"],
        "changes_requested",
    )
    assert _state.status(root)["phase"] == "plan"
    plan_path = run / "work/plan.md"
    write(
        plan_path,
        plan_path.read_text(encoding="utf-8")
        + "\nThe missing subsystem is now accounted for.\n",
    )
    repaired_plan_packet = _state.plan_review_prepare(root)
    assert repaired_plan_packet["subject_digest"] != plan_packet["subject_digest"]
    assert repaired_plan_packet["previous_review"]["issues"][0]["id"] == (
        "domain.visible-subsystem"
    )
    plan_review(
        run / "work/plan-review.json",
        repaired_plan_packet["subject_digest"],
        "approved",
    )
    assert _state.status(root)["next_actions"] == ["review composition"]
    composition_packet = _state.composition_review_prepare(root)
    composition_review(
        run / "work/composition-review.json",
        composition_packet["subject_digest"],
        "changes_requested",
    )
    assert _state.status(root)["phase"] == "write"
    composition_path = run / "work/composition.md"
    write(
        composition_path,
        composition_path.read_text(encoding="utf-8")
        + "\nEach page now has an explicit maintainer route.\n",
    )
    repaired_composition_packet = _state.composition_review_prepare(root)
    assert (
        repaired_composition_packet["subject_digest"]
        != composition_packet["subject_digest"]
    )
    assert repaired_composition_packet["previous_review"]["issues"][0]["id"] == (
        "routing.shared-route"
    )
    composition_review(
        run / "work/composition-review.json",
        repaired_composition_packet["subject_digest"],
        "approved",
    )
    assert _state.status(root)["next_actions"] == ["review prepare"]
    packet = _state.review_prepare(root)
    assert packet["ok"]
    assert "](/system/service-boundary.md)" in (
        run / "candidate/guides/answer.md"
    ).read_text(encoding="utf-8")
    assert (run / "candidate/index.md").is_file()
    assert (run / "candidate/guides/index.md").is_file()

    review(run / "work/review.json", packet["subject_digest"], "changes_requested")
    result = _state.review_complete(root)
    assert result["verdict"] == "changes_requested"
    assert result["state"]["phase"] == "repair"
    answer = run / "work/drafts/answer.md"
    write(
        answer,
        answer.read_text(encoding="utf-8")
        + "\nFailure behavior is explicit.[^entry]\n",
    )
    assert _state.status(root)["next_actions"] == ["review prepare"]
    second = _state.review_prepare(root)
    assert second["subject_digest"] != packet["subject_digest"]
    assert second["previous_review"]["issues"][0]["id"] == ("coverage.answer-failure")
    assert second["previous_review"]["artifact"] == str(run / "work/review.json")
    review(run / "work/review.json", second["subject_digest"], "approved")
    completed = _state.review_complete(root)
    assert completed["state"]["status"] == "approved"

    approved_plan = plan_path.read_text(encoding="utf-8")
    write(plan_path, approved_plan + "\nTampered after approval.\n")
    with pytest.raises(_publish.PublishError, match="working artifacts changed"):
        _publish.publish(root)
    write(plan_path, approved_plan)

    published = _publish.publish(root)
    assert published["pages"] == 2
    manifest = json.loads(
        (pathlib.Path(published["path"]) / ".okf-manifest.json").read_text(
            encoding="utf-8"
        )
    )
    assert len(manifest["nav"]) == 2
    assert all(page["origin"] == "authored" for page in manifest["pages"].values())
    assert all(page["inputs"] for page in manifest["pages"].values())
    assert _state.status(root)["status"] == "published"
    errors = [
        item
        for item in _validate.validate_publication(
            root, pathlib.Path(published["path"])
        ).issues
        if item.severity == "error"
    ]
    assert errors == []

    proposal = _state.propose_start(root)
    assert proposal["reference"].endswith("references/propose.md")
    assert _state.propose_complete(root) == {"ok": True, "files": []}

    verified = _publish.verify(root, "human:qa", ["guides/answer.md"])
    assert verified["actor"] == "human:qa"
    assert verified["generation"] != published["generation"]
    assert _publish.rollback(root)["generation"] == published["generation"]


def test_plan_without_domain_concept_ledger_is_rejected(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write(
        run / "work/plan.md",
        render(
            {
                "kind": "knowledge-plan",
                "units": [],
                "gaps": [],
            },
            "# Plan\n\nNo knowledge passes the Grep Test.\n",
        ),
    )
    write(run / "work/progress.md", "# Progress\n\nPlan attempted.\n")

    status = _state.status(root)

    assert status["phase"] == "plan"
    assert {item["code"] for item in status["issues"]} == {"schema-invalid"}


def test_status_derives_plan_composition_and_draft_repairs(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write(run / "work/plan.md", plan())
    assert _state.status(root)["issues"][0]["code"] == "progress-stale"
    write(run / "work/progress.md", "# Progress\n\nPlan complete; review is next.\n")
    assert _state.status(root)["issues"][0]["code"] == "plan-review-missing"
    approve_plan(root, run)
    assert _state.status(root)["issues"][0]["code"] == "composition-missing"
    write(run / "work/composition.md", composition())
    status = _state.status(root)
    assert status["phase"] == "composition-review"
    assert status["issues"][0]["code"] == "composition-review-missing"
    packet = _state.composition_review_prepare(root)
    write(
        run / "work/composition-review.json",
        json.dumps(
            {
                "subject_digest": packet["subject_digest"],
                "verdict": "changes_requested",
                "merge_probes": merge_probes(run / "work/composition.md", "pages"),
                "issues": [
                    {
                        "id": "routing.invalid-area",
                        "status": "open",
                        "category": "routing",
                        "claim": "The route is ambiguous.",
                        "resolution": "Repair the Composition route.",
                        "area": "page",
                        "page_ids": ["answer"],
                        "operation": "repair",
                    }
                ],
            }
        ),
    )
    assert _state.status(root)["issues"][0]["code"] == (
        "composition-review-area-invalid"
    )
    approve_composition(root, run)
    status = _state.status(root)
    assert status["phase"] == "write"
    assert {item["code"] for item in status["issues"]} == {"page-draft-missing"}
    assert status["artifact_counts"] == {
        "knowledge_units": 2,
        "pages": 2,
        "authored_pages": 2,
        "reference_pages": 0,
        "drafts_written": 0,
        "drafts_missing": 2,
    }


def test_plan_rejects_a_scoped_source_without_its_own_seed(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    broken = unit("answer", "app.py", "capability")
    broken["evidence_seeds"] = ["missing/app.py#L1-L2"]
    write(
        run / "work/plan.md",
        render(
            plan_meta([broken]),
            "# Plan\n\nThe unit has an invalid seed.\n",
        ),
    )

    status = _state.status(root)

    assert {item["code"] for item in status["issues"]} == {
        "evidence-unresolved",
        "scope-source-unseeded",
    }


def test_status_summarizes_large_issue_sets(tmp_path):
    root = workspace(tmp_path)
    start(root)
    state = _state.read(root)
    issues = [
        {
            "severity": "error",
            "code": "draft-invalid" if index < 11 else "link-invalid",
            "path": f"drafts/{index}.md",
            "line": None,
            "message": "invalid",
        }
        for index in range(12)
    ]

    status = _state._status_payload(root, state, "write", [], issues=issues)

    assert len(status["issues"]) == 10
    assert status["issue_counts"] == {"draft-invalid": 11, "link-invalid": 1}
    assert status["issues_truncated"] == 2


def test_run_policy_is_snapshotted_and_controls_evidence(tmp_path):
    policy = RunPolicy.defaults().model_dump(mode="json")
    policy["agents"]["max_active_children"] = 2
    policy["evidence"]["search"]["max_results"] = 1
    policy["evidence"]["read"]["default_lines"] = 1
    policy["evidence"]["read"]["max_lines"] = 1
    root = workspace(tmp_path, policy=policy)
    source = root / "source"
    write(source / "app.py", "match one\nmatch two\nmatch three\n")
    subprocess.run(["git", "-C", str(source), "add", "app.py"], check=True)
    subprocess.run(
        ["git", "-C", str(source), "commit", "-qm", "add evidence rows"],
        check=True,
    )

    start(root)
    assert _state.status(root)["policy"] == policy
    search = _state.evidence_search(root, "src", "match")
    assert len(search["items"]) == 1
    assert search["limit_reached"] is True
    continued = _state.evidence_search(root, "src", "match", after=search["next_after"])
    assert continued["items"][0]["locator"] == "src/app.py#L2"
    read = _state.evidence_read(root, "src/app.py#L1-L3")
    assert read["end"] == 1
    assert read["limit_reached"] is True
    assert read["next_locator"] == "src/app.py#L2-L2"

    with pytest.raises(_workspace.WorkspaceError, match="active run"):
        _workspace.configure(root, policy_updates={"max_active_children": 4})


def test_evidence_byte_limits_preserve_json_and_continuation(tmp_path):
    policy = RunPolicy.defaults().model_dump(mode="json")
    policy["evidence"]["search"].update(max_results=100, max_output_bytes=4096)
    policy["evidence"]["read"].update(
        default_lines=100, max_lines=100, max_output_bytes=4096
    )
    root = workspace(tmp_path, policy=policy)
    source = root / "source"
    write(
        source / "wide.txt",
        "".join(f'match {index} "\\" 中文' * 50 + "\n" for index in range(12)),
    )
    subprocess.run(["git", "-C", str(source), "add", "wide.txt"], check=True)
    subprocess.run(
        ["git", "-C", str(source), "commit", "-qm", "add wide evidence"],
        check=True,
    )
    start(root)

    first = _state.evidence_search(root, "src", "match")
    second = _state.evidence_search(root, "src", "match", after=first["next_after"])
    assert first["limit_reached"] and first["has_more"]
    assert compact_json_size(first) <= 4096
    assert compact_json_size(second) <= 4096
    assert {item["locator"] for item in first["items"]}.isdisjoint(
        item["locator"] for item in second["items"]
    )

    read = _state.evidence_read(root, "src/wide.txt#L1-L12")
    assert read["limit_reached"] and read["has_more"]
    assert read["next_locator"]
    assert read["clipped_lines"]
    assert compact_json_size(read) <= 4096


def test_git_blob_rejects_directory_tree(tmp_path):
    root = workspace(tmp_path)
    source_path = root / "source"
    write(source_path / "package/module.py", "value = 42\n")
    subprocess.run(
        ["git", "-C", str(source_path), "add", "package/module.py"], check=True
    )
    subprocess.run(
        ["git", "-C", str(source_path), "commit", "-qm", "add package"], check=True
    )
    start(root)
    state = _state.read(root)
    source = _workspace.load(root).sources["src"]

    assert (
        _workspace.git_blob(source, state["revisions"][0]["commit"], "package") is None
    )


def test_workspace_and_run_reject_missing_policy(tmp_path):
    root = workspace(tmp_path)
    config_path = root / "workspace.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config.pop("policy")
    config_path.write_text(json.dumps(config))
    with pytest.raises(_workspace.WorkspaceError, match="workspace policy"):
        _workspace.load(root)

    config["policy"] = RunPolicy.defaults().model_dump(mode="json")
    config_path.write_text(json.dumps(config))
    start(root)
    state = _state.read(root)
    state.pop("policy")
    state_path = _state.run_dir(root, state["run_id"]) / "state.json"
    state_path.write_text(json.dumps(state))
    with pytest.raises(_state.StateError, match="run policy"):
        _state.read(root)


def test_active_run_rejects_a_changed_skill_bundle(tmp_path):
    root = workspace(tmp_path)
    start(root)
    state = _state.read(root)
    state["skill_bundle_digest"] = "0" * 64
    state_path = _state.run_dir(root, state["run_id"]) / "state.json"
    state_path.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(_state.StateError, match="skill bundle changed"):
        _state.read(root)

    state["status"] = "published"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    assert _state.read(root)["status"] == "published"


def test_one_unit_plan_can_publish_one_page(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write(
        run / "work/plan.md",
        render(
            plan_meta([unit("answer", "app.py", "flow")]),
            "# Plan\n\nOne coherent unit.\n",
        ),
    )
    write(
        run / "work/composition.md",
        render(
            {
                "kind": "composition-map",
                "reference_roots": [],
                "pages": [
                    {
                        "id": "answer",
                        "path": "answer.md",
                        "type": "Domain",
                        "title": "Answer",
                        "description": "Open before changing answer behavior.",
                        "tags": [],
                        "units": ["answer"],
                        "diagrams": [],
                    }
                ],
                "gaps": [],
            },
            "# Composition\n\nOne unit needs one page.\n",
        ),
    )
    write(
        run / "work/drafts/answer.md",
        draft("src/app.py#L1-L2", "answer", "answer").replace(
            "See [answer][answer].", "The answer concept owns this behavior."
        ),
    )
    approve_plan(root, run)
    approve_composition(root, run)
    packet = _state.review_prepare(root)
    assert packet["ok"]


def test_chinese_partial_page_uses_localized_gap_heading(tmp_path):
    root = workspace(tmp_path, "zh")
    run = start(root)
    write(
        run / "work/plan.md",
        render(
            plan_meta([unit("answer", "app.py", "capability")]),
            "# Plan\n\n一个语义单元。\n",
        ),
    )
    write(run / "work/progress.md", "# Progress\n\n规划完成，下一步审查。\n")
    approve_plan(root, run)
    write(
        run / "work/composition.md",
        render(
            {
                "kind": "composition-map",
                "reference_roots": [],
                "pages": [
                    {
                        "id": "answer",
                        "path": "answer.md",
                        "type": "Domain",
                        "title": "答案行为",
                        "description": "修改答案行为前阅读。",
                        "tags": ["答案"],
                        "units": ["answer"],
                        "diagrams": [],
                    }
                ],
                "gaps": [],
            },
            "# Composition\n\n一个单元对应一个页面。\n",
        ),
    )
    write(
        run / "work/drafts/answer.md",
        render(
            {
                "coverage": "partial",
                "sources": [{"id": "entry", "resource": "src/app.py#L1-L2"}],
            },
            "## 职责与公开边界\n\n入口定义答案行为。[^entry]\n\n"
            "## 不变量与规则\n\n"
            "| 规则 | 执行位置 | 可观察失败 |\n"
            "| --- | --- | --- |\n"
            "| 入口保持唯一。 | 应用函数 | 调用失败 |\n\n"
            "## 领域概念\n\n答案是该能力的输出。\n\n"
            "## 变更入口\n\n修改入口及其测试。[^entry]\n\n"
            "## 缺口\n\n异常路径尚未捕获。\n\n"
            "[^entry]: 冻结的源码入口。\n",
        ),
    )
    approve_composition(root, run)
    assert _state.status(root)["next_actions"] == ["review prepare"]


def test_full_coverage_rejects_gap_section(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    write_work(run)
    approve_plan(root, run)
    approve_composition(root, run)
    draft_path = run / "work/drafts/answer.md"
    write(
        draft_path,
        draft_path.read_text(encoding="utf-8")
        + "\n## Gaps\n\nA scoped behavior remains unverified.\n",
    )

    result = _state.review_prepare(root)

    assert result["ok"] is False
    assert [item["code"] for item in result["issues"]] == ["gaps-unexpected"]


def test_chinese_page_rejects_english_template_heading(tmp_path):
    root = workspace(tmp_path, "zh")
    run = start(root)
    state = _state.read(root)
    page = run / "candidate/answer.md"
    write(
        page,
        render(
            {
                "id": "answer",
                "type": "Domain",
                "title": "答案行为",
                "description": "修改答案行为前阅读。",
                "tags": [],
                "generated": {
                    "by": "repo-wiki",
                    "at": datetime.fromisoformat(state["started_at"]),
                },
                "status": "draft",
                "coverage": "full",
                "language": "zh",
                "diagrams": [],
                "sources": [],
            },
            "## Responsibility and public surface\n\n这里说明答案行为。\n",
        ),
    )
    issues = _validate.validate_page(root, state, page)
    assert "template-heading-leak" in {item.code for item in issues}


def test_candidate_validation_collects_independent_errors_after_bad_plan(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    state = _state.read(root)
    write(run / "work/plan.md", "---\nkind: wrong\n---\n\n# Bad plan\n")
    page = run / "candidate/answer.md"
    write(
        page,
        render(
            {
                "id": "answer",
                "type": "Domain",
                "title": "答案",
                "description": "只有中文说明。",
                "tags": [],
                "generated": {
                    "by": "repo-wiki",
                    "at": datetime.fromisoformat(state["started_at"]),
                },
                "status": "draft",
                "coverage": "full",
                "language": "en",
                "diagrams": [],
                "sources": [],
            },
            "## 职责与公开边界\n\n{{unfinished}}\n",
        ),
    )
    result = _validate.validate_candidate(root, state, published=False)
    codes = {item.code for item in result.issues}
    assert {
        "schema-invalid",
        "language-content-missing",
        "template-heading-leak",
    } <= codes
    assert "placeholder-remaining" in codes
    assert not result.complete
    assert "composition-unit-binding" in result.skipped_checks


def test_block_resume_and_legacy_state_rejection(tmp_path):
    root = workspace(tmp_path)
    run = start(root)
    assert _state.block(root, "credentials required")["status"] == "blocked"
    assert _state.resume(root)["status"] == "active"
    path = run / "state.json"
    state = json.loads(path.read_text(encoding="utf-8"))
    state["contract"] = "artifact-loop-routing-closure"
    write(path, json.dumps(state))
    with pytest.raises(_state.StateError, match="domain-concept-model-coverage"):
        _state.read(root)


def test_run_abandon(tmp_path):
    root = workspace(tmp_path)
    start(root)
    assert _state.abandon(root) == {"abandoned": True}
    assert _state.status(root)["status"] == "abandoned"


def test_source_registration_variants(tmp_path):
    root = tmp_path / "workspace"
    origin = tmp_path / "origin"
    files = tmp_path / "contracts"
    origin.mkdir()
    files.mkdir()
    write(files / "schema.txt", "answer: integer\n")
    subprocess.run(["git", "init", "-q", str(origin)], check=True)
    subprocess.run(
        ["git", "-C", str(origin), "config", "user.email", "qa@example.test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(origin), "config", "user.name", "QA"], check=True)
    write(origin / "app.py", "answer = 42\n")
    subprocess.run(["git", "-C", str(origin), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(origin), "commit", "-qm", "initial"], check=True)

    _workspace.init(root)
    assert _workspace.add_git_clone(root, str(origin), "service").kind == "git"
    assert _workspace.add_files_source(root, str(files), "contracts").kind == "files"
    database = _workspace.add_opengauss_source(
        root, "database", "DATABASE_URL", "public", ["orders"]
    )
    assert database.kind == "opengauss"
    assert database.tables == ("orders",)


def test_directory_digest_is_order_independent_and_content_bound(tmp_path):
    left = tmp_path / "left"
    right = tmp_path / "right"
    write(left / "b.txt", "B")
    write(left / "a.txt", "A")
    write(right / "a.txt", "A")
    write(right / "b.txt", "B")

    assert directory_digest(left) == directory_digest(right)
    write(right / "b.txt", "changed")
    assert directory_digest(left) != directory_digest(right)


def test_active_run_state_is_read_as_utf8(tmp_path, monkeypatch):
    root = workspace(tmp_path, "zh")
    start(root)
    original = pathlib.Path.read_text

    def require_utf8(path, *args, **kwargs):
        if path.name == "state.json":
            assert kwargs.get("encoding") == "utf-8"
        return original(path, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "read_text", require_utf8)
    assert _workspace._active_run(root)


def test_prune_uses_manifest_publication_order(tmp_path):
    root = tmp_path / "workspace"
    generations = root / ".okf-wiki/publication/generations"
    for name, published_at, mtime in (
        ("old", "2026-01-01T00:00:00+00:00", 3),
        ("middle", "2026-01-02T00:00:00+00:00", 2),
        ("new", "2026-01-03T00:00:00+00:00", 1),
    ):
        generation = generations / name
        write(
            generation / ".okf-manifest.json",
            json.dumps({"published_at": published_at, "run_id": f"run-{name}"}),
        )
        os.utime(generation, (mtime, mtime))

    assert _publish.prune(root, keep=1) == {"kept": ["new"]}


def test_proposal_issues_are_sorted_by_path(tmp_path, monkeypatch):
    proposals = tmp_path / "proposals"
    write(proposals / "agents-block-b.md", "invalid\n")
    write(proposals / "agents-block-a.md", "invalid\n")
    state = {
        "revisions": [
            {"name": "a", "kind": "git"},
            {"name": "b", "kind": "git"},
        ]
    }
    unordered = [proposals / "agents-block-b.md", proposals / "agents-block-a.md"]
    monkeypatch.setattr(pathlib.Path, "glob", lambda _path, _pattern: iter(unordered))

    issues = _validate.validate_proposals(tmp_path, state, proposals)

    assert [pathlib.Path(item.path).name for item in issues] == [
        "agents-block-a.md",
        "agents-block-b.md",
    ]
