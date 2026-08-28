"""Deterministic structural index for Git/files Pins. Zero LLM.

Index invariants (v2):
- every directory record describes a disjoint region of files; a file is
  counted by exactly one record, so record counts are additive;
- a record's fields describe the record's region directly (no recursive
  roll-up); `subtree_files` is the only derived subtree metric;
- the byte budget coarsens the index by merging records into their nearest
  kept ancestor (`collapsed_dirs` accounts for them) — no file ever loses
  its record.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
from collections import Counter

from _files import atomic_json

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
    r"(^|/)(tests?|spec|__tests__)(/|$)|(^|[/._-])tests?\.|_test\.|\.spec\.", re.I
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
VERSION = 2
MAX_INDEX_BYTES = 64 * 1024
MAX_LS_BYTES = 16 * 1024
WINDOW = 20
MAX_EXCERPT_LINE_CHARS = 500
EXCERPT_CLIP_MARK = "…[clipped]"
MAX_ENTRY_POINTS = 16
MAX_EXTENSIONS = 20
GENERATED_TOKEN = re.compile(r"(^|/)(generated|vendor|dist|build)(/|$)", re.I)
GENERATED_MARKER = re.compile(rb"generated (by|file)|do not edit", re.I)
PROTECTED_TOKEN = re.compile(
    r"(^|/)(auth|security|migrations?|api|public|contracts?)(/|$)", re.I
)


def index_path(base: pathlib.Path, source: str) -> pathlib.Path:
    return base / "drafts" / "index" / f"{source.lower()}.json"


def evidence_path(base: pathlib.Path, target: str) -> pathlib.Path:
    return base / "drafts" / "evidence" / f"{target}.json"


def write_source_index(
    root: pathlib.Path, run_id: str, source, revision: dict
) -> dict:
    import _state
    import _workspace

    pin = _workspace.pin_dir(root, run_id, source.name)
    files = _workspace.scoped_files(
        _workspace.captured_files(source, pin, revision),
        ["."],
        source.survey_exclude,
    )
    payload = build_index(source.name, pin, files, source.survey_split)
    path = index_path(_state.run_dir(root, run_id), source.name)
    atomic_json(path, payload)
    return payload


def build_index(
    source: str,
    pin: pathlib.Path,
    files: list[str],
    forced_splits: tuple[str, ...] = (),
) -> dict:
    required = {"", *(item.strip("/") for item in forced_splits)}
    direct_files, child_dirs = _directory_shape(files)
    visible = required | direct_files | {
        path for path, children in child_dirs.items() if len(children) > 1
    }
    stats = {path: _new_stats() for path in visible}
    for rel in files:
        size, raw = _file_data(pin, rel)
        _accumulate_file(stats[_parent_of(rel)], rel, size, raw)
    candidates = sorted(
        (path for path in stats if path not in required),
        key=lambda path: _keep_priority(path, stats[path]),
    )
    full = _assemble(source, files, stats, required, candidates, len(candidates))
    if _json_size(full) <= MAX_INDEX_BYTES:
        return full
    floor = _assemble(source, files, stats, required, candidates, 0)
    if _json_size(floor) > MAX_INDEX_BYTES:
        raise ValueError("configured survey.split entries exceed the index byte budget")
    lo, hi = 0, len(candidates)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        probe = _assemble(source, files, stats, required, candidates, mid)
        if _json_size(probe) <= MAX_INDEX_BYTES:
            lo = mid
        else:
            hi = mid
    return _assemble(source, files, stats, required, candidates, lo)


def _assemble(
    source: str,
    files: list[str],
    stats: dict[str, dict],
    required: set[str],
    candidates: list[str],
    keep_count: int,
) -> dict:
    kept = required | set(candidates[:keep_count])
    working = {path: _copy_stats(item) for path, item in stats.items()}
    for path in list(working):
        if path in kept:
            continue
        _merge_stats(working[_nearest_kept(path, kept)], working[path])
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
        "truncated": keep_count < len(candidates),
    }
    total = sum(item["files"] for item in records)
    if total != len(files) or subtree.get("", 0) != len(files):
        raise AssertionError("index partition lost files during assembly")
    return payload


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
    forced_splits: tuple[str, ...] = (),
    after: str | None = None,
) -> dict:
    direct_files, child_dirs = _directory_shape(files)
    owner = "" if path == "." else path
    forced = {item.strip("/") for item in forced_splits}
    items = [
        {"path": rel, "kind": "file"}
        for rel in files
        if (pathlib.PurePosixPath(rel).parent.as_posix() == owner)
        or (owner == "" and pathlib.PurePosixPath(rel).parent == pathlib.PurePosixPath("."))
    ]
    for child in child_dirs.get(owner, set()):
        while (
            child not in forced
            and child not in direct_files
            and len(child_dirs.get(child, ())) == 1
        ):
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
        "collapsed_dirs": 0,
    }


def _copy_stats(stats: dict) -> dict:
    return {
        **stats,
        "extensions": Counter(stats["extensions"]),
        "entry_points": list(stats["entry_points"]),
        "rep_nonempty": list(stats["rep_nonempty"]),
        "rep_any": list(stats["rep_any"]),
    }


def _merge_stats(parent: dict, child: dict) -> None:
    for key in ("files", "bytes", "lines", "test_files", "generated_files"):
        parent[key] += child[key]
    parent["extensions"] += child["extensions"]
    parent["entry_points"].extend(child["entry_points"])
    parent["collapsed_dirs"] += child["collapsed_dirs"] + 1


def _file_data(pin: pathlib.Path, rel: str) -> tuple[int, bytes | None]:
    disk = pin.joinpath(*pathlib.PurePosixPath(rel).parts) if pin.is_dir() else None
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


def is_protected(rel: str) -> bool:
    return is_entry_point(rel) or bool(PROTECTED_TOKEN.search(rel))


def is_generated(pin: pathlib.Path, rel: str) -> bool:
    if GENERATED_TOKEN.search(rel):
        return True
    disk = pin.joinpath(*pathlib.PurePosixPath(rel).parts)
    try:
        with disk.open("rb") as handle:
            return bool(GENERATED_MARKER.search(handle.read(2048)))
    except OSError:
        return False


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
    extensions = sorted(stats["extensions"].items(), key=lambda item: (-item[1], item[0]))
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
        "collapsed_dirs": stats["collapsed_dirs"],
    }


def excerpt(content: bytes, lo: int | None, hi: int | None, window: int = WINDOW) -> str:
    text = content.decode("utf-8")
    lines = text.splitlines()
    if lo is None:
        start, end = 1, min(len(lines), window * 2)
    else:
        start = max(1, lo - window)
        end = min(len(lines), (hi or lo) + window)
    numbered = []
    for index in range(start, end + 1):
        line = lines[index - 1]
        if len(line) > MAX_EXCERPT_LINE_CHARS:
            line = line[:MAX_EXCERPT_LINE_CHARS] + EXCERPT_CLIP_MARK
        numbered.append(f"{index}|{line}")
    return "\n".join(numbered) + ("\n" if numbered else "")


def _survey_cache(root: pathlib.Path, state: dict, task: dict, survey) -> dict:
    import _validate

    findings = []
    for finding in survey.findings:
        excerpts = []
        for locator in finding.evidence:
            resolved = _validate._resolve_resource(root, state, locator)
            if resolved is None:
                raise ValueError(f"unresolved locator after survey validation: {locator}")
            text = excerpt(*resolved)
            excerpts.append(
                {
                    "locator": locator,
                    "digest": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    "text": text,
                }
            )
        findings.append({"id": finding.id, "excerpts": excerpts})
    return {
        "version": VERSION,
        "target": task["name"],
        "source": survey.source,
        "pin": _pin_digest(state, survey.source),
        "window": {"version": 2, "lines": WINDOW},
        "findings": findings,
    }


def materialize_survey(root: pathlib.Path, state: dict, task: dict) -> pathlib.Path:
    """Rebuild one disposable evidence cache from a completed Survey and its Pins."""
    import _state
    from _models import Survey

    base = _state.run_dir(root, state["run_id"])
    survey = Survey.model_validate_json(
        (base / task["artifact"]).read_text(encoding="utf-8"), strict=True
    )
    path = evidence_path(base, task["name"])
    atomic_json(path, _survey_cache(root, state, task, survey))
    return path


def _pin_digest(state: dict, source: str) -> str:
    revision = next(item for item in state["revisions"] if item["name"] == source)
    return revision.get("commit") or revision["content_hash"]


def _cache_valid(
    root: pathlib.Path, path: pathlib.Path, base: pathlib.Path, state: dict, task: dict
) -> bool:
    from _models import Survey

    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
        survey = Survey.model_validate_json(
            (base / task["artifact"]).read_text(encoding="utf-8"),
            strict=True,
        )
        return cache == _survey_cache(root, state, task, survey)
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def ensure_evidence_cache(root: pathlib.Path, state: dict) -> list[pathlib.Path]:
    base = root / ".okf-wiki" / "runs" / state["run_id"]
    result = []
    for task in state["tasks"].values():
        if task["phase"] != "survey" or task["status"] != "complete":
            continue
        path = evidence_path(base, task["name"])
        result.append(
            path
            if _cache_valid(root, path, base, state, task)
            else materialize_survey(root, state, task)
        )
    return result
