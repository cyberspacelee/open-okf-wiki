import base64
import hashlib
import json
import sqlite3
import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest

from okf_wiki.console import create_console
from okf_wiki.workspace import WorkspaceApplication, WorkspaceError


def _git_source(path: Path) -> tuple[str, str]:
    path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    text = "The gateway keeps credentials outside the Workspace.\n"
    (path / "README.md").write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "source"], cwd=path, check=True)
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, check=True, capture_output=True, text=True
    ).stdout.strip()
    return revision, "sha256:" + hashlib.sha256(text.rstrip("\n").encode()).hexdigest()


def _bundle(path: Path, title: str, body: str) -> None:
    path.mkdir(parents=True)
    (path / "index.md").write_text(f"# {title}\n\n* [Guide](guide.md)\n", encoding="utf-8")
    (path / "guide.md").write_text(body, encoding="utf-8")


@contextmanager
def _console(app: WorkspaceApplication, assets: Path):
    server, _ = create_console(app.root, assets=assets)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture
def knowledge_workspace(tmp_path: Path) -> tuple[WorkspaceApplication, str]:
    source = tmp_path / "source"
    revision, digest = _git_source(source)
    workspace = tmp_path / "workspace"
    app = WorkspaceApplication(workspace)
    app.initialize("catalog", "Catalog")
    published = workspace / "published"
    releases = workspace / ".published.releases"
    older_release = releases / "run-older"
    _bundle(
        older_release,
        "Older",
        "---\ntype: Guide\nid: guide\ntitle: Older guide\n---\n\n# Older guide\n\nOlder text.\n",
    )
    old_release = releases / "run-old"
    _bundle(
        old_release,
        "Published",
        "---\ntype: Guide\nid: guide\ntitle: Published guide\n---\n\n"
        "# Published guide\n\nOld text.\n",
    )
    (old_release / "removed.md").write_text("# Removed\n", encoding="utf-8")
    published.symlink_to(old_release.relative_to(workspace), target_is_directory=True)
    staging = workspace / ".okf-wiki" / "runs" / "run-new" / "staging"
    claim_id = "claim:" + "a" * 64
    _bundle(
        staging,
        "Staged",
        "---\ntype: Guide\nid: guide\ntitle: Safe reader\ntags:\n  - security\n---\n\n"
        "# Safe reader\n\n"
        "- [x] CommonMark task\n\n"
        "| Policy | State |\n| --- | --- |\n| CSP | strict |\n\n"
        "```python\nprint('safe')\n```\n\n"
        "```mermaid\nflowchart LR\n  A[Source] --> B[Claim]\n  A[Source] --> C[Bundle]\n```\n\n"
        "Math $x^2$ stays deterministic.\n\n"
        "![Pixel](pixel.png)\n\n"
        "![Remote](https://example.invalid/pixel.png)\n\n"
        f"Grounded statement.\n\n<!-- claims: {claim_id} -->\n\n"
        f"# Citations\n\n* `{claim_id}` — "
        f"`repo://docs@{revision}/README.md#L1-L1`\n\n"
        "[Published index](index.md)\n\n"
        "<script>window.pwned = true</script>\n\n"
        "[Unsafe](javascript:alert(1))\n",
    )
    (staging / "pixel.png").write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    )
    (staging / "added.md").write_text("# Added\n", encoding="utf-8")
    (staging / "malformed.md").write_text(
        "```mermaid\nflowchart LR\nA[Safe] --> not a node!\n```\n", encoding="utf-8"
    )
    source_set = {
        "base_run_id": "run-old",
        "digest": "source-set-new",
        "sources": [
            {
                "id": "docs",
                "repository": str(source),
                "revision": revision,
                "role": "documentation",
                "digest": "tree",
            }
        ],
    }
    older_source_set = {**source_set, "base_run_id": None, "digest": "source-set-older"}
    old_source_set = {**source_set, "base_run_id": "run-older", "digest": "source-set-old"}
    with sqlite3.connect(app.database_path) as connection:
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'catalog', ?, ?, ?, ?, 'published', ?, '2025-12-31', '2025-12-31')""",
            (
                "run-older",
                str(source),
                revision,
                str(published),
                str(older_release),
                json.dumps(older_source_set),
            ),
        )
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'catalog', ?, ?, ?, ?, 'published', ?, '2026-01-01', '2026-01-01')""",
            (
                "run-old",
                str(source),
                revision,
                str(published),
                str(old_release),
                json.dumps(old_source_set),
            ),
        )
        connection.execute(
            """INSERT INTO runs
               (id, project_id, repository, revision, publish_dir, staging_dir, state,
                source_set_json, created_at, updated_at)
               VALUES (?, 'catalog', ?, ?, ?, ?, 'review_required', ?,
                       '2026-01-02', '2026-01-02')""",
            (
                "run-new",
                str(source),
                revision,
                str(published),
                str(staging),
                json.dumps(source_set),
            ),
        )
        evidence_id = "evidence:" + "b" * 64
        connection.execute(
            "INSERT INTO accepted_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "run-new",
                evidence_id,
                "docs",
                revision,
                "README.md",
                "unit:readme",
                1,
                1,
                digest,
                "source_span",
                "authoritative",
            ),
        )
        connection.execute(
            "INSERT INTO accepted_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "run-new",
                claim_id,
                "Gateway",
                "stores credentials",
                "The gateway keeps credentials outside the Workspace.",
                "asserted",
                "[]",
                "supported",
            ),
        )
        connection.execute(
            "INSERT INTO claim_evidence VALUES (?, ?, ?)",
            ("run-new", claim_id, evidence_id),
        )
    return app, claim_id


