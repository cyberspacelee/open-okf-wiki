"""Structural index and agent-facing navigation invariants."""

import pathlib

import _index
import pytest


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def inventory(root: pathlib.Path) -> list[str]:
    return sorted(
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    )


def test_index_records_are_disjoint_and_outline_is_a_tree(tmp_path):
    files = {
        "README.md": "project\n",
        "pom.xml": "<project/>\n",
        "app/pom.xml": "<project/>\n",
        "app/src/main/java/com/acme/App.java": "class App {}\n",
        "app/src/main/java/com/acme/util/Strings.java": "class Strings {}\n",
        "app/src/test/java/com/acme/AppTest.java": "class AppTest {}\n",
        "app/target/generated/Generated.java": "// generated file\n",
    }
    for rel, content in files.items():
        write(tmp_path / rel, content)

    payload = _index.build_index("demo", tmp_path, sorted(files))
    assert sum(item["files"] for item in payload["directories"]) == len(files)
    assert next(item for item in payload["directories"] if item["path"] == ".")[
        "subtree_files"
    ] == len(files)

    rendered = _index.render_index(payload)
    assert rendered.startswith("# demo\n")
    assert "Stats columns" not in rendered
    assert "  - `app/` [build-module]" in rendered
    assert "    - `app/src/` [directory]" in rendered
    assert "      - `app/src/main/` [directory]" in rendered
    assert "        - `app/src/main/java/` [source-set:main/java]" in rendered
    assert "[package-cluster]" in rendered
    assert "test 1" in rendered
    assert "generated 1" in rendered
    assert "entry:" in rendered


def test_maven_modules_and_source_sets_are_detected_without_running_build(tmp_path):
    write(
        tmp_path / "pom.xml",
        """<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modules><module>api</module><module>worker</module></modules>
</project>
""",
    )
    write(tmp_path / "api/pom.xml", "<project/>\n")
    write(tmp_path / "worker/pom.xml", "<project/>\n")
    write(tmp_path / "api/src/main/java/org/example/api/Api.java", "class Api {}\n")
    write(tmp_path / "api/src/main/resources/application.yml", "name: api\n")
    write(
        tmp_path / "worker/src/test/kotlin/org/example/WorkerTest.kt",
        "class WorkerTest\n",
    )

    payload = _index.build_index("enterprise", tmp_path, inventory(tmp_path))
    assert payload["build_modules"] == [".", "api", "worker"]
    assert payload["source_sets"] == [
        "api/src/main/java",
        "api/src/main/resources",
        "worker/src/test/kotlin",
    ]
    outline = _index.render_index(payload)
    assert "[build-module]" in outline
    assert "[source-set:main/resources]" in outline
    assert "Java" in outline and "Kotlin" in outline and "YAML" in outline


def test_thousands_of_files_keep_complete_inventory_and_bounded_outline(tmp_path):
    files = []
    for number in range(2500):
        rel = f"modules/mod{number % 80:02d}/src/main/java/org/example/p{number:04d}/C.java"
        write(tmp_path / rel, f"class C{number} {{}}\n")
        files.append(rel)
    write(tmp_path / "pom.xml", "<project/>\n")
    files.append("pom.xml")

    payload = _index.build_index("large", tmp_path, sorted(files))
    outline = _index.render_index(payload)

    assert sum(item["files"] for item in payload["directories"]) == len(files)
    assert len(outline.encode("utf-8")) <= _index.MAX_INDEX_BYTES
    assert "2501 files | inventory complete" in outline
    assert "outline truncated: true" in outline
    assert "folded " in outline
    assert outline.count("C.java") == 0


def test_scope_digest_changes_only_for_selected_inventory(tmp_path):
    write(tmp_path / "api/inside.py", "VALUE = 1\n")
    write(tmp_path / "web/outside.py", "VALUE = 1\n")
    files = inventory(tmp_path)
    original = _index.scope_digest(tmp_path, files, ["api"])

    write(tmp_path / "web/outside.py", "VALUE = 2\n")
    assert _index.scope_digest(tmp_path, inventory(tmp_path), ["api"]) == original

    write(tmp_path / "api/inside.py", "VALUE = 2\n")
    assert _index.scope_digest(tmp_path, inventory(tmp_path), ["api"]) != original

    changed = _index.scope_digest(tmp_path, inventory(tmp_path), ["api"])
    write(tmp_path / "api/new.py", "NEW = True\n")
    assert _index.scope_digest(tmp_path, inventory(tmp_path), ["api"]) != changed


def test_scope_digest_rejects_unbounded_or_escaping_roots(tmp_path):
    with pytest.raises(ValueError):
        _index.scope_digest(tmp_path, [], [])
    with pytest.raises(ValueError):
        _index.scope_digest(tmp_path, [], ["../outside"])


def test_list_directory_remains_bounded(tmp_path, monkeypatch):
    files = [f"pkg/f{number:04d}.py" for number in range(1000)]
    monkeypatch.setattr(_index, "MAX_LS_BYTES", 2 * 1024)
    listing = _index.list_directory("demo", "pkg", files)
    assert listing["truncated"] and listing["next_after"]
    assert len(str(listing).encode("utf-8")) < 3 * 1024
