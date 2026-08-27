import json
import pathlib
import subprocess

import _publish
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


def survey_tasks(root: pathlib.Path) -> dict[str, list[str]]:
    state = _state.read(root)
    return {
        task["name"]: task["spec"]["scope"]
        for task in state["tasks"].values()
        if task["phase"] == "survey"
    }


def test_small_source_yields_single_scope(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(root / "src", {"app.py": "VALUE = 1\n", "lib/util.py": "VALUE = 2\n"})
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    _state.start_run(root, "repo-wiki/test", "writer")
    tasks = survey_tasks(root)
    assert tasks == {"src": ["app.py", "lib"]}


def test_oversized_directory_is_recursively_split(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    files = {"pom.xml": "<project/>\n"}
    for module in ("orders", "billing"):
        for index in range(150):
            files[f"src/main/java/com/acme/{module}/C{index}.java"] = "class C {}\n"
    git_source(root / "big", files)
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "big"), "big")
    _state.start_run(root, "repo-wiki/test", "writer")
    tasks = survey_tasks(root)
    assert len(tasks) > 1
    scopes = sorted(scope for value in tasks.values() for scope in value)
    assert "src/main/java/com/acme/billing" in scopes
    assert "src/main/java/com/acme/orders" in scopes
    assert "pom.xml" in scopes
    seen = set()
    for value in tasks.values():
        for scope in value:
            assert scope not in seen
            seen.add(scope)


def test_survey_split_and_exclude_steer_scopes(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    git_source(
        root / "src",
        {
            "core/engine.py": "VALUE = 1\n",
            "core/rules.py": "VALUE = 2\n",
            "vendor/lib.js": "VALUE = 3\n",
        },
    )
    _workspace.init(root)
    _workspace.add_git_link(root, str(root / "src"), "src")
    config = json.loads((root / "workspace.json").read_text())
    config["sources"][0]["survey"] = {"split": ["core"], "exclude": ["vendor"]}
    write(root / "workspace.json", json.dumps(config))
    _state.start_run(root, "repo-wiki/test", "writer")
    tasks = survey_tasks(root)
    assert tasks == {"src/core": ["core"]}


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
    per_file_en, total_en = _validate.survey_budget({"language": "en", "tasks": {}})
    per_file_zh, total_zh = _validate.survey_budget({"language": "zh", "tasks": {}})
    assert per_file_zh == per_file_en * 2
    many = {
        f"survey:s{index}": {"phase": "survey"} for index in range(20)
    }
    _, total_many = _validate.survey_budget({"language": "en", "tasks": many})
    assert total_many == 20 * per_file_en > total_en


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
