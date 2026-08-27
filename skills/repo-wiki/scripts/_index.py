"""Deterministic structural index for Git/files Pins. Zero LLM."""

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
TEST_TOKEN = re.compile(r"(^|/)(tests?|spec|__tests__)(/|$)|test[s]?\.|_test\.|\.spec\.", re.I)
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
VERSION = 1
MAX_INDEX_BYTES = 64 * 1024
WINDOW = 20
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
    files = (
        _workspace.tree_files(pin)
        if source.kind == "files"
        else _workspace.tracked_files(source, revision.get("commit"))
    )
    exclude = [item.strip("/") for item in source.survey_exclude if item.strip("/")]
    if exclude:
        files = [
            item
            for item in files
            if not any(item == entry or item.startswith(entry + "/") for entry in exclude)
        ]
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
    directories: dict[str, dict] = {}
    for rel in files:
        size, raw = _file_data(pin, rel)
        for parent in _parents(rel):
            _accumulate_file(_ensure_dir(directories, parent), rel, size, raw)
    records = [_finalize(path, stats) for path, stats in directories.items()]
    records.sort(key=lambda item: (item["path"] != ".", item["path"]))
    payload = {
        "version": VERSION,
        "source": source,
        "file_count": len(files),
        "directories": records,
        "truncated": False,
    }
    if _json_size(payload) <= MAX_INDEX_BYTES:
        return payload
    required = {".", *(item.strip("/") for item in forced_splits)}
    kept = [item for item in records if item["path"] in required]
    candidates = [item for item in records if item["path"] not in required]
    candidates.sort(
        key=lambda item: (bool(item["entry_points"]), item["files"]), reverse=True
    )
    payload["truncated"] = True
    payload["directories"] = kept
    if _json_size(payload) > MAX_INDEX_BYTES:
        raise ValueError("configured survey.split entries exceed the index byte budget")
    for item in candidates:
        payload["directories"].append(item)
        if _json_size(payload) > MAX_INDEX_BYTES:
            payload["directories"].pop()
    payload["directories"].sort(key=lambda item: item["path"])
    return payload


def _json_size(value: dict) -> int:
    return len(json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")) + 1


def _parents(rel: str) -> list[str]:
    parent = pathlib.PurePosixPath(rel).parent
    result = [""]
    if parent == pathlib.PurePosixPath("."):
        return result
    parts: list[str] = []
    for part in parent.parts:
        parts.append(part)
        result.append("/".join(parts))
    return result


def _ensure_dir(directories: dict[str, dict], path: str) -> dict:
    if path not in directories:
        directories[path] = {
            "files": 0,
            "bytes": 0,
            "lines": 0,
            "extensions": Counter(),
            "test_files": 0,
            "entry_points": [],
            "generated_files": 0,
            "representative_files": [],
        }
    return directories[path]


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
    if len(stats["representative_files"]) < 3:
        stats["representative_files"].append(rel)
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


def _finalize(path: str, stats: dict) -> dict:
    extensions = sorted(stats["extensions"].items(), key=lambda item: (-item[1], item[0]))
    return {
        "path": path or ".",
        **{key: value for key, value in stats.items() if key != "extensions"},
        "extensions": dict(extensions[:20]),
        "entry_points": sorted(stats["entry_points"])[:16],
    }


def excerpt(content: bytes, lo: int | None, hi: int | None, window: int = WINDOW) -> str:
    text = content.decode("utf-8")
    lines = text.splitlines()
    if lo is None:
        start, end = 1, min(len(lines), window * 2)
    else:
        start = max(1, lo - window)
        end = min(len(lines), (hi or lo) + window)
    numbered = [f"{index}|{lines[index - 1]}" for index in range(start, end + 1)]
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
        "window": {"version": 1, "lines": WINDOW},
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
