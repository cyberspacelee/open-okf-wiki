import dataclasses
import json
import os
import pathlib
import re
import shutil
import subprocess
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit

from _files import atomic_json

VERSION = 4
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")
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
    path: pathlib.Path | None = None
    remote: str | None = None
    ref: str | None = None
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
    atomic_json(
        path,
        {
            "version": VERSION,
            "language": language,
            "freshness_days": freshness_days,
            "sources": [],
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
            f"unsupported workspace version {data.get('version')!r}; recreate it with v4"
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
        if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
            raise WorkspaceError(f"invalid source name: {name!r}")
        if any(existing.casefold() == name.casefold() for existing in sources):
            raise WorkspaceError(f"duplicate source: {name}")
        if kind not in ("git", "postgres"):
            raise WorkspaceError(f"invalid source '{name}'")
        tables = entry.get("tables", [])
        if not isinstance(tables, list) or any(
            not isinstance(table, str) or not table for table in tables
        ):
            raise WorkspaceError(f"invalid table selection for source '{name}'")
        ref = entry.get("ref")
        stored_path = entry.get("path")
        source_path = None
        if kind == "git" and (
            not isinstance(stored_path, str)
            or (ref is not None and not isinstance(ref, str))
        ):
            raise WorkspaceError(f"invalid Git source '{name}'")
        if kind == "git":
            pure = pathlib.PurePosixPath(stored_path)
            if pure.is_absolute() or ".." in pure.parts:
                raise WorkspaceError(f"source '{name}' path must be inside workspace")
            # abspath, not resolve(): mounted links must keep their in-workspace path
            source_path = pathlib.Path(
                os.path.abspath(root / pathlib.Path(*pure.parts))
            )
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
            path=source_path,
            remote=entry.get("remote"),
            ref=ref,
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


def _mount_link(target: pathlib.Path, mount: pathlib.Path) -> None:
    """Mount an external worktree inside the workspace (junction on Windows)."""
    mount.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(mount))
    else:
        mount.symlink_to(target, target_is_directory=True)


def add_git_link(root: pathlib.Path, target: str, name: str) -> Source:
    data = _read(root)
    _check_add(root, data, name)
    resolved = pathlib.Path(target).resolve()
    if not resolved.is_dir() or not _is_git_repo(resolved):
        raise WorkspaceError(f"target is not a Git worktree: {resolved}")
    try:
        relative = resolved.relative_to(root.resolve()).as_posix() or "."
    except ValueError:
        mount = root / ".okf-wiki" / "sources" / name
        if mount.exists() or mount.is_symlink():
            raise WorkspaceError(f"mount destination exists: {mount}")
        try:
            _mount_link(resolved, mount)
        except OSError as exc:
            raise WorkspaceError(
                f"cannot mount '{resolved}' at {mount}: {exc}"
            ) from exc
        relative = mount.relative_to(root).as_posix()
    data["sources"].append(
        {
            "name": name,
            "kind": "git",
            "path": relative,
        }
    )
    atomic_json(_config_path(root), data)
    return load(root).sources[name]


def add_git_clone(
    root: pathlib.Path, target: str, name: str, ref: str | None = None
) -> Source:
    data = _read(root)
    _check_add(root, data, name)
    if not target.strip():
        raise WorkspaceError("clone requires a Git URL")
    if ref is not None and not ref.strip():
        raise WorkspaceError("clone ref must not be empty")
    dest = root / ".okf-wiki" / "sources" / name
    if dest.exists():
        raise WorkspaceError(f"clone destination exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "clone", "--", target, str(dest)],
        capture_output=True,
        text=True,
        check=False,
    )
    operation = "clone"
    if result.returncode == 0 and ref:
        operation = "checkout"
        result = _git(dest, "checkout", "--detach", ref, check=False)
    if result.returncode:
        shutil.rmtree(dest, ignore_errors=True)
        message = result.stderr.strip().replace(target, _safe_origin(target))
        raise WorkspaceError(f"git {operation} failed: {message}")
    data["sources"].append(
        {
            "name": name,
            "kind": "git",
            "path": dest.relative_to(root).as_posix(),
            "remote": _safe_origin(target),
            **({"ref": ref} if ref else {}),
        }
    )
    try:
        atomic_json(_config_path(root), data)
    except BaseException:
        shutil.rmtree(dest, ignore_errors=True)
        raise
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
        raise WorkspaceError("source name must match [A-Za-z0-9][A-Za-z0-9-]*")
    if name.upper() in _WINDOWS_RESERVED:
        raise WorkspaceError(f"source name is reserved on Windows: {name}")
    if any(
        isinstance(entry.get("name"), str)
        and entry["name"].casefold() == name.casefold()
        for entry in data["sources"]
    ):
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


def capture_git_revision(root: pathlib.Path, source: Source) -> dict:
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

    seen: dict[str, str] = {}
    for path in _git(
        source.path, "ls-tree", "-rz", "--name-only", head
    ).stdout.split("\0"):
        if path:
            _portable_path(path, seen)
    return {
        "name": source.name,
        "commit": head,
        "origin": source.remote
        or source.path.relative_to(root.resolve()).as_posix()
        or ".",
    }


def _safe_origin(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme not in ("http", "https"):
        return origin
    host = parsed.hostname or ""
    if parsed.port:
        host += f":{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, "", ""))


def resolve_source_file(source: Source, rel: str) -> pathlib.Path | None:
    if source.path is None:
        return None
    pure = pathlib.PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    path = source.path.joinpath(*pure.parts).resolve()
    try:
        path.relative_to(source.path.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def assert_git_revision(root: pathlib.Path, source: Source, revision: dict) -> None:
    current = capture_git_revision(root, source)
    if current["commit"] != revision.get("commit"):
        raise WorkspaceError(f"source '{source.name}' changed during the run")


def git_top_level(source: Source, commit: str) -> list[str]:
    """Sorted top-level tracked directories (fallback: tracked files) at commit."""
    if source.path is None or not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        return []
    result = _git(
        source.path, "ls-tree", "-z", "--name-only", commit, check=False
    )
    if result.returncode:
        return []
    entries = [item for item in result.stdout.split("\0") if item]
    dirs = _git(
        source.path, "ls-tree", "-z", "--name-only", "-d", commit, check=False
    )
    top_dirs = (
        [item for item in dirs.stdout.split("\0") if item]
        if not dirs.returncode
        else []
    )
    return sorted(top_dirs) or sorted(entries)


def git_blob(source: Source, commit: str, rel: str) -> bytes | None:
    pure = pathlib.PurePosixPath(rel)
    if (
        source.path is None
        or not re.fullmatch(r"[0-9a-f]{40,64}", commit)
        or pure.is_absolute()
        or ".." in pure.parts
    ):
        return None
    result = subprocess.run(
        ["git", "-C", str(source.path), "show", f"{commit}:{pure.as_posix()}"],
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def git_blob_oid(source: Source, commit: str, rel: str) -> str | None:
    pure = pathlib.PurePosixPath(rel)
    if (
        source.path is None
        or not re.fullmatch(r"[0-9a-f]{40,64}", commit)
        or pure.is_absolute()
        or ".." in pure.parts
    ):
        return None
    result = _git(
        source.path, "rev-parse", f"{commit}:{pure.as_posix()}", check=False
    )
    return result.stdout.strip() if result.returncode == 0 else None


def git_file_metadata(workspace: Workspace, revision: dict, rel: str) -> dict:
    source = workspace.sources.get(revision["name"])
    if source is None or source.path is None:
        return {}
    result = _git(
        source.path,
        "log",
        "-1",
        "--format=%aE%x00%aI",
        revision["commit"],
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
