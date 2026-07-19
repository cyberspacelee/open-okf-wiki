"""CLI and init command tests for Wiki Run."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from okf_wiki.cli import main, parser
from okf_wiki.run import (
    NeedsInput,
    ProducerSkillFork,
    ProducerSkillVersion,
    WikiRunApplication,
    WikiRunLimits,
    WikiRunResourceLimitError,
    WikiRunRequest,
)

from wiki_run_helpers import (
    make_repository,
)


def test_wiki_run_cli_exposes_wall_clock_deadline() -> None:
    arguments = parser().parse_args(
        [
            "wiki-run",
            "source",
            "--source-revision",
            "0" * 40,
            "--skill",
            "skill",
            "--skill-digest",
            "0" * 64,
            "--staging",
            "staging",
            "--publication",
            "published",
            "--model",
            "test",
            "--wall-clock-timeout-seconds",
            "7",
            "--source-files-limit",
            "11",
            "--source-file-bytes-limit",
            "12",
            "--source-total-bytes-limit",
            "13",
            "--wiki-entries-limit",
            "14",
            "--wiki-file-bytes-limit",
            "15",
            "--wiki-total-bytes-limit",
            "16",
            "--wiki-write-bytes-limit",
            "17",
        ]
    )

    assert arguments.wall_clock_timeout_seconds == 7
    assert arguments.source_files_limit == 11
    assert arguments.source_file_bytes_limit == 12
    assert arguments.source_total_bytes_limit == 13
    assert arguments.wiki_entries_limit == 14
    assert arguments.wiki_file_bytes_limit == 15
    assert arguments.wiki_total_bytes_limit == 16
    assert arguments.wiki_write_bytes_limit == 17
    assert arguments.publication == Path("published")
    assert arguments.auto_approve_publication is False
    assert WikiRunLimits.model_fields.keys() <= vars(arguments).keys()


def test_wiki_run_cli_exposes_reviewer_model_flag() -> None:
    arguments = parser().parse_args(
        [
            "wiki-run",
            "source",
            "--source-revision",
            "0" * 40,
            "--staging",
            "staging",
            "--publication",
            "published",
            "--reviewer-model",
            "openai:gpt-4o-mini",
        ]
    )
    assert arguments.reviewer_model == "openai:gpt-4o-mini"


def test_wiki_run_cli_yes_and_yolo_enable_auto_approve_publication() -> None:
    yes_args = parser().parse_args(
        [
            "wiki-run",
            "source",
            "--source-revision",
            "0" * 40,
            "--staging",
            "staging",
            "--publication",
            "published",
            "--yes",
        ]
    )
    yolo_args = parser().parse_args(
        [
            "wiki-run",
            "source",
            "--source-revision",
            "0" * 40,
            "--staging",
            "staging",
            "--publication",
            "published",
            "--yolo",
        ]
    )
    assert yes_args.auto_approve_publication is True
    assert yolo_args.auto_approve_publication is True


def test_cli_exposes_only_the_greenfield_product_commands() -> None:
    command = parser()
    subcommands = next(action for action in command._actions if action.dest == "command")

    assert subcommands.choices is not None
    assert tuple(subcommands.choices) == (
        "init",
        "wiki-run",
        "wiki-retry",
        "tui",
        "wiki-eval",
        "skill-fork",
        "skill-inspect",
        "viz",
        "doctor",
    )


def test_init_refuses_to_overwrite_without_force(tmp_path: Path) -> None:
    from okf_wiki.run.init_config import write_wiki_run_config

    config = tmp_path / "wiki-run.yaml"
    write_wiki_run_config(config)
    with pytest.raises(ValueError, match="already exists"):
        write_wiki_run_config(config)


def test_init_into_directory_creates_project_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "repo"
    make_repository(source, "source\n")
    project = tmp_path / "projects" / "wiki-app"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "init",
            str(project),
            "--source",
            str(source),
            "--source-id",
            "app",
        ],
    )
    assert main() == 0
    payload = json.loads(capsys.readouterr().out)
    config = project / "wiki-run.yaml"
    assert payload["ok"] is True
    assert Path(payload["init"]["config"]) == config
    assert Path(payload["init"]["directory"]) == project.resolve()
    assert config.is_file()
    assert project.is_dir()
    text = config.read_text(encoding="utf-8")
    assert "staging: .okf-wiki/staging" in text
    request = WikiRunRequest.from_yaml(config)
    assert request.repositories[0].path == source.resolve()
    assert request.staging == (project / ".okf-wiki" / "staging").resolve()
    assert request.publication == (project / ".okf-wiki" / "wiki").resolve()


def test_init_directory_with_relative_config_name(tmp_path: Path) -> None:
    from okf_wiki.run.init_config import write_wiki_run_config

    project = tmp_path / "nested" / "proj"
    written = write_wiki_run_config(Path("run.yaml"), directory=project)
    assert written == project / "run.yaml"
    assert written.is_file()


def test_wiki_run_cli_loads_config_dotenv_without_overriding_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    source = project / "source"
    revision = make_repository(source, "source\n")
    config = project / "wiki-run.yaml"
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
    (project / ".env").write_text(
        "OPENAI_API_KEY=from-config\nOPENAI_BASE_URL=https://config.example/v1\n",
        encoding="utf-8",
    )
    caller = tmp_path / "caller"
    caller.mkdir()
    (caller / ".env").write_text("OPENAI_BASE_URL=https://caller.example/v1\n", encoding="utf-8")
    monkeypatch.chdir(caller)
    monkeypatch.setenv("OPENAI_API_KEY", "from-process")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    captured: dict[str, str | None] = {}

    async def run(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        captured.update(
            api_key=os.getenv("OPENAI_API_KEY"),
            base_url=os.getenv("OPENAI_BASE_URL"),
        )
        return NeedsInput(questions=["Done?"])

    monkeypatch.setattr(WikiRunApplication, "run", run)
    monkeypatch.setattr("sys.argv", ["okf-wiki", "wiki-run", "--config", str(config)])

    assert main() == 0
    assert captured == {
        "api_key": "from-process",
        "base_url": "https://config.example/v1",
    }


def test_wiki_run_cli_withholds_secret_bearing_provider_diagnostics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = "wiki-run-provider-secret"
    monkeypatch.setenv("OPENAI_API_KEY", secret)

    async def fail(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        raise RuntimeError(f"provider Authorization: Bearer {secret}")

    monkeypatch.setattr(WikiRunApplication, "run", fail)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "test",
        ],
    )

    assert main() == 1

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    payload = json.loads(captured.out)
    assert payload["ok"] is False
    assert payload["error"]["message"] == "RuntimeError: provider diagnostics withheld"
    assert payload["error"]["type"] == "RuntimeError"
    # Message stays withheld, but a redacted stack is still available for debugging.
    assert "traceback" in payload["error"]
    assert secret not in payload["error"]["traceback"]
    assert "Traceback" in payload["error"]["traceback"]
    assert "Authorization: Bearer" not in payload["error"]["traceback"]
    assert "Traceback" in captured.err
    assert secret not in captured.err


def test_wiki_run_cli_preserves_explicit_resource_limit_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fail(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        raise WikiRunResourceLimitError("Agent usage quota was exceeded")

    monkeypatch.setattr(WikiRunApplication, "run", fail)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "test",
        ],
    )

    assert main() == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["ok"] is False
    assert payload["error"]["message"] == "Agent usage quota was exceeded"
    assert payload["error"]["type"] == "WikiRunResourceLimitError"
    assert "Agent usage quota was exceeded" in payload["error"]["traceback"]
    assert "WikiRunResourceLimitError" in payload["error"]["traceback"]
    assert "Traceback" in captured.err


def test_wiki_run_cli_includes_traceback_for_operator_config_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            "--config",
            str(tmp_path / "missing-wiki-run.yaml"),
        ],
    )

    assert main() == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["ok"] is False
    assert payload["error"]["type"] in {"ConfigError", "ValueError", "FileNotFoundError", "OSError"}
    assert "traceback" in payload["error"]
    assert "Traceback" in payload["error"]["traceback"]
    assert "Traceback" in captured.err


def test_wiki_run_cli_error_dump_writes_redacted_diagnostics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    dump = tmp_path / "failure.diag.txt"
    secret = "dump-secret-value"
    monkeypatch.setenv("OPENAI_API_KEY", secret)

    async def fail(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        raise RuntimeError(f"provider Authorization: Bearer {secret}")

    monkeypatch.setattr(WikiRunApplication, "run", fail)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "test",
            "--error-dump",
            str(dump),
        ],
    )

    assert main() == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["error"]["error_dump"] == str(dump.resolve())
    assert dump.is_file()
    text = dump.read_text(encoding="utf-8")
    assert secret not in text
    assert "error_type: RuntimeError" in text
    assert "Traceback" in text
    assert "Authorization: Bearer" not in text
    assert str(dump) in captured.err or "error diagnostics" in captured.err


def test_wiki_run_cli_includes_traceback_for_runtime_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fail(_: WikiRunApplication, __: WikiRunRequest) -> NeedsInput:
        raise RuntimeError("model transport failed: connection reset")

    monkeypatch.setattr(WikiRunApplication, "run", fail)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "test",
        ],
    )

    assert main() == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["ok"] is False
    # Clean RuntimeError text is surfaced after redaction (not type-allowlisted away).
    assert payload["error"]["type"] == "RuntimeError"
    assert "connection reset" in payload["error"]["message"]
    assert "traceback" in payload["error"]
    assert "connection reset" in payload["error"]["traceback"]
    assert "Traceback" in captured.err
    assert "connection reset" in captured.err


def test_doctor_cli_reports_credentials_without_raw_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = "doctor-cli-secret-never-emit"
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_ORG_ID", raising=False)
    monkeypatch.delenv("OPENAI_PROJECT_ID", raising=False)
    (tmp_path / ".env").write_text(f"OPENAI_API_KEY={secret}\n", encoding="utf-8")
    monkeypatch.setattr("sys.argv", ["okf-wiki", "doctor"])

    assert main() == 0
    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    payload = json.loads(captured.out)
    assert payload["ok"] is True
    by_name = {item["name"]: item for item in payload["doctor"]["credentials"]}
    assert by_name["OPENAI_API_KEY"]["status"] == "set"
    assert by_name["OPENAI_API_KEY"]["length"] == len(secret)
    assert by_name["OPENAI_API_KEY"]["source"] == "dotenv"
    assert secret not in by_name["OPENAI_API_KEY"]["preview"]
    assert "OPENAI_API_KEY: set" in captured.err
    assert secret not in captured.err


def test_wiki_run_cli_preflight_missing_openai_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.setattr(
        "sys.argv",
        [
            "okf-wiki",
            "wiki-run",
            str(tmp_path / "source"),
            "--source-revision",
            "0" * 40,
            "--staging",
            str(tmp_path / "staging"),
            "--publication",
            str(tmp_path / "published"),
            "--model",
            "openai:gpt-5-mini",
        ],
    )

    assert main() == 1
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["ok"] is False
    assert payload["error"]["type"] == "ConfigError"
    assert "OPENAI_API_KEY" in payload["error"]["message"]
    assert ".env" in payload["error"]["message"]
    assert "provider diagnostics withheld" not in payload["error"]["message"]


def test_skill_fork_cli_creates_an_owned_copy_of_the_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    destination = tmp_path / "my-skill"
    monkeypatch.setattr("sys.argv", ["okf-wiki", "skill-fork", str(destination)])

    assert main() == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload == {
        "ok": True,
        "skill_fork": {
            "digest": ProducerSkillVersion.default().digest,
            "path": str(destination),
        },
    }
    assert (
        ProducerSkillVersion.from_directory(destination).digest == payload["skill_fork"]["digest"]
    )


def test_skill_inspect_cli_reports_the_current_resolved_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    fork = ProducerSkillFork.create(ProducerSkillVersion.default(), Path("my-skill"))
    guidance = fork.path / "references/generate.md"
    guidance.write_text(guidance.read_text(encoding="utf-8") + "\nAudience: operators\n")
    expected = fork.version()
    monkeypatch.setattr("sys.argv", ["okf-wiki", "skill-inspect", "my-skill"])

    assert main() == 0

    assert json.loads(capsys.readouterr().out) == {
        "ok": True,
        "skill_version": {"digest": expected.digest, "path": str(expected.path)},
    }


def test_normalize_argv_defaults_to_tui_on_tty(monkeypatch: pytest.MonkeyPatch) -> None:
    from okf_wiki.cli import _normalize_argv

    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    assert _normalize_argv([]) == ["tui"]
    assert _normalize_argv(["--config", "x.yaml"]) == ["tui", "--config", "x.yaml"]
    assert _normalize_argv(["wiki-run", "--yes"]) == ["wiki-run", "--yes"]


def test_normalize_argv_leaves_non_tty_bare(monkeypatch: pytest.MonkeyPatch) -> None:
    from okf_wiki.cli import _normalize_argv

    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    assert _normalize_argv([]) == []
