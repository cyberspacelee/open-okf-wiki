"""YAML config, ignores, and manual retry tests."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from okf_wiki.cli import _wiki_run_request, main, parser
from okf_wiki.host import (
    DEFAULT_SOURCE_IGNORES,
    WikiRunRequest,
    resolve_effective_source_ignores,
)
from okf_wiki.host.snapshots import _materialize_repository_snapshot

from wiki_run_helpers import (
    TEST_WIKI_LIMITS,
    make_producer_skill,
    make_repository,
)


@pytest.mark.parametrize(
    "key",
    [
        "api_key",
        "apiKey",
        "openaiApiKey",
        "authorizationHeader",
        "apiKeyValue",
        "accessKeyId",
        "providerCookie",
    ],
)
def test_wiki_run_yaml_rejects_secrets_without_echoing_them(tmp_path: Path, key: str) -> None:
    secret = "must-not-appear-in-errors"
    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        f"""version: 1
operation: generate
model: openai:gpt-5-mini
{key}: {secret}
staging: ./staging
publication: ./published
repositories: []
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError) as captured:
        WikiRunRequest.from_yaml(config)

    assert secret not in str(captured.value)


def test_wiki_run_yaml_validation_errors_include_field_paths(tmp_path: Path) -> None:
    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        """version: 1
model: openai:gpt-5-mini
staging: ./staging
publication: ./published
repositories:
  - id: app
    path: ./source
    branch: main
limits:
  not_a_limit: 1
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError) as captured:
        WikiRunRequest.from_yaml(config)

    message = str(captured.value)
    assert message.startswith("Wiki Run YAML configuration is invalid:")
    assert "not_a_limit" in message
    assert "input_value" not in message


def test_wiki_run_yaml_limit_value_errors_include_field_paths(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("x\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "x"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True
    ).stdout.strip()

    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        f"""version: 1
model: openai:gpt-5-mini
staging: ./staging
publication: ./published
repositories:
  - id: app
    path: ./source
    revision: {revision}
limits:
  request_limit: 0
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError) as captured:
        WikiRunRequest.from_yaml(config)

    message = str(captured.value)
    assert message.startswith("Wiki Run YAML configuration is invalid:")
    assert "request_limit" in message
    assert "input_value" not in message


def test_wiki_run_yaml_parse_errors_include_detail(tmp_path: Path) -> None:
    config = tmp_path / "wiki-run.yaml"
    config.write_text("version: 1\nmodel: [\n", encoding="utf-8")

    with pytest.raises(ValueError) as captured:
        WikiRunRequest.from_yaml(config)

    message = str(captured.value)
    assert message.startswith("Wiki Run YAML is not readable valid UTF-8 YAML:")
    assert len(message) > len("Wiki Run YAML is not readable valid UTF-8 YAML:")