def test_knowledge_snapshot_distinguishes_staged_and_published_bundles(
    knowledge_workspace: tuple[WorkspaceApplication, str],
) -> None:
    app, _ = knowledge_workspace

    snapshot = app.knowledge_snapshot("staged")

    assert snapshot["selected"] == {
        "kind": "staged",
        "run_id": "run-new",
        "source_set_digest": "source-set-new",
        "state": "review_required",
    }
    assert snapshot["default_page"] == "index.md"
    assert snapshot["diff_options"] == [
        {"base": "previous", "target": "published", "target_run_id": "run-old"},
        {"base": "published", "target": "staged", "target_run_id": "run-new"},
        {"base": "previous", "target": "staged", "target_run_id": "run-new"},
    ]
    assert {page["path"] for page in snapshot["pages"]} == {
        "added.md",
        "guide.md",
        "index.md",
        "malformed.md",
    }
    assert {bundle["kind"] for bundle in snapshot["bundles"]} == {"staged", "published"}


def test_knowledge_page_returns_safe_structured_markdown(
    knowledge_workspace: tuple[WorkspaceApplication, str],
) -> None:
    app, claim_id = knowledge_workspace

    page = app.knowledge_page("staged", "guide.md")

    assert page["metadata"]["title"] == "Safe reader"
    assert page["source"].startswith("---\ntype: Guide")
    assert page["outline"] == [
        {"level": 1, "text": "Safe reader", "id": "safe-reader"},
        {"level": 1, "text": "Citations", "id": "citations"},
    ]
    assert {block["type"] for block in page["blocks"]} >= {
        "heading",
        "list",
        "table",
        "code",
        "mermaid",
        "paragraph",
        "claim",
    }
    assert any(block.get("claim_id") == claim_id for block in page["blocks"])
    diagram = next(block for block in page["blocks"] if block["type"] == "mermaid")
    assert diagram["error"] is None
    assert len(diagram["nodes"]) == 3
    assert len(diagram["edges"]) == 2
    inline_claims = [
        node
        for block in page["blocks"]
        for item in block.get("items", [])
        for child in item["children"]
        for node in child.get("children", [])
        if node["type"] == "claim"
    ]
    assert inline_claims == [{"type": "claim", "claim_id": claim_id}]
    assert "Raw HTML was omitted." in page["diagnostics"]
    assert "Unsafe URL was omitted: javascript:alert(1)" in page["diagnostics"]
    assert "Unsafe image URL was omitted: https://example.invalid/pixel.png" in page["diagnostics"]
    images = [
        node
        for block in page["blocks"]
        for node in block.get("children", [])
        if node["type"] == "image"
    ]
    assert images[0]["alt"] == "Pixel"
    assert images[0]["source"].startswith("data:image/png;base64,")
    assert "<script>" not in json.dumps(page["blocks"])


def test_knowledge_search_diff_and_claim_use_fixed_read_only_inputs(
    knowledge_workspace: tuple[WorkspaceApplication, str],
) -> None:
    app, claim_id = knowledge_workspace

    results = app.search_knowledge("strict", "staged")
    diff = app.diff_knowledge("guide.md", "published", "staged")
    claim = app.knowledge_claim(claim_id, "staged")

    assert results == [{"path": "guide.md", "title": "Safe reader", "excerpt": "| CSP | strict |"}]
    assert diff["base"]["run_id"] == "run-old"
    assert diff["target"]["run_id"] == "run-new"
    assert {line["kind"] for line in diff["lines"]} >= {"added", "changed", "unchanged"}
    assert claim["statement"] == "The gateway keeps credentials outside the Workspace."
    assert claim["evidence"][0]["excerpt"] == claim["statement"]
    assert "repository" not in json.dumps(claim)


def test_knowledge_diff_represents_added_and_removed_pages(
    knowledge_workspace: tuple[WorkspaceApplication, str],
) -> None:
    app, _ = knowledge_workspace

    added = app.diff_knowledge("added.md", "published", "staged")
    removed = app.diff_knowledge("removed.md", "published", "staged")

    assert added["page_change"] == "added"
    assert [line["kind"] for line in added["lines"]] == ["added"]
    assert removed["page_change"] == "removed"
    assert [line["kind"] for line in removed["lines"]] == ["removed"]

    previous = app.diff_knowledge("guide.md", "previous", "published", run_id="run-old")
    assert previous["base"]["run_id"] == "run-older"
    assert previous["target"]["run_id"] == "run-old"


