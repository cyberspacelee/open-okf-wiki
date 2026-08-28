import hashlib
import json
import pathlib
import subprocess

import _publish
import _index
import _state
import _validate
import _workspace
import pytest


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def git_source(path: pathlib.Path, files: dict[str, str]) -> pathlib.Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "qa@example.test"], check=True
    )
    subprocess.run(["git", "-C", str(path), "config", "user.name", "QA"], check=True)
    for rel, text in files.items():
        write(path / rel, text)
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "fixture"], check=True)
    return path


def complete(
    root: pathlib.Path, task_id: str, artifact: pathlib.Path, text: str
) -> None:
    _state.task_start(root, task_id)
    write(artifact, text)
    result = _state.task_complete(root, task_id)
    assert result["ok"], result


def survey_tasks(root: pathlib.Path) -> dict[str, list[str]]:
    state = _state.read(root)
    return {
        task["name"]: task["spec"]["scope"]
        for task in state["tasks"].values()
        if task["phase"] == "survey"
    }


def test_start_creates_one_triage_target_and_bounded_index_per_source(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(root / "src", {"app.py": "VALUE = 1\n", "lib/util.py": "VALUE = 2\n"})
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    assert _state.status(root)["tasks"] == [
        {"id": "triage:src", "status": "pending"}
    ]
    task = state["tasks"]["triage:src"]
    assert task["artifact"] == "drafts/triage/src.json"
    assert (_state.run_dir(root, state["run_id"]) / "drafts/triage").is_dir()
    index = json.loads(
        (_state.run_dir(root, state["run_id"]) / "drafts/index/src.json").read_text()
    )
    assert index["version"] == 2
    assert index["source"] == "src"
    assert index["file_count"] == 2
    assert sum(item["files"] for item in index["directories"]) == 2
    assert len(json.dumps(index).encode()) <= 64 * 1024
    forbidden = {"churn", "authors", "gzip_ratio", "name_homogeneity"}
    assert all(not (forbidden & set(item)) for item in index["directories"])
    assert _index.is_protected("openapi.yaml")


def test_index_compacts_single_child_chains_and_preserves_forced_splits(tmp_path):
    empty = _index.build_index("src", tmp_path, [])
    assert [item["path"] for item in empty["directories"]] == ["."]

    files = [
        "src/main/java/com/it/example/api/A.java",
        "src/main/java/com/it/example/service/B.java",
    ]
    index = _index.build_index("src", tmp_path, files)
    assert [item["path"] for item in index["directories"]] == [
        ".",
        "src/main/java/com/it/example",
        "src/main/java/com/it/example/api",
        "src/main/java/com/it/example/service",
    ]

    forced = _index.build_index("src", tmp_path, files, ("src/main/java",))
    assert "src/main/java" in {item["path"] for item in forced["directories"]}


def test_forced_splits_cannot_exceed_index_budget(tmp_path):
    splits = tuple(f"area-{index:04d}" for index in range(1000))
    files = [f"{split}/value.py" for split in splits]
    with pytest.raises(ValueError, match="survey.split"):
        _index.build_index("src", tmp_path, files, splits)


def test_task_ls_is_bounded_and_reads_only_the_captured_scope(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    files = {
        "src/main/java/com/it/example/api/A.java": "class A {}\n",
        "src/main/java/com/it/example/service/B.java": "class B {}\n",
        **{f"src/main/java/com/it/example/api/F{index:02d}.java": "class F {}\n" for index in range(20)},
    }
    source = git_source(root / "src", files)
    _workspace.init(root)
    _workspace.add_git_link(root, str(source), "src")
    _state.start_run(root, "repo-wiki/test", "writer")

    triage_packet = _state.task_start(root, "triage:src")
    assert triage_packet["ls_command"].endswith("task ls triage:src")
    root_page = _state.task_ls(root, "triage:src", ".")
    assert root_page["items"] == [
        {"path": "src/main/java/com/it/example", "kind": "directory"}
    ]

    monkeypatch.setattr(_index, "MAX_LS_BYTES", 700)
    pages = []
    after = None
    while True:
        page = _state.task_ls(
            root,
            "triage:src",
            "src/main/java/com/it/example/api",
            after,
        )
        assert len(json.dumps(page, ensure_ascii=False, indent=2).encode()) + 1 <= 700
        pages.extend(item["path"] for item in page["items"])
        if page["next_after"] is None:
            break
        assert page["truncated"]
        after = page["next_after"]
    assert pages == sorted(path for path in files if "/api/" in path)


def test_survey_task_ls_rejects_paths_outside_scope_and_uses_files_pin(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    source = tmp_path / "contracts"
    source.mkdir()
    write(source / "api/openapi.yaml", "openapi: 3.0.0\n")
    write(source / "internal/notes.md", "private\n")
    _workspace.init(root)
    _workspace.add_files_source(root, str(source), "contracts")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    complete(
        root,
        "triage:contracts",
        run / "drafts/triage/contracts.json",
        json.dumps(
            {
                "source": "contracts",
                "scopes": [
                    {"paths": ["api"], "tier": "deep"},
                    {"paths": ["internal"], "tier": "standard"},
                ],
            }
        ),
    )
    api_task = next(
        task["id"]
        for task in _state.read(root)["tasks"].values()
        if task["phase"] == "survey" and task["spec"]["scope"] == ["api"]
    )
    packet = _state.task_start(root, api_task)
    assert "index" not in packet
    assert packet["ls_command"].endswith(f"task ls {api_task}")

    (source / "api/openapi.yaml").unlink()
    write(source / "api/live-only.yaml", "changed: true\n")
    assert _state.task_ls(root, api_task, "api")["items"] == [
        {"path": "api/openapi.yaml", "kind": "file"}
    ]
    with pytest.raises(_state.StateError, match="scope"):
        _state.task_ls(root, api_task, "internal")
    with pytest.raises(_state.StateError, match="scope"):
        _state.task_ls(root, api_task, ".")
    with pytest.raises(_state.StateError, match="relative"):
        _state.task_ls(root, api_task, "../api")

    pin = _workspace.pin_dir(root, state["run_id"], "contracts")
    write(pin / "api/tampered.yaml", "changed: true\n")
    with pytest.raises(_workspace.WorkspaceError, match="drifted"):
        _state.task_ls(root, api_task, "api")


def test_triage_requires_exact_coverage_and_configured_split(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(
        root / "src",
        {"app.py": "VALUE = 1\n", "core/engine.py": "VALUE = 2\n"},
    )
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    config = json.loads((root / "workspace.json").read_text())
    config["sources"][0]["survey"] = {"split": ["core/"]}
    write(root / "workspace.json", json.dumps(config))
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    _state.task_start(root, "triage:src")
    write(
        run / "drafts/triage/src.json",
        json.dumps(
            {
                "source": "src",
                "scopes": [
                    {
                        "paths": ["."],
                        "tier": "deep",
                        "orientation": "whole source",
                    }
                ],
            }
        ),
    )
    result = _state.task_complete(root, "triage:src")
    assert not result["ok"]
    assert "triage-split-missing" in {item["code"] for item in result["issues"]}

    write(
        run / "drafts/triage/src.json",
        json.dumps(
            {
                "source": "src",
                "scopes": [
                    {"paths": ["app.py"], "tier": "deep"},
                    {"paths": ["core"], "tier": "standard"},
                ],
            }
        ),
    )
    assert _state.task_complete(root, "triage:src")["ok"]
    assert sorted(survey_tasks(root).values()) == [["app.py"], ["core"]]


def test_triage_rejects_absolute_scope_paths(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(root / "src", {"api/app.py": "VALUE = 1\n"})
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    _state.task_start(root, "triage:src")
    write(
        run / "drafts/triage/src.json",
        json.dumps(
            {
                "source": "src",
                "scopes": [{"paths": ["/api"], "tier": "deep"}],
            }
        ),
    )
    result = _state.task_complete(root, "triage:src")
    assert not result["ok"]
    assert "triage-path-invalid" in {item["code"] for item in result["issues"]}


def test_files_triage_uses_the_captured_pin(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    contracts = tmp_path / "contracts"
    contracts.mkdir()
    write(contracts / "openapi.yaml", "openapi: 3.0.0\n")
    _workspace.init(root)
    _workspace.add_files_source(root, str(contracts), "contracts")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])

    (contracts / "openapi.yaml").unlink()
    write(contracts / "live-only.yaml", "changed: true\n")
    complete(
        root,
        "triage:contracts",
        run / "drafts/triage/contracts.json",
        json.dumps(
            {
                "source": "contracts",
                "scopes": [{"paths": ["openapi.yaml"], "tier": "deep"}],
            }
        ),
    )


def test_single_path_scopes_have_collision_proof_target_ids(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(
        root / "src",
        {"a-b/value.py": "A = 1\n", "a/b/value.py": "B = 2\n"},
    )
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    complete(
        root,
        "triage:src",
        _state.run_dir(root, state["run_id"]) / "drafts/triage/src.json",
        json.dumps(
            {
                "source": "src",
                "scopes": [
                    {"paths": ["a-b"], "tier": "deep"},
                    {"paths": ["a/b"], "tier": "deep"},
                ],
            }
        ),
    )
    assert len(survey_tasks(root)) == 2


def test_inventory_scope_is_coverage_only_and_skips_survey(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(
        root / "src",
        {
            "app.py": "VALUE = 1\n",
            "models/a.py": "class A: pass\n",
            "models/b.py": "class B: pass\n",
        },
    )
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    complete(
        root,
        "triage:src",
        run / "drafts/triage/src.json",
        json.dumps(
            {
                "source": "src",
                "scopes": [
                    {"paths": ["app.py"], "tier": "deep"},
                    {
                        "paths": ["models"],
                        "tier": "inventory",
                        "reason": "passive data shapes",
                        "samples": ["src/models/a.py#L1"],
                    },
                ],
            }
        ),
    )
    tasks = survey_tasks(root)
    assert list(tasks.values()) == [["app.py"]]
    assert not any("inventory" in task["name"] for task in _state.read(root)["tasks"].values())


def test_inventory_rejects_protected_paths_but_allows_generated_without_samples(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(
        root / "src",
        {"app.py": "VALUE = 1\n", "generated/client.py": "# generated file\n"},
    )
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    _state.task_start(root, "triage:src")
    artifact = run / "drafts/triage/src.json"
    write(
        artifact,
        json.dumps(
            {
                "source": "src",
                "scopes": [
                    {
                        "paths": ["app.py"],
                        "tier": "inventory",
                        "reason": "looks small",
                        "samples": ["src/app.py#L1"],
                    },
                    {
                        "paths": ["generated"],
                        "tier": "inventory",
                        "reason": "generated output",
                    },
                ],
            }
        ),
    )
    rejected = _state.task_complete(root, "triage:src")
    assert "inventory-protected-path" in {
        item["code"] for item in rejected["issues"]
    }

    data = json.loads(artifact.read_text())
    data["scopes"][0]["tier"] = "deep"
    data["scopes"][0].pop("reason")
    data["scopes"][0].pop("samples")
    write(artifact, json.dumps(data))
    assert _state.task_complete(root, "triage:src")["ok"]


def test_survey_completion_materializes_and_rebuilds_evidence_cache(
    tmp_path, monkeypatch
):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(root / "src", {"core/answer.py": "def answer():\n    return 42\n"})
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    complete(
        root,
        "triage:src",
        run / "drafts/triage/src.json",
        json.dumps(
            {
                "source": "src",
                "scopes": [{"paths": ["core"], "tier": "deep"}],
            }
        ),
    )
    target = _state._scope_name("src", ["core"])
    packet = _state.task_start(root, f"survey:{target}")
    assert "evidence_dir" not in packet
    write(
        run / f"drafts/survey/{target}.json",
        json.dumps(
            {
                "source": "src",
                "target": target,
                "findings": [
                    {
                        "id": "answer",
                        "claim": "answer entry point",
                        "evidence": ["src/core/answer.py#L1-L2"],
                        "domain": "core",
                    }
                ],
                "gaps": [],
            }
        ),
    )
    assert _state.task_complete(root, f"survey:{target}")["ok"]
    cache = run / f"drafts/evidence/{target}.json"
    evidence = json.loads(cache.read_text())
    assert evidence["target"] == target
    assert len(evidence["pin"]) == 40
    assert evidence["window"] == {"version": 2, "lines": 20}
    assert evidence["findings"][0]["excerpts"][0]["locator"] == "src/core/answer.py#L1-L2"
    assert "1|def answer():" in evidence["findings"][0]["excerpts"][0]["text"]

    with monkeypatch.context() as patch:
        patch.setattr(
            _index,
            "materialize_survey",
            lambda *_: pytest.fail("valid cache was rebuilt"),
        )
        assert _index.ensure_evidence_cache(root, _state.read(root)) == [cache]

    forged = json.loads(cache.read_text())
    excerpt = forged["findings"][0]["excerpts"][0]
    excerpt["text"] = "1|forged = True\n"
    excerpt["digest"] = hashlib.sha256(excerpt["text"].encode()).hexdigest()
    write(cache, json.dumps(forged))
    plan_packet = _state.task_start(root, "plan:src")
    assert str(cache) in plan_packet["inputs"]
    assert "forged" not in cache.read_text()


def test_connect_edge_belongs_to_lowest_participant(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    for name in ("api", "web"):
        git_source(root / name, {"app.py": "VALUE = 1\n"})
    _workspace.init(root)
    for name in ("api", "web"):
        _workspace.add_git_link(root, str(root / name), name)
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])
    for name in ("api", "web"):
        complete(
            root,
            f"triage:{name}",
            run / f"drafts/triage/{name}.json",
            json.dumps(
                {
                    "source": name,
                    "scopes": [{"paths": ["."], "tier": "deep"}],
                }
            ),
        )
    for name in ("api", "web"):
        _state.task_start(root, f"survey:{name}")
        write(
            run / f"drafts/survey/{name}.json",
            json.dumps(
                {
                    "source": name,
                    "target": name,
                    "findings": [
                        {
                            "id": f"{name}-entry",
                            "claim": "entry point",
                            "evidence": [f"{name}/app.py#L1"],
                            "domain": "core",
                        }
                    ],
                    "gaps": [],
                }
            ),
        )
        assert _state.task_complete(root, f"survey:{name}")["ok"]

    edge = {
        "id": "web-calls-api",
        "participants": [
            {"source": "web", "evidence": ["web/app.py#L1"]},
            {"source": "api", "evidence": ["api/app.py#L1"]},
        ],
        "contract": "HTTP boundary",
        "contract_evidence": [],
        "failure_propagation": "api errors surface in web",
    }
    _state.task_start(root, "connect:web")
    write(
        run / "drafts/connect/web.json",
        json.dumps({"source": "web", "connections": [edge], "gaps": []}),
    )
    rejected = _state.task_complete(root, "connect:web")
    assert not rejected["ok"]
    assert {item["code"] for item in rejected["issues"]} == {
        "connection-owner-invalid"
    }
    write(
        run / "drafts/connect/web.json",
        json.dumps({"source": "web", "connections": [], "gaps": []}),
    )
    assert _state.task_complete(root, "connect:web")["ok"]
    _state.task_start(root, "connect:api")
    write(
        run / "drafts/connect/api.json",
        json.dumps({"source": "api", "connections": [edge], "gaps": []}),
    )
    assert _state.task_complete(root, "connect:api")["ok"]


def test_duplicate_edge_across_tasks_fails_composed_plan(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    for name in ("api", "web"):
        git_source(root / name, {"app.py": "VALUE = 1\n"})
    _workspace.init(root)
    for name in ("api", "web"):
        _workspace.add_git_link(root, str(root / name), name)
    _state.start_run(root, "repo-wiki/test", "writer")
    state = _state.read(root)
    run = _state.run_dir(root, state["run_id"])

    def edge(edge_id: str) -> dict:
        return {
            "id": edge_id,
            "participants": [
                {"source": "web", "evidence": ["web/app.py#L1"]},
                {"source": "api", "evidence": ["api/app.py#L1"]},
            ],
            "contract": "HTTP boundary",
            "contract_evidence": [],
            "failure_propagation": "api errors surface in web",
        }

    write(
        run / "drafts/connect/api.json",
        json.dumps({"source": "api", "connections": [edge("web-calls-api")], "gaps": []}),
    )
    write(
        run / "drafts/connect/web.json",
        json.dumps({"source": "web", "connections": [edge("api-serves-web")], "gaps": []}),
    )
    write(
        run / "drafts/plan/stub.json",
        json.dumps({"source": None, "pages": [], "exclusions": []}),
    )
    codes = {
        item.code for item in _validate.validate_composed_plan(root, state)
    }
    assert "connection-duplicate-edge" in codes


def test_zh_survey_budget_is_wider(tmp_path):
    per_file_en = _validate.survey_budget({"language": "en", "tasks": {}})
    per_file_zh = _validate.survey_budget({"language": "zh", "tasks": {}})
    assert per_file_zh == per_file_en * 2


def test_zh_log_uses_localized_headings(tmp_path):
    bundle = tmp_path / "bundle"
    write(
        bundle / "one.md",
        "---\ntype: Note\ntitle: 概览\nstatus: stable\nstale_after: 2099-01-01\n"
        "generated: {by: repo-wiki/test, at: 2026-01-01T00:00:00Z}\n"
        "verified: [{by: repo-wiki/reviewer, at: 2026-01-01T00:00:00Z}]\n---\n正文\n",
    )
    indexes = _publish.render_indexes(bundle, "zh")
    log = _publish.render_log(bundle, None, "run-1", "zh")["log.md"]
    assert "# 概念" in indexes["index.md"]
    assert log.startswith("# Wiki 更新日志")
    assert "**新增**" in log
    write(bundle / "log.md", log)
    second = tmp_path / "second"
    second.mkdir()
    write(second / "one.md", (bundle / "one.md").read_text() + "更新\n")
    updated = _publish.render_log(second, bundle, "run-2", "zh")["log.md"]
    assert updated.startswith("# Wiki 更新日志")
    assert "**更新**" in updated and updated.count("# Wiki 更新日志") == 1


def test_causal_regex_covers_chinese_connectives():
    for text in ("因为超时而重试", "由于锁竞争", "以致状态丢失", "从而绕过缓存"):
        assert _validate.CAUSAL.search(text), text
    assert not _validate.CAUSAL.search("这是普通描述")


def test_invalid_survey_config_is_rejected(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(root / "src", {"app.py": "VALUE = 1\n"})
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    config = json.loads((root / "workspace.json").read_text())
    config["sources"][0]["survey"] = {"split": ["../escape"]}
    write(root / "workspace.json", json.dumps(config))
    with pytest.raises(_workspace.WorkspaceError, match="survey.split"):
        _workspace.load(root)


def test_survey_split_cannot_be_inside_an_excluded_path(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(root / "src", {"core/api/app.py": "VALUE = 1\n"})
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    config = json.loads((root / "workspace.json").read_text())
    config["sources"][0]["survey"] = {
        "split": ["core/api"],
        "exclude": ["core"],
    }
    write(root / "workspace.json", json.dumps(config))
    with pytest.raises(_workspace.WorkspaceError, match="inside survey.exclude"):
        _workspace.load(root)
