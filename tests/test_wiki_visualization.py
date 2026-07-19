"""Deterministic Wiki Visualization generator and CLI tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from okf_wiki.cli import main, parser
from okf_wiki.viz.generate import (
    GENERATOR_VERSION,
    VISUALIZATION_DIR_NAME,
    WikiVisualizationResult,
    generate_wiki_visualization,
)


def _write_page(root: Path, relative: str, body: str, *, title: str | None = None) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    page_title = title if title is not None else Path(relative).stem.replace("-", " ").title()
    path.write_text(
        f"---\ntitle: {page_title}\n---\n{body}",
        encoding="utf-8",
    )
    return path


def make_fixture_published_wiki(root: Path) -> Path:
    """Build a minimal Published Wiki fixture with internal links, citations, and mermaid."""
    wiki = root / "published"
    wiki.mkdir()
    _write_page(
        wiki,
        "index.md",
        "# Index\n\n"
        "See [Architecture](architecture.md) and [Module](modules/core.md).\n\n"
        "Broken: [Missing](does-not-exist.md).\n\n"
        "Citation: [Source](repo:README.md#L1-L1).\n\n"
        "External: [Docs](https://example.com/docs).\n\n"
        "```mermaid\ngraph TD\n  A-->B\n```\n",
        title="Index",
    )
    _write_page(
        wiki,
        "architecture.md",
        "# Architecture\n\nBack to [Index](index.md#index).\n\n[Source](repo:src/main.py#L1-L10)\n",
        title="Architecture",
    )
    _write_page(
        wiki,
        "modules/core.md",
        "# Core Module\n\nSee [Architecture](../architecture.md).\n\n"
        "[Source](repo:src/core.py#L1-L2)\n",
        title="Core Module",
    )
    # Non-markdown artifact must not become a graph node.
    (wiki / "notes.txt").write_text("ignore me\n", encoding="utf-8")
    (wiki / ".okf-wiki.json").write_text("{}\n", encoding="utf-8")
    return wiki


def test_generate_wiki_visualization_builds_deterministic_graph_and_html(
    tmp_path: Path,
) -> None:
    wiki = make_fixture_published_wiki(tmp_path)
    page_hashes_before = {
        path.relative_to(wiki).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in wiki.rglob("*.md")
    }

    first = generate_wiki_visualization(wiki)
    second = generate_wiki_visualization(wiki)

    assert isinstance(first, WikiVisualizationResult)
    assert first.output_dir == wiki / VISUALIZATION_DIR_NAME
    assert first.index_path.is_file()
    assert first.graph_path.is_file()
    assert first.graph_path.name == "graph.json"
    assert first.index_path.name == "index.html"
    assert first.generator_version == GENERATOR_VERSION

    graph = json.loads(first.graph_path.read_text(encoding="utf-8"))
    assert graph["generator_version"] == GENERATOR_VERSION
    node_ids = {node["id"] for node in graph["nodes"]}
    assert node_ids == {"index.md", "architecture.md", "modules/core.md"}
    assert all("title" in node for node in graph["nodes"])
    assert all(node.get("broken") is not True for node in graph["nodes"])

    edges = {(edge["source"], edge["target"], edge["broken"]) for edge in graph["edges"]}
    assert ("index.md", "architecture.md", False) in edges
    assert ("index.md", "modules/core.md", False) in edges
    assert ("architecture.md", "index.md", False) in edges
    assert ("modules/core.md", "architecture.md", False) in edges
    assert ("index.md", "does-not-exist.md", True) in edges

    # External URLs and Source Citations are not graph edges.
    for edge in graph["edges"]:
        assert not edge["target"].startswith("repo:")
        assert not edge["target"].startswith("http")
        assert "example.com" not in edge["target"]

    # Broken targets are not invented as live page nodes.
    assert "does-not-exist.md" not in node_ids

    html = first.index_path.read_text(encoding="utf-8")
    assert "mermaid" in html.lower()
    assert "graph.json" in html or "architecture.md" in html

    # Deterministic for the same Published Wiki content.
    assert first.graph_path.read_bytes() == second.graph_path.read_bytes()
    assert first.index_path.read_bytes() == second.index_path.read_bytes()

    # Published Wiki markdown page content is unchanged.
    page_hashes_after = {
        path.relative_to(wiki).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in wiki.rglob("*.md")
        if VISUALIZATION_DIR_NAME not in path.relative_to(wiki).parts
    }
    assert page_hashes_after == page_hashes_before


def test_generate_wiki_visualization_writes_to_explicit_output_outside_publication(
    tmp_path: Path,
) -> None:
    wiki = make_fixture_published_wiki(tmp_path)
    output = tmp_path / "outside-viz"

    result = generate_wiki_visualization(wiki, output=output)

    assert result.output_dir == output
    assert (output / "index.html").is_file()
    assert (output / "graph.json").is_file()
    assert not (wiki / VISUALIZATION_DIR_NAME).exists()
    assert list(wiki.rglob("*.html")) == []


def test_generate_wiki_visualization_does_not_call_model_provider(
    tmp_path: Path,
) -> None:
    wiki = make_fixture_published_wiki(tmp_path)

    with (
        patch("pydantic_ai.Agent") as agent_cls,
        patch("okf_wiki.run.lifecycle.WikiRunApplication") as app_cls,
    ):
        result = generate_wiki_visualization(wiki)

    assert result.index_path.is_file()
    agent_cls.assert_not_called()
    app_cls.assert_not_called()


def test_generate_wiki_visualization_rejects_missing_publication(tmp_path: Path) -> None:
    missing = tmp_path / "absent"
    with pytest.raises(ValueError, match="Published Wiki"):
        generate_wiki_visualization(missing)


def test_generate_wiki_visualization_ignores_nested_viz_and_non_markdown(
    tmp_path: Path,
) -> None:
    wiki = make_fixture_published_wiki(tmp_path)
    # Pre-existing viz artifacts must not become nodes on regeneration.
    nested = wiki / VISUALIZATION_DIR_NAME / "pages" / "index.md"
    nested.parent.mkdir(parents=True)
    nested.write_text("# fake page inside viz\n", encoding="utf-8")

    result = generate_wiki_visualization(wiki, output=tmp_path / "out")
    graph = json.loads(result.graph_path.read_text(encoding="utf-8"))
    node_ids = {node["id"] for node in graph["nodes"]}
    assert node_ids == {"index.md", "architecture.md", "modules/core.md"}
    assert "notes.txt" not in node_ids
    assert f"{VISUALIZATION_DIR_NAME}/pages/index.md" not in node_ids


def test_viz_cli_is_registered() -> None:
    command = parser()
    subcommands = next(action for action in command._actions if action.dest == "command")
    assert subcommands.choices is not None
    assert "viz" in subcommands.choices

    help_text = command.format_help()
    assert "viz" in help_text

    args = parser().parse_args(["viz", "/tmp/published", "--output", "/tmp/out"])
    assert args.command == "viz"
    assert args.publication == Path("/tmp/published")
    assert args.output == Path("/tmp/out")


def test_viz_cli_generates_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    wiki = make_fixture_published_wiki(tmp_path)
    output = tmp_path / "cli-viz"
    monkeypatch.setattr(
        "sys.argv",
        ["okf-wiki", "viz", str(wiki), "--output", str(output)],
    )

    assert main() == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["visualization"]["output"] == str(output)
    assert payload["visualization"]["index"] == str(output / "index.html")
    assert payload["visualization"]["graph"] == str(output / "graph.json")
    assert (output / "index.html").is_file()
    assert (output / "graph.json").is_file()


def test_publication_validation_ignores_top_level_viz_directory(tmp_path: Path) -> None:
    """viz/ under a publication must not be treated as wiki pages requiring citations."""
    from okf_wiki.run import WikiManifest, WikiRunLimits
    from okf_wiki.run.validation import validate_wiki

    staging = tmp_path / "staging"
    staging.mkdir()
    page = "---\ntitle: Wiki\n---\n# Wiki\n\n[Source](repo:README.md#L1-L1)\n"
    (staging / "index.md").write_text(page, encoding="utf-8")
    viz = staging / VISUALIZATION_DIR_NAME
    viz.mkdir()
    (viz / "index.html").write_text("<html></html>\n", encoding="utf-8")
    (viz / "graph.json").write_text("{}\n", encoding="utf-8")
    (viz / "fake.md").write_text("# not a wiki page\n", encoding="utf-8")

    source = tmp_path / "source"
    source.mkdir()
    (source / "README.md").write_text("line\n", encoding="utf-8")

    errors = validate_wiki(
        {"repo": source},
        staging,
        WikiManifest(pages=["index.md"]),
        WikiRunLimits(),
    )
    assert errors == []


def test_refresh_stage_tolerates_viz_artifacts_under_publication(tmp_path: Path) -> None:
    """Refresh may copy an existing publication that already has viz/ artifacts."""
    from okf_wiki.run import WikiRunLimits
    from okf_wiki.run.publication.fs import (
        PUBLICATION_METADATA_NAME,
        stage_published_wiki_for_refresh,
    )
    from okf_wiki.run.validation import _content_digest

    publication = tmp_path / "published"
    publication.mkdir()
    page = "---\ntitle: Old\n---\n# Old\n\n[Source](repo:README.md#L1-L1)\n"
    (publication / "index.md").write_text(page, encoding="utf-8")
    page_hash = hashlib.sha256(page.encode()).hexdigest()
    digest = _content_digest({"index.md": page_hash})
    metadata = {
        "repositories": [
            {
                "id": "repo",
                "revision": "a" * 40,
                "ignore": [],
            }
        ],
        "skill_digest": "b" * 64,
        "model": "test",
        "generated_at": "2020-01-01T00:00:00+00:00",
        "pages": [{"path": "index.md", "sha256": page_hash}],
        "content_digest": digest,
    }
    (publication / PUBLICATION_METADATA_NAME).write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    viz = publication / VISUALIZATION_DIR_NAME
    viz.mkdir()
    (viz / "index.html").write_text("<html>viz</html>\n", encoding="utf-8")
    (viz / "graph.json").write_text("{}\n", encoding="utf-8")

    staging = tmp_path / "staging"
    staging.mkdir()
    page_hashes, _repos, _skill = stage_published_wiki_for_refresh(
        publication, staging, WikiRunLimits()
    )
    assert page_hashes == {"index.md": page_hash}
    assert (staging / "index.md").is_file()
    assert not (staging / VISUALIZATION_DIR_NAME).exists()
