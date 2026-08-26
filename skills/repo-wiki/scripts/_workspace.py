import dataclasses
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit

from _files import atomic_json

VERSION = 3
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_WINDOWS_INVALID = re.compile(r'[<>:"\\|?*\x00-\x1f]')


class WorkspaceError(Exception):
    pass


@dataclasses.dataclass(frozen=True)
class Source:
    name: str
    kind: str
    target: str
    path: pathlib.Path | None = None
    url_env: str | None = None
    schema: str | None = None
    tables: tuple[str, ...] = ()


@dataclasses.dataclass(frozen=True)
class Workspace:
    root: pathlib.Path
    language: str
    freshness_days: int
    sources: dict[str, Source]


def _config_path(root: pathlib.Path) -> pathlib.Path:
    return root / ".okf-wiki" / "workspace.json"


def _git(
    path: pathlib.Path, *args: str, check: bool = True
) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if check and result.returncode:
        raise WorkspaceError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result


def _is_git_repo(path: pathlib.Path) -> bool:
    return _git(path, "rev-parse", "--is-inside-work-tree", check=False).returncode == 0


def init(
    root: pathlib.Path, language: str = "en", freshness_days: int = 90
) -> Workspace:
    path = _config_path(root)
    if path.exists():
        raise WorkspaceError(f"workspace already exists: {path}")
    if language not in ("en", "zh"):
        raise WorkspaceError("language must be 'en' or 'zh'")
    if freshness_days < 1:
        raise WorkspaceError("freshness-days must be positive")
    sources = []
    if _is_git_repo(root):
        sources.append({"name": "self", "kind": "git", "target": str(root.resolve())})
    atomic_json(
        path,
        {
            "version": VERSION,
            "language": language,
            "freshness_days": freshness_days,
            "sources": sources,
        },
    )
    return load(root)


def _read(root: pathlib.Path) -> dict:
    path = _config_path(root)
    if not path.exists():
        raise WorkspaceError("workspace not initialized; run 'workspace init'")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise WorkspaceError(f"invalid workspace config: {exc}") from exc
    if not isinstance(data, dict):
        raise WorkspaceError("workspace config must be an object")
    if data.get("version") != VERSION:
        raise WorkspaceError(
            f"unsupported workspace version {data.get('version')!r}; recreate it with v3"
        )
    return data


def load(root: pathlib.Path) -> Workspace:
    data = _read(root)
    if data.get("language") not in ("en", "zh"):
        raise WorkspaceError("workspace language must be 'en' or 'zh'")
    freshness_days = data.get("freshness_days")
    if not isinstance(freshness_days, int) or freshness_days < 1:
        raise WorkspaceError("workspace freshness_days must be a positive integer")
    entries = data.get("sources")
    if not isinstance(entries, list):
        raise WorkspaceError("workspace sources must be a list")
    sources: dict[str, Source] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise WorkspaceError("workspace source must be an object")
        name = entry.get("name")
        kind = entry.get("kind")
        target = entry.get("target")
        if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
            raise WorkspaceError(f"invalid source name: {name!r}")
        if name in sources:
            raise WorkspaceError(f"duplicate source: {name}")
        if kind not in ("git", "postgres") or not isinstance(target, str):
            raise WorkspaceError(f"invalid source '{name}'")
        tables = entry.get("tables", [])
        if not isinstance(tables, list) or any(
            not isinstance(table, str) or not table for table in tables
        ):
            raise WorkspaceError(f"invalid table selection for source '{name}'")
        source_path = pathlib.Path(target) if kind == "git" else None
        if kind == "postgres" and (
            not isinstance(entry.get("url_env"), str)
            or not isinstance(entry.get("schema"), str)
        ):
            raise WorkspaceError(f"invalid postgres source '{name}'")
        if source_path is not None and not source_path.is_dir():
            raise WorkspaceError(f"source '{name}' target not found: {source_path}")
        sources[name] = Source(
            name=name,
            kind=kind,
            target=target,
            path=source_path,
            url_env=entry.get("url_env"),
            schema=entry.get("schema"),
            tables=tuple(tables),
        )
    return Workspace(
        root=root,
        language=data.get("language", "en"),
        freshness_days=freshness_days,
        sources=sources,
    )


