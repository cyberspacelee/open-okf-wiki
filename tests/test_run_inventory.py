"""Source inventory and visualization tests."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from okf_wiki.host import (
    Complete,
    ModelProviderConfig,
    RepositorySnapshot,
    WikiRunApplication,
    WikiRunEvent,
    WikiRunRequest,
)

from wiki_run_helpers import (
    SIMPLE_WIKI_PAGE,
    TEST_WIKI_LIMITS,
    make_producer_skill,
    make_repository,
    write_pages_code,
    writing_model,
)


def test_write_visualization_after_publish_is_optional_and_non_destructive(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    publication = tmp_path / "published"
    application = WikiRunApplication()
    result = asyncio.run(
        application.run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    )
                ),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=publication,
                write_visualization=True,
                auto_approve_publication=True,
            )
        )
    )
    assert isinstance(result, Complete)
    assert application.last_visualization is not None
    index = Path(str(application.last_visualization["index"]))
    assert index.is_file()
    assert (publication / "index.md").read_text(encoding="utf-8") == SIMPLE_WIKI_PAGE
    # Visualization failure must not unpublish: corrupt path is not used when default succeeds.
    assert application.last_visualization_error is None


def test_write_source_inventory_lists_materialized_files(tmp_path: Path) -> None:
    from okf_wiki.host.snapshots import _write_source_inventory

    mount = tmp_path / "source"
    mount.mkdir()
    (mount / "README.md").write_text("x\n", encoding="utf-8")
    (mount / "pkg").mkdir()
    (mount / "pkg" / "mod.py").write_text("y\n", encoding="utf-8")
    path = _write_source_inventory(mount, {"source": mount})
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["accelerator_only"] is True
    assert payload["repositories"][0]["file_count"] == 2
    assert "README.md" in payload["repositories"][0]["files"]
    assert "pkg/mod.py" in payload["repositories"][0]["files"]


def test_source_inventory_failure_emits_error_type_and_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    revision = make_repository(source, "source\n")
    skill = make_producer_skill(tmp_path / "skill")
    events: list[WikiRunEvent] = []

    def fail_inventory(*_args: object, **_kwargs: object) -> object:
        raise OSError("inventory write failed")

    # Prepare binds the helper at import time on the prepare module.
    monkeypatch.setattr("okf_wiki.host.prepare._write_source_inventory", fail_inventory)
    result = asyncio.run(
        WikiRunApplication(observer=events.append).run(
            WikiRunRequest(
                repositories=(RepositorySnapshot(path=source, revision=revision),),
                skill=skill,
                model=ModelProviderConfig(
                    model=writing_model(
                        write_pages_code({"index.md": SIMPLE_WIKI_PAGE}), ["index.md"]
                    )
                ),
                limits=TEST_WIKI_LIMITS,
                staging=tmp_path / "staging",
                publication=tmp_path / "published",
                auto_approve_publication=True,
            )
        )
    )
    assert isinstance(result, Complete)
    skipped = [event for event in events if event.type == "source_inventory_skipped"]
    assert len(skipped) == 1
    assert skipped[0].payload["reason_code"] == "generation_failed"
    assert skipped[0].payload["error_type"] == "OSError"
    assert any(event.type == "snapshots_frozen" for event in events)
    assert (tmp_path / "published" / "index.md").is_file()
