"""Focused tests for host prepare (PreparedRun / prepare_run)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from okf_wiki.run.errors import RunValidationError
from okf_wiki.run.models import ModelProviderConfig, RepositorySnapshot, WikiRunRequest
from okf_wiki.run.prepare import PreparedMounts, prepare_mounts, prepare_run
from okf_wiki.run.skill import _DEFAULT_PRODUCER_SKILL_DIGEST

from wiki_run_helpers import (
    TEST_WIKI_LIMITS,
    make_producer_skill,
    make_repository,
    writing_model,
)


def _request(tmp_path: Path, *, repositories: tuple[RepositorySnapshot, ...]) -> WikiRunRequest:
    skill = make_producer_skill(tmp_path / "skill")
    return WikiRunRequest(
        repositories=repositories,
        skill=skill,
        model=ModelProviderConfig(model=writing_model("pass", ["index.md"])),
        limits=TEST_WIKI_LIMITS,
        staging=tmp_path / "staging",
        publication=tmp_path / "published",
    )


def test_prepare_mounts_resolves_volumes(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "hello\n")
    request = _request(
        tmp_path,
        repositories=(RepositorySnapshot(path=source, revision=revision),),
    )
    mounts = prepare_mounts(request)
    assert isinstance(mounts, PreparedMounts)
    assert mounts.checkouts == (source.resolve(),)
    assert mounts.skill_input.is_dir()
    assert mounts.staging.is_dir()
    assert mounts.staging.resolve() == (tmp_path / "staging").resolve()
    assert mounts.publication == (tmp_path / "published").resolve()
    assert not any(mounts.staging.iterdir())


def test_prepare_run_freezes_source_skill_and_inventory(tmp_path: Path) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "frozen source\n")
    request = _request(
        tmp_path,
        repositories=(RepositorySnapshot(path=source, revision=revision, id="source"),),
    )
    events: list[tuple[str, object]] = []

    def emit(event_type: str, payload: object = None, **_kwargs: object) -> None:
        events.append((event_type, payload))

    mounts = prepare_mounts(request)
    with prepare_run(request, emit=emit, mounts=mounts) as prepared:
        assert prepared.source_mount.is_dir()
        assert (prepared.source_mount / "README.md").read_text(
            encoding="utf-8"
        ) == "frozen source\n"
        assert prepared.sources == {"source": prepared.source_mount}
        assert prepared.used_files == 1
        assert prepared.used_bytes == len("frozen source\n")
        assert prepared.skill.is_dir()
        assert (prepared.skill / "SKILL.md").is_file()
        assert prepared.skill_digest == request.skill.digest
        assert prepared.skill_digest == _DEFAULT_PRODUCER_SKILL_DIGEST
        inventory = prepared.source_mount / ".okf-wiki-host" / "inventory.json"
        assert inventory.is_file()
        payload = json.loads(inventory.read_text(encoding="utf-8"))
        assert payload["role"] == "source_inventory"
        assert payload["repositories"][0]["files"] == ["README.md"]
        assert [event_type for event_type, _ in events] == ["snapshots_frozen", "skill_frozen"]
        freeze_root = prepared.source_mount.parent
        assert freeze_root.is_dir()

    # Temporary freeze directory is cleaned up on exit.
    assert not freeze_root.exists()


def test_prepare_run_multi_repo_layout(tmp_path: Path) -> None:
    left = tmp_path / "left"
    right = tmp_path / "right"
    left_rev = make_repository(left, "left\n")
    right_rev = make_repository(right, "right\n")
    request = _request(
        tmp_path,
        repositories=(
            RepositorySnapshot(path=left, revision=left_rev, id="left"),
            RepositorySnapshot(path=right, revision=right_rev, id="right"),
        ),
    )
    events: list[str] = []
    with prepare_run(request, emit=lambda t, *_a, **_k: events.append(t)) as prepared:
        assert (prepared.source_mount / "left" / "README.md").read_text(
            encoding="utf-8"
        ) == "left\n"
        assert (prepared.source_mount / "right" / "README.md").read_text(
            encoding="utf-8"
        ) == "right\n"
        assert prepared.sources["left"] == prepared.source_mount / "left"
        assert prepared.sources["right"] == prepared.source_mount / "right"
        assert prepared.used_files == 2
    assert events == ["snapshots_frozen", "skill_frozen"]


def test_prepare_run_skill_digest_mismatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    request = _request(
        tmp_path,
        repositories=(RepositorySnapshot(path=source, revision=revision),),
    )
    mounts = prepare_mounts(request)

    def wrong_digest(path: Path) -> tuple[Path, str]:
        return path, "0" * 64

    monkeypatch.setattr("okf_wiki.run.prepare._validate_producer_skill", wrong_digest)
    with pytest.raises(RunValidationError, match="changed while it was being frozen"):
        prepare_run(request, emit=lambda *_a, **_k: None, mounts=mounts)


def test_prepare_run_inventory_skip_event(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    request = _request(
        tmp_path,
        repositories=(RepositorySnapshot(path=source, revision=revision, id="source"),),
    )
    events: list[tuple[str, object]] = []

    def fail_inventory(*_args: object, **_kwargs: object) -> object:
        raise OSError("inventory write failed")

    monkeypatch.setattr("okf_wiki.run.prepare._write_source_inventory", fail_inventory)
    with prepare_run(
        request,
        emit=lambda t, p=None, **_k: events.append((t, p)),
        mounts=prepare_mounts(request),
    ) as prepared:
        assert (prepared.source_mount / "README.md").is_file()
        assert not (prepared.source_mount / ".okf-wiki-host" / "inventory.json").exists()

    assert events[0][0] == "source_inventory_skipped"
    assert events[0][1] == {
        "reason_code": "generation_failed",
        "error_type": "OSError",
    }
    assert [event_type for event_type, _ in events[1:]] == ["snapshots_frozen", "skill_frozen"]