def _active_run(root: pathlib.Path) -> bool:
    pointer = root / ".okf-wiki" / "current-run.json"
    if not pointer.exists():
        return False
    try:
        run_id = json.loads(pointer.read_text(encoding="utf-8"))["run_id"]
        if not isinstance(run_id, str) or not re.fullmatch(
            r"r-\d{8}-[0-9a-f]{6}", run_id
        ):
            return True
        state = json.loads(
            (root / ".okf-wiki" / "runs" / run_id / "state.json").read_text()
        )
        return state.get("status") not in ("published", "abandoned")
    except (KeyError, OSError, json.JSONDecodeError):
        return True


def add_git_source(root: pathlib.Path, target: str, name: str) -> Source:
    data = _read(root)
    _check_add(root, data, name)
    is_url = target.startswith(("http://", "https://", "git@", "git://", "file://"))
    if is_url:
        dest = root / ".okf-wiki" / "sources" / name
        if dest.exists():
            raise WorkspaceError(f"clone destination exists: {dest}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["git", "clone", target, str(dest)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            shutil.rmtree(dest, ignore_errors=True)
            raise WorkspaceError(f"git clone failed: {result.stderr.strip()}")
        resolved = dest.resolve()
    else:
        resolved = pathlib.Path(target).resolve()
        if not resolved.is_dir() or not _is_git_repo(resolved):
            raise WorkspaceError(f"target is not a Git worktree: {resolved}")
    data["sources"].append({"name": name, "kind": "git", "target": str(resolved)})
    atomic_json(_config_path(root), data)
    return load(root).sources[name]


def add_postgres_source(
    root: pathlib.Path,
    name: str,
    url_env: str,
    schema: str,
    tables: list[str],
) -> Source:
    data = _read(root)
    _check_add(root, data, name)
    if not url_env or not schema or not tables:
        raise WorkspaceError(
            "postgres source requires url-env, schema and selected tables"
        )
    if len(tables) != len(set(tables)):
        raise WorkspaceError("postgres table selection contains duplicates")
    data["sources"].append(
        {
            "name": name,
            "kind": "postgres",
            "target": f"postgres:{name}",
            "url_env": url_env,
            "schema": schema,
            "tables": tables,
        }
    )
    atomic_json(_config_path(root), data)
    return load(root).sources[name]


def _check_add(root: pathlib.Path, data: dict, name: str) -> None:
    if _active_run(root):
        raise WorkspaceError("sources cannot change during an active run")
    if not _NAME_RE.fullmatch(name):
        raise WorkspaceError("source name must match [a-z0-9][a-z0-9-]*")
    if any(entry.get("name") == name for entry in data["sources"]):
        raise WorkspaceError(f"source '{name}' already exists")


def _portable_path(path: str, seen: dict[str, str]) -> None:
    folded = path.casefold()
    if folded in seen and seen[folded] != path:
        raise WorkspaceError(
            f"case-insensitive path collision: {seen[folded]!r} and {path!r}"
        )
    seen[folded] = path
    for part in pathlib.PurePosixPath(path).parts:
        stem = part.rstrip(". ").split(".", 1)[0].upper()
        if not part or part.endswith((".", " ")) or _WINDOWS_INVALID.search(part):
            raise WorkspaceError(f"path is not portable to Windows: {path!r}")
        if stem in _WINDOWS_RESERVED:
            raise WorkspaceError(f"path uses a Windows reserved name: {path!r}")


def snapshot_git(root: pathlib.Path, source: Source) -> dict:
    assert source.path is not None
    args = ["status", "--porcelain", "--untracked-files=all"]
    if source.path.resolve() == root.resolve():
        args.extend(["--", ".", ":(exclude).okf-wiki"])
    dirty = _git(source.path, *args).stdout
    if dirty.strip():
        raise WorkspaceError(
            f"source '{source.name}' has uncommitted or untracked files"
        )
    if _git(source.path, "ls-files", "--", ".okf-wiki").stdout.strip():
        raise WorkspaceError(
            f"source '{source.name}' tracks .okf-wiki; runtime metadata cannot be evidence"
        )
    head = _git(source.path, "rev-parse", "HEAD").stdout.strip()
    gitlinks = _git(source.path, "ls-files", "--stage").stdout.splitlines()
    if any(line.startswith("160000 ") for line in gitlinks):
        raise WorkspaceError(
            f"source '{source.name}' contains submodules; register each submodule as a source"
        )

    with tempfile.TemporaryDirectory(dir=root / ".okf-wiki") as temp_name:
        temp = pathlib.Path(temp_name)
        archive = temp / "source.tar"
        with archive.open("wb") as handle:
            result = subprocess.run(
                ["git", "-C", str(source.path), "archive", "--format=tar", head],
                stdout=handle,
                check=False,
            )
        if result.returncode:
            raise WorkspaceError(f"git archive failed for source '{source.name}'")
        tree = temp / "tree"
        tree.mkdir()
        seen: dict[str, str] = {}
        with tarfile.open(archive) as tar:
            for member in tar:
                path = member.name.rstrip("/")
                if not path:
                    continue
                _portable_path(path, seen)
                destination = tree.joinpath(*pathlib.PurePosixPath(path).parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if member.isfile():
                    stream = tar.extractfile(member)
                    if stream is not None:
                        destination.write_bytes(stream.read())
                elif member.issym():
                    destination.write_text(member.linkname, encoding="utf-8")

        files: dict[str, str] = {}
        digest = hashlib.sha256()
        for path in sorted(p for p in tree.rglob("*") if p.is_file()):
            rel = path.relative_to(tree).as_posix()
            content = path.read_bytes()
            file_hash = hashlib.sha256(content).hexdigest()
            files[rel] = file_hash
            digest.update(rel.encode("utf-8") + b"\0" + content)
        content_hash = digest.hexdigest()
        destination = root / ".okf-wiki" / "snapshots" / content_hash
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(temp), str(destination))
            (destination / "source.tar").unlink(missing_ok=True)

    remote = _git(
        source.path, "config", "--get", "remote.origin.url", check=False
    ).stdout.strip()
    manifest = {
        "name": source.name,
        "kind": "git",
        "commit": head,
        "content_hash": content_hash,
        "origin": _safe_origin(remote or source.target),
        "files": files,
    }
    atomic_json(
        root / ".okf-wiki" / "snapshots" / content_hash / "manifest.json", manifest
    )
    return manifest


def _safe_origin(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme not in ("http", "https"):
        return origin
    host = parsed.hostname or ""
    if parsed.port:
        host += f":{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, "", ""))


def resolve_snapshot_file(
    root: pathlib.Path, snapshot: dict, rel: str
) -> pathlib.Path | None:
    if (
        snapshot.get("kind") != "git"
        or not re.fullmatch(r"[0-9a-f]{64}", snapshot.get("content_hash", ""))
        or rel not in snapshot.get("files", {})
    ):
        return None
    snapshot_root = (root / ".okf-wiki" / "snapshots").resolve()
    candidate = (snapshot_root / snapshot["content_hash"] / "tree").resolve()
    path = candidate.joinpath(*pathlib.PurePosixPath(rel).parts).resolve()
    try:
        candidate.relative_to(snapshot_root)
        path.relative_to(candidate.resolve())
    except ValueError:
        return None
    return path


def git_file_metadata(workspace: Workspace, snapshot: dict, rel: str) -> dict:
    source = workspace.sources.get(snapshot["name"])
    if source is None or source.path is None:
        return {}
    result = _git(
        source.path,
        "log",
        "-1",
        "--format=%aE%x00%aI",
        snapshot["commit"],
        "--",
        rel,
        check=False,
    )
    if result.returncode or not result.stdout.strip():
        return {}
    email, _, raw_date = result.stdout.strip().partition("\0")
    try:
        changed = datetime.fromisoformat(raw_date).date()
    except ValueError:
        changed = None
    return {"author": f"git:{email}" if email else None, "last_modified": changed}