def test_published_run_never_falls_back_to_a_different_public_release(
    knowledge_workspace: tuple[WorkspaceApplication, str],
) -> None:
    app, _ = knowledge_workspace
    published = app.root / "published"
    release = app.root / ".published.releases" / "run-old"
    release.rename(app.root / ".published.releases" / "missing-run-old")
    published.unlink()
    published.symlink_to(".published.releases/run-older", target_is_directory=True)

    with pytest.raises(WorkspaceError, match="Published Knowledge Bundle is not available"):
        app.knowledge_snapshot("published", "run-old")


def test_malformed_mermaid_is_a_controlled_reader_error(
    knowledge_workspace: tuple[WorkspaceApplication, str],
) -> None:
    app, _ = knowledge_workspace
    page = app.knowledge_page("staged", "malformed.md")
    diagram = page["blocks"][0]
    assert diagram["type"] == "mermaid"
    assert diagram["error"] == "Mermaid statement is outside the safe flowchart subset"
    assert diagram["nodes"] == diagram["edges"] == []


def test_knowledge_page_failures_are_actionable_and_safe(
    knowledge_workspace: tuple[WorkspaceApplication, str],
) -> None:
    app, _ = knowledge_workspace
    staging = app.root / ".okf-wiki" / "runs" / "run-new" / "staging"
    (staging / "oversized.md").write_bytes(b"x" * 1_000_001)
    (staging / "binary.md").write_bytes(b"\xff\xfe")
    (staging / "frontmatter.md").write_text("---\n: invalid\n---\n", encoding="utf-8")
    (staging / "broken.md").write_text("[Missing](gone.md)\n", encoding="utf-8")

    with pytest.raises(WorkspaceError, match="exceeds the 1 MB"):
        app.knowledge_page("staged", "oversized.md")
    with pytest.raises(WorkspaceError, match="not valid UTF-8"):
        app.knowledge_page("staged", "binary.md")
    with pytest.raises(WorkspaceError, match="malformed YAML frontmatter"):
        app.knowledge_page("staged", "frontmatter.md")
    assert app.knowledge_page("staged", "broken.md")["diagnostics"] == [
        "Broken internal link: gone.md"
    ]


@pytest.mark.parametrize(
    ("operation", "message"),
    [
        (lambda app: app.knowledge_page("staged", "../secret.md"), "canonical Bundle path"),
        (lambda app: app.knowledge_page("staged", "missing.md"), "Bundle page does not exist"),
        (lambda app: app.search_knowledge("", "staged"), "Search query must not be blank"),
    ],
)
def test_knowledge_reader_rejects_untrusted_inputs(
    knowledge_workspace: tuple[WorkspaceApplication, str], operation, message: str
) -> None:
    app, _ = knowledge_workspace
    with pytest.raises(WorkspaceError, match=message):
        operation(app)


def test_console_exposes_validated_read_only_knowledge_dtos(
    knowledge_workspace: tuple[WorkspaceApplication, str], tmp_path: Path
) -> None:
    app, claim_id = knowledge_workspace
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "index.html").write_text("ok", encoding="utf-8")

    with _console(app, assets) as server:
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {"Authorization": f"Bearer {server.session_token}"}
        snapshot = httpx.get(base + "/api/v1/knowledge?bundle=staged", headers=headers)
        page = httpx.get(
            base + "/api/v1/knowledge/page?bundle=staged&path=guide.md", headers=headers
        )
        search = httpx.get(
            base + "/api/v1/knowledge/search?bundle=staged&query=strict", headers=headers
        )
        diff = httpx.get(
            base + "/api/v1/knowledge/diff?path=guide.md&base=published&target=staged",
            headers=headers,
        )
        claim = httpx.get(
            base + f"/api/v1/knowledge/claims/{claim_id}?bundle=staged", headers=headers
        )
        traversal = httpx.get(
            base + "/api/v1/knowledge/page?bundle=staged&path=../workspace.toml",
            headers=headers,
        )
        duplicate = httpx.get(base + "/api/v1/knowledge?page=a&page=b", headers=headers)
        malformed = httpx.get(base + "/api/v1/knowledge?broken", headers=headers)

    assert snapshot.status_code == page.status_code == search.status_code == 200
    assert diff.status_code == claim.status_code == 200
    assert snapshot.json()["selected"]["run_id"] == "run-new"
    assert page.json()["path"] == "guide.md"
    assert search.json()["results"][0]["path"] == "guide.md"
    assert claim_id in claim.text
    assert traversal.status_code == duplicate.status_code == malformed.status_code == 400
