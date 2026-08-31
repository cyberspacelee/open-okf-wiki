"""Deterministic structural index for Git/files Pins. Zero LLM.

Index invariants (v3):
- every directory record describes a disjoint region of files; a file is
  counted by exactly one record, so record counts are additive;
- a record's fields describe the record's region directly (no recursive
  roll-up); `subtree_files` is the only derived subtree metric;
- the canonical directory tree is projected into visible records; semantic
  anchors stop structural compaction and the byte budget may coarsen that
  projection further. `compressed_dirs` and `truncated_dirs` keep those two
  causes distinct, and no file ever loses its record.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
from collections import Counter
from xml.etree import ElementTree

import _workspace
from _files import atomic_text

ENTRY_NAMES = (
    "readme.md",
    "readme.rst",
    "readme.txt",
    "package.json",
    "pyproject.toml",
    "cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "makefile",
    "cmakelists.txt",
    "dockerfile",
    "openapi.json",
    "openapi.yaml",
    "openapi.yml",
    "swagger.json",
    "swagger.yaml",
    "swagger.yml",
    "asyncapi.json",
    "asyncapi.yaml",
    "asyncapi.yml",
)
ENTRY_BASENAMES = {
    "main.py",
    "main.ts",
    "main.js",
    "index.ts",
    "index.js",
    "app.py",
    "app.ts",
    "server.py",
    "server.ts",
}
TEST_TOKEN = re.compile(
    r"(^|/)(tests?|spec|__tests__)(/|$)|(^|[/._-])tests?\.|_test\.|\.spec\.",
    re.IGNORECASE,
)
BINARY_EXT = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".jar",
    ".class",
    ".so",
    ".dll",
    ".exe",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp4",
    ".mp3",
    ".wasm",
}
VERSION = 3
MAX_INDEX_BYTES = 64 * 1024
MAX_LS_BYTES = 16 * 1024
MAX_ENTRY_POINTS = 16
MAX_EXTENSIONS = 20
GENERATED_TOKEN = re.compile(r"(^|/)(generated|vendor|dist|build)(/|$)", re.IGNORECASE)
GENERATED_MARKER = re.compile(rb"generated (by|file)|do not edit", re.IGNORECASE)
SOURCE_SET = re.compile(
    r"^(?:(?P<module>.+)/)?src/(?P<set>main|test|integrationTest|it)/"
    r"(?P<language>java|kotlin|scala|groovy|resources)(?:/|$)"
)
LANGUAGE_NAMES = {
    ".java": "Java",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".scala": "Scala",
    ".groovy": "Groovy",
    ".py": "Python",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".go": "Go",
    ".rs": "Rust",
    ".xml": "XML",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".json": "JSON",
}


def index_path(base: pathlib.Path, source: str) -> pathlib.Path:
    return base / "index" / f"{source.lower()}.md"


def write_source_index(root: pathlib.Path, run_id: str, source, revision: dict) -> dict:
    import _state
    import _workspace

    pin = _workspace.pin_dir(root, run_id, source.name)
    files = _workspace.captured_files(source, pin, revision)
    payload = build_index(source.name, pin, files)
    path = index_path(_state.run_dir(root, run_id), source.name)
    rendered = render_index(payload)
    if len(rendered.encode("utf-8")) > MAX_INDEX_BYTES:
        raise AssertionError("rendered index exceeds the index byte budget")
    atomic_text(path, rendered)
    return payload


def render_index(payload: dict) -> str:
    """Render a bounded tree used to choose the next scope to inspect."""

    records = {item["path"]: item for item in payload["directories"]}
    semantic = {".", *payload.get("build_modules", []), *payload.get("source_sets", [])}
    visible = set(records)
    while True:
        rendered = _render_tree(payload, records, visible)
        if len(rendered.encode("utf-8")) <= MAX_INDEX_BYTES:
            return rendered
        removable = [path for path in visible if path != "." and path not in semantic]
        if not removable:
            removable = [path for path in visible if path != "."]
        if not removable:
            raise AssertionError("source index header exceeds the index byte budget")
        victim = max(
            removable,
            key=lambda path: (
                path.count("/"),
                not records.get(path, {}).get("entry_points"),
                path,
            ),
        )
        visible.remove(victim)


def _render_tree(payload: dict, records: dict[str, dict], visible: set[str]) -> str:
    modules = set(payload.get("build_modules", []))
    source_sets = set(payload.get("source_sets", []))
    globally_truncated = payload["truncated"] or visible != set(records)
    parents = _visible_parents(visible)
    hidden_by_parent: Counter = Counter()
    for candidate in set(records) - visible:
        ancestor = _parent_dir(candidate)
        while ancestor and ancestor not in visible:
            ancestor = _parent_dir(ancestor)
        hidden_by_parent[ancestor if ancestor in visible else "."] += 1
    lines = [
        f"# {payload['source']}",
        "",
        (
            f"{payload['file_count']} files | inventory complete | "
            f"outline truncated: {str(globally_truncated).lower()}"
        ),
        "",
        "## Repository outline",
        "",
    ]
    for path in sorted(
        visible,
        key=lambda value: (value != ".", pathlib.PurePosixPath(value).parts),
    ):
        stats = _subtree_stats(path, records)
        kind = _navigation_kind(path, modules, source_sets)
        indent = "  " * _visible_depth(path, parents)
        label = "." if path == "." else path + "/"
        details = [f"{stats['files']} files"]
        languages = _main_languages(stats["extensions"])
        if languages:
            details.append("/".join(languages))
        if stats["test_files"]:
            details.append(f"test {stats['test_files']}")
        if stats["generated_files"]:
            details.append(f"generated {stats['generated_files']}")
        compressed = stats["compressed_dirs"]
        truncated = stats.get("truncated_dirs", 0) + hidden_by_parent[path]
        if compressed:
            details.append(f"compressed {compressed}")
        if truncated:
            details.append(f"truncated {truncated}")
        lines.append(f"{indent}- `{label}` [{kind}] - " + " | ".join(details))
        entries = stats["entry_points"][:3]
        if entries:
            lines.append(
                f"{indent}  entry: " + ", ".join(f"`{item}`" for item in entries)
            )
    if globally_truncated:
        lines.extend(
            [
                "",
                (
                    "The outline is folded to its byte budget; use bounded directory "
                    "listing to expand a relevant path."
                ),
            ]
        )
    return "\n".join(lines) + "\n"


def _visible_parents(visible: set[str]) -> dict[str, str | None]:
    parents = {".": None}
    for path in visible - {"."}:
        ancestor = _parent_dir(path)
        while ancestor and ancestor not in visible:
            ancestor = _parent_dir(ancestor)
        parents[path] = ancestor if ancestor in visible else "."
    return parents


def _visible_depth(path: str, parents: dict[str, str | None]) -> int:
    depth = 0
    while path != ".":
        depth += 1
        path = parents[path] or "."
    return depth


def _is_descendant(path: str, parent: str) -> bool:
    return parent == "." or path.startswith(parent.rstrip("/") + "/")


def _subtree_stats(path: str, records: dict[str, dict]) -> dict:
    extensions: Counter = Counter()
    result = {
        "files": 0,
        "test_files": 0,
        "generated_files": 0,
        "compressed_dirs": 0,
        "truncated_dirs": 0,
        "entry_points": [],
        "extensions": extensions,
    }
    for candidate, item in records.items():
        if candidate != path and not _is_descendant(candidate, path):
            continue
        for key in (
            "files",
            "test_files",
            "generated_files",
            "compressed_dirs",
            "truncated_dirs",
        ):
            result[key] += item[key]
        extensions.update(item["extensions"])
        result["entry_points"].extend(item["entry_points"])
    result["entry_points"] = sorted(set(result["entry_points"]))
    return result


def _navigation_kind(path: str, modules: set[str], source_sets: set[str]) -> str:
    if path in modules:
        return "build-module"
    if path in source_sets:
        match = SOURCE_SET.match(path + "/")
        return (
            f"source-set:{match.group('set')}/{match.group('language')}"
            if match
            else "source-set"
        )
    if any(_is_descendant(path, root) and path != root for root in source_sets):
        return "package-cluster"
    return "directory"


def _main_languages(extensions: Counter) -> list[str]:
    languages: Counter = Counter()
    for extension, count in extensions.items():
        name = LANGUAGE_NAMES.get(extension)
        if name:
            languages[name] += count
    return [name for name, _ in languages.most_common(3)]


def build_index(
    source: str,
    pin: pathlib.Path,
    files: list[str],
) -> dict:
    files = sorted(files)
    build_modules = _maven_modules(pin, files)
    source_sets = _source_sets(files)
    semantic = {
        *("" if item == "." else item for item in build_modules),
        *source_sets,
    }
    required = {""}
    direct_files, child_dirs = _directory_shape(files)
    projection = (
        required
        | semantic
        | direct_files
        | {path for path, children in child_dirs.items() if len(children) > 1}
    )
    all_dirs = (
        required
        | direct_files
        | set(child_dirs)
        | {child for children in child_dirs.values() for child in children}
    )
    stats = {path: _new_stats() for path in all_dirs}
    for rel in files:
        size, raw = _file_data(pin, rel)
        _accumulate_file(stats[_parent_of(rel)], rel, size, raw)
    candidates = sorted(
        (path for path in projection if path not in required),
        key=lambda path: (path not in semantic, *_keep_priority(path, stats[path])),
    )
    full = _assemble(
        source,
        files,
        stats,
        projection,
        required,
        candidates,
        len(candidates),
        build_modules,
        source_sets,
    )
    if _json_size(full) <= MAX_INDEX_BYTES:
        return full
    floor = _assemble(
        source,
        files,
        stats,
        projection,
        required,
        candidates,
        0,
        build_modules,
        source_sets,
    )
    if _json_size(floor) > MAX_INDEX_BYTES:
        raise AssertionError("source index root exceeds the index byte budget")
    lo, hi = 0, len(candidates)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        probe = _assemble(
            source,
            files,
            stats,
            projection,
            required,
            candidates,
            mid,
            build_modules,
            source_sets,
        )
        if _json_size(probe) <= MAX_INDEX_BYTES:
            lo = mid
        else:
            hi = mid
    return _assemble(
        source,
        files,
        stats,
        projection,
        required,
        candidates,
        lo,
        build_modules,
        source_sets,
    )


def _assemble(
    source: str,
    files: list[str],
    stats: dict[str, dict],
    projection: set[str],
    required: set[str],
    candidates: list[str],
    keep_count: int,
    build_modules: list[str],
    source_sets: list[str],
) -> dict:
    kept = required | set(candidates[:keep_count])
    working = {path: _copy_stats(item) for path, item in stats.items()}
    for path in sorted(
        set(working) - projection, key=lambda item: item.count("/"), reverse=True
    ):
        _merge_stats(
            working[_nearest_kept(path, projection)], working[path], "compressed_dirs"
        )
        del working[path]
    for path in sorted(
        set(working) - kept, key=lambda item: item.count("/"), reverse=True
    ):
        _merge_stats(
            working[_nearest_kept(path, kept)], working[path], "truncated_dirs"
        )
        del working[path]
    subtree = {path: item["files"] for path, item in working.items()}
    for path, item in working.items():
        ancestor = path
        while ancestor:
            ancestor = _parent_dir(ancestor)
            if ancestor in working:
                subtree[ancestor] += item["files"]
    records = [
        {**_finalize(path, item), "subtree_files": subtree[path]}
        for path, item in working.items()
    ]
    records.sort(key=lambda item: (item["path"] != ".", item["path"]))
    payload = {
        "version": VERSION,
        "source": source,
        "file_count": len(files),
        "directories": records,
        "build_modules": [
            item for item in build_modules if ("" if item == "." else item) in kept
        ],
        "source_sets": [item for item in source_sets if item in kept],
        "truncated": keep_count < len(candidates),
    }
    total = sum(item["files"] for item in records)
    if total != len(files) or subtree.get("", 0) != len(files):
        raise AssertionError("index partition lost files during assembly")
    return payload


def _maven_modules(pin: pathlib.Path, files: list[str]) -> list[str]:
    pom_paths = sorted(
        path for path in files if pathlib.PurePosixPath(path).name == "pom.xml"
    )
    modules = {"." if path == "pom.xml" else _parent_of(path) for path in pom_paths}
    for pom in pom_paths:
        disk = pin.joinpath(*pathlib.PurePosixPath(pom).parts)
        try:
            root = ElementTree.fromstring(disk.read_bytes())
        except (OSError, ElementTree.ParseError):
            continue
        base = _parent_of(pom)
        for item in root.findall("./{*}modules/{*}module"):
            value = (item.text or "").strip().replace("\\", "/").strip("/")
            pure = pathlib.PurePosixPath(value)
            if not value or pure.is_absolute() or ".." in pure.parts:
                continue
            path = "/".join(part for part in (base, pure.as_posix()) if part)
            if f"{path}/pom.xml" in files:
                modules.add(path)
    return sorted(modules, key=lambda path: (path != ".", path))


def _source_sets(files: list[str]) -> list[str]:
    result = set()
    for path in files:
        match = SOURCE_SET.match(path)
        if match:
            prefix = f"{match.group('module')}/" if match.group("module") else ""
            result.add(f"{prefix}src/{match.group('set')}/{match.group('language')}")
    return sorted(result)


def scope_digest(
    pin: pathlib.Path, files: list[str], roots: list[str] | tuple[str, ...]
) -> str:
    """Hash the inventory and contents selected by relative scope roots."""

    if not roots:
        raise ValueError("at least one scope root is required")
    normalized = []
    for root in roots:
        pure = pathlib.PurePosixPath(root)
        if not root or pure.is_absolute() or ".." in pure.parts or "\\" in root:
            raise ValueError("scope roots must be relative POSIX paths")
        normalized.append("." if root == "." else pure.as_posix().strip("/"))
    selected = sorted(
        path
        for path in files
        if any(
            root == "." or path == root or path.startswith(root + "/")
            for root in normalized
        )
    )
    digest = hashlib.sha256()
    for root in sorted(set(normalized)):
        digest.update(b"root\0" + root.encode("utf-8") + b"\0")
    for rel in selected:
        candidate = pin.joinpath(*pathlib.PurePosixPath(rel).parts)
        digest.update(b"file\0" + rel.encode("utf-8") + b"\0")
        if candidate.is_symlink():
            digest.update(b"symlink\0" + os.fsencode(os.readlink(candidate)))
            continue
        disk = _workspace.resolve_pin_file(pin, rel)
        if disk is None:
            digest.update(b"missing")
            continue
        try:
            digest.update(hashlib.sha256(disk.read_bytes()).digest())
        except OSError:
            digest.update(b"missing")
    return digest.hexdigest()


def _keep_priority(path: str, stats: dict) -> tuple:
    """Sort key: candidates kept longest come first when the budget bites."""
    files = stats["files"]
    fully_generated = files > 0 and stats["generated_files"] == files
    test_only = files > 0 and stats["test_files"] == files
    depth = 0 if not path else path.count("/") + 1
    return (
        not stats["entry_points"],
        fully_generated,
        test_only,
        depth,
        -files,
        path,
    )


def _parent_of(rel: str) -> str:
    parent = pathlib.PurePosixPath(rel).parent
    return "" if parent == pathlib.PurePosixPath(".") else parent.as_posix()


def _parent_dir(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def _nearest_kept(path: str, kept: set[str]) -> str:
    while True:
        path = _parent_dir(path)
        if path in kept:
            return path


def _json_size(value: dict) -> int:
    return len(json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")) + 1


def _directory_shape(files: list[str]) -> tuple[set[str], dict[str, set[str]]]:
    direct_files: set[str] = set()
    child_dirs: dict[str, set[str]] = {}
    for rel in files:
        parent = pathlib.PurePosixPath(rel).parent
        parent_path = "" if parent == pathlib.PurePosixPath(".") else parent.as_posix()
        direct_files.add(parent_path)
        parts = parent.parts if parent_path else ()
        for index, part in enumerate(parts):
            owner = "/".join(parts[:index])
            child = "/".join((*parts[:index], part))
            child_dirs.setdefault(owner, set()).add(child)
    return direct_files, child_dirs


def list_directory(
    source: str,
    path: str,
    files: list[str],
    after: str | None = None,
) -> dict:
    direct_files, child_dirs = _directory_shape(files)
    owner = "" if path == "." else path
    items = [
        {"path": rel, "kind": "file"}
        for rel in files
        if (pathlib.PurePosixPath(rel).parent.as_posix() == owner)
        or (
            owner == ""
            and pathlib.PurePosixPath(rel).parent == pathlib.PurePosixPath(".")
        )
    ]
    for child in child_dirs.get(owner, set()):
        while child not in direct_files and len(child_dirs.get(child, ())) == 1:
            child = next(iter(child_dirs[child]))
        items.append({"path": child, "kind": "directory"})
    items.sort(key=lambda item: item["path"])
    if after is not None:
        positions = [index for index, item in enumerate(items) if item["path"] == after]
        if not positions:
            raise ValueError("after must name an item in this directory")
        items = items[positions[0] + 1 :]

    page: list[dict] = []
    for index, item in enumerate(items):
        candidate = {
            "source": source,
            "path": path,
            "items": [*page, item],
            "truncated": index < len(items) - 1,
            "next_after": item["path"] if index < len(items) - 1 else None,
        }
        if _json_size(candidate) > MAX_LS_BYTES:
            break
        page.append(item)
    if items and not page:
        raise ValueError("one directory item exceeds the listing byte budget")
    truncated = len(page) < len(items)
    return {
        "source": source,
        "path": path,
        "items": page,
        "truncated": truncated,
        "next_after": page[-1]["path"] if truncated else None,
    }


def _new_stats() -> dict:
    return {
        "files": 0,
        "bytes": 0,
        "lines": 0,
        "extensions": Counter(),
        "test_files": 0,
        "entry_points": [],
        "generated_files": 0,
        "rep_nonempty": [],
        "rep_any": [],
        "compressed_dirs": 0,
        "truncated_dirs": 0,
    }


def _copy_stats(stats: dict) -> dict:
    return {
        **stats,
        "extensions": Counter(stats["extensions"]),
        "entry_points": list(stats["entry_points"]),
        "rep_nonempty": list(stats["rep_nonempty"]),
        "rep_any": list(stats["rep_any"]),
    }


def _merge_stats(parent: dict, child: dict, reason: str) -> None:
    for key in ("files", "bytes", "lines", "test_files", "generated_files"):
        parent[key] += child[key]
    parent["extensions"] += child["extensions"]
    parent["entry_points"].extend(child["entry_points"])
    parent["compressed_dirs"] += child["compressed_dirs"]
    parent["truncated_dirs"] += child["truncated_dirs"]
    parent[reason] += 1


def _file_data(pin: pathlib.Path, rel: str) -> tuple[int, bytes | None]:
    if not pin.is_dir():
        return 0, None
    candidate = pin.joinpath(*pathlib.PurePosixPath(rel).parts)
    if candidate.is_symlink():
        raw = os.fsencode(os.readlink(candidate))
        return len(raw), raw
    disk = _workspace.resolve_pin_file(pin, rel)
    if disk is None or not disk.is_file():
        return 0, None
    try:
        size = disk.stat().st_size
        if pathlib.PurePosixPath(rel).suffix.lower() in BINARY_EXT:
            return size, None
        return size, disk.read_bytes()
    except OSError:
        return 0, None


def is_entry_point(rel: str) -> bool:
    name = pathlib.PurePosixPath(rel).name.lower()
    return name in ENTRY_NAMES or name in ENTRY_BASENAMES


def _accumulate_file(stats: dict, rel: str, size: int, raw: bytes | None) -> None:
    stats["files"] += 1
    suffix = pathlib.PurePosixPath(rel).suffix.lower()
    stats["extensions"][suffix or "(none)"] += 1
    if len(stats["rep_any"]) < 3:
        stats["rep_any"].append(rel)
    if size > 0 and len(stats["rep_nonempty"]) < 3:
        stats["rep_nonempty"].append(rel)
    if TEST_TOKEN.search(rel):
        stats["test_files"] += 1
    if is_entry_point(rel):
        stats["entry_points"].append(rel)
    stats["bytes"] += size
    if GENERATED_TOKEN.search(rel) or (raw and GENERATED_MARKER.search(raw[:2048])):
        stats["generated_files"] += 1
    if raw is None:
        return
    if raw.startswith(b"\0") or b"\0" in raw[:1024]:
        return
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return
    stats["lines"] += text.count("\n") + (0 if text.endswith("\n") or not text else 1)


def _representatives(stats: dict) -> list[str]:
    reps = list(stats["rep_nonempty"])
    for rel in stats["rep_any"]:
        if len(reps) >= 3:
            break
        if rel not in reps:
            reps.append(rel)
    return reps


def _finalize(path: str, stats: dict) -> dict:
    extensions = sorted(
        stats["extensions"].items(), key=lambda item: (-item[1], item[0])
    )
    entry_points = sorted(stats["entry_points"])
    return {
        "path": path or ".",
        "files": stats["files"],
        "bytes": stats["bytes"],
        "lines": stats["lines"],
        "test_files": stats["test_files"],
        "generated_files": stats["generated_files"],
        "entry_points": entry_points[:MAX_ENTRY_POINTS],
        "entry_points_omitted": max(0, len(entry_points) - MAX_ENTRY_POINTS),
        "representative_files": _representatives(stats),
        "extensions": dict(extensions[:MAX_EXTENSIONS]),
        "extensions_other": sum(count for _, count in extensions[MAX_EXTENSIONS:]),
        "compressed_dirs": stats["compressed_dirs"],
        "truncated_dirs": stats["truncated_dirs"],
    }