def test_wiki_run_yaml_optional_reviewer_model_falls_back_when_omitted(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("x\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "x"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True
    ).stdout.strip()

    bare = tmp_path / "bare.yaml"
    bare.write_text(
        f"""version: 1
model: openai:gpt-5-mini
staging: ./staging
publication: ./published
repositories:
  - id: app
    path: ./source
    revision: {revision}
""",
        encoding="utf-8",
    )
    with_reviewer = tmp_path / "with-reviewer.yaml"
    with_reviewer.write_text(
        f"""version: 1
model: openai:gpt-5-mini
reviewer_model: openai:gpt-4o-mini
staging: ./staging
publication: ./published
repositories:
  - id: app
    path: ./source
    revision: {revision}
""",
        encoding="utf-8",
    )

    bare_request = WikiRunRequest.from_yaml(bare)
    assert bare_request.reviewer_model is None
    reviewer_request = WikiRunRequest.from_yaml(with_reviewer)
    assert reviewer_request.reviewer_model is not None
    assert reviewer_request.reviewer_model.model == "openai:gpt-4o-mini"
    assert reviewer_request.model.model == "openai:gpt-5-mini"


def test_resolve_effective_source_ignores_unions_defaults_with_user_ignore() -> None:
    assert resolve_effective_source_ignores(
        apply_default_source_ignores=True,
        user_ignore=("generated/**",),
    ) == DEFAULT_SOURCE_IGNORES + ("generated/**",)
    assert resolve_effective_source_ignores(
        apply_default_source_ignores=False,
        user_ignore=("generated/**",),
    ) == ("generated/**",)
    frozen = ("custom/**",)
    assert (
        resolve_effective_source_ignores(
            apply_default_source_ignores=True,
            user_ignore=("generated/**",),
            frozen_effective_ignore=frozen,
        )
        == frozen
    )


def test_default_source_ignores_exclude_noise_but_keep_tests(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("source\n", encoding="utf-8")
    (source / "node_modules").mkdir()
    (source / "node_modules" / "pkg.js").write_text("noise\n", encoding="utf-8")
    (source / "dist").mkdir()
    (source / "dist" / "out.js").write_text("built\n", encoding="utf-8")
    (source / "tests").mkdir()
    (source / "tests" / "test_app.py").write_text(
        "def test_ok():\n    assert True\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "."], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "tree"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    with_defaults = tmp_path / "with_defaults"
    _materialize_repository_snapshot(
        source,
        revision,
        with_defaults,
        TEST_WIKI_LIMITS,
        ignore=resolve_effective_source_ignores(
            apply_default_source_ignores=True,
            user_ignore=(),
        ),
        used_files=0,
        used_bytes=0,
    )
    assert (with_defaults / "README.md").is_file()
    assert (with_defaults / "tests" / "test_app.py").is_file()
    assert not (with_defaults / "node_modules").exists()
    assert not (with_defaults / "dist").exists()

    without_defaults = tmp_path / "without_defaults"
    _materialize_repository_snapshot(
        source,
        revision,
        without_defaults,
        TEST_WIKI_LIMITS,
        ignore=resolve_effective_source_ignores(
            apply_default_source_ignores=False,
            user_ignore=(),
        ),
        used_files=0,
        used_bytes=0,
    )
    assert (without_defaults / "node_modules" / "pkg.js").is_file()
    assert (without_defaults / "dist" / "out.js").is_file()


def test_yaml_apply_default_source_ignores_false(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        "\n".join(
            [
                "version: 1",
                "operation: generate",
                "model: openai:gpt-5-mini",
                "staging: ./staging",
                "publication: ./wiki",
                "repositories:",
                "  - id: application",
                f"    path: {source}",
                f"    revision: {revision}",
                "    apply_default_source_ignores: false",
                "    ignore:",
                '      - "generated/**"',
            ]
        ),
        encoding="utf-8",
    )
    request = WikiRunRequest.from_yaml(config)
    assert request.repositories[0].apply_default_source_ignores is False
    assert request.repositories[0].effective_source_ignores() == ("generated/**",)


def test_manual_retry_requires_frozen_effective_ignore(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    record = {
        "schema_version": 1,
        "run_id": "a" * 32,
        "status": "failed",
        "operation": "generate",
        "repositories": [
            {
                "id": "source",
                "path": str(source.resolve()),
                "revision": revision,
                "ignore": [],
            }
        ],
        "skill": {"path": str(skill.path), "digest": skill.digest},
        "model": {"identity": "test", "replayable": True, "settings": {}},
        "limits": TEST_WIKI_LIMITS.model_dump(mode="json"),
        "explicit_answers": {},
        "started_at": "2026-07-16T00:00:00+00:00",
        "completed_at": "2026-07-16T00:00:01+00:00",
        "duration_seconds": 1.0,
        "usage": {},
        "retry_counters": {},
        "publication": {"status": "unchanged"},
        "failure_category": "RuntimeError",
    }
    path = tmp_path / "record.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    with pytest.raises(ValueError, match="frozen effective_ignore"):
        WikiRunRequest.from_run_record(
            path,
            staging=tmp_path / "staging",
            publication=tmp_path / "published",
            model="test",
        )


def test_manual_retry_reuses_frozen_effective_ignore(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    frozen = ("frozen-only/**",)
    record = {
        "schema_version": 1,
        "run_id": "b" * 32,
        "status": "failed",
        "operation": "generate",
        "repositories": [
            {
                "id": "source",
                "path": str(source.resolve()),
                "revision": revision,
                "apply_default_source_ignores": True,
                "ignore": ["user/**"],
                "effective_ignore": list(frozen),
            }
        ],
        "skill": {"path": str(skill.path), "digest": skill.digest},
        "model": {"identity": "test", "replayable": True, "settings": {}},
        "limits": TEST_WIKI_LIMITS.model_dump(mode="json"),
        "explicit_answers": {},
        "started_at": "2026-07-16T00:00:00+00:00",
        "completed_at": "2026-07-16T00:00:01+00:00",
        "duration_seconds": 1.0,
        "usage": {},
        "retry_counters": {},
        "publication": {"status": "unchanged"},
        "failure_category": "RuntimeError",
    }
    path = tmp_path / "record.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    request = WikiRunRequest.from_run_record(
        path,
        staging=tmp_path / "staging",
        publication=tmp_path / "published",
        model="test",
    )
    assert request.repositories[0].effective_source_ignores() == frozen
    assert request.repositories[0].ignore == ("user/**",)


def test_ignore_patterns_skip_non_file_tree_entries(tmp_path: Path) -> None:
    dependency = tmp_path / "dependency"
    make_repository(dependency, "dependency\n")

    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    (source / "README.md").write_text("source\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=source, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            str(dependency),
            "vendor/lib",
        ],
        cwd=source,
        check=True,
    )
    subprocess.run(["git", "commit", "-qm", "gitlink"], cwd=source, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=source,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    target = tmp_path / "materialized"
    used_files, used_bytes = _materialize_repository_snapshot(
        source,
        revision,
        target,
        TEST_WIKI_LIMITS,
        ignore=("vendor/lib",),
        used_files=0,
        used_bytes=0,
    )

    assert (target / "README.md").read_text(encoding="utf-8") == "source\n"
    assert not (target / "vendor").exists()
    materialized_files = [path for path in target.rglob("*") if path.is_file()]
    assert used_files == len(materialized_files) == 2
    assert used_bytes == sum(path.stat().st_size for path in materialized_files)


def test_wiki_run_defaults_to_local_wiki_run_yaml(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    config = tmp_path / "wiki-run.yaml"
    config.write_text(
        f"""version: 1
model: test
staging: ./staging
publication: ./published
repositories:
  - id: source
    path: ./source
    revision: {revision}
""",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    arguments = parser().parse_args(["wiki-run"])
    request = _wiki_run_request(arguments)
    assert request.repositories[0].path == source.resolve()
    assert request.staging == (tmp_path / "staging").resolve()


def test_wiki_run_without_config_or_direct_args_explains_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    arguments = parser().parse_args(["wiki-run"])
    with pytest.raises(ValueError, match="wiki-run.yaml"):
        _wiki_run_request(arguments)


def test_init_writes_wiki_run_yaml(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "repo"
    make_repository(source, "source\n")
    config = tmp_path / "wiki-run.yaml"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "init",
            "--config",
            str(config),
            "--source",
            str(source),
            "--source-id",
            "app",
            "--model",
            "openai:gpt-5-mini",
        ],
    )
    assert main() == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert Path(payload["init"]["config"]) == config
    text = config.read_text(encoding="utf-8")
    assert "version: 1" in text
    assert "id: app" in text
    assert "apply_default_source_ignores: true" in text
    assert "write_visualization: false" in text
    request = WikiRunRequest.from_yaml(config)
    assert request.repositories[0].id == "app"
    assert request.repositories[0].path == source.resolve()
    assert request.write_visualization is False
