import dataclasses
import json
import os
import pathlib
import re
import shutil
import subprocess
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit

from _files import atomic_json, directory_digest
from _models import RunPolicy, model_errors
from pydantic import ValidationError

VERSION = 1
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")
_RESERVED_NAMES = {"wiki", "workspace", "data"}
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class WorkspaceError(Exception):
    pass


@dataclasses.dataclass(frozen=True)
class Source:
    name: str
    kind: str
    path: pathlib.Path | None = None
    remote: str | None = None
    origin: str | None = None
    ref: str | None = None
    url_env: str | None = None
    schema: str | None = None
    tables: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclasses.dataclass(frozen=True)
class Workspace:
    root: pathlib.Path
    language: str
    freshness_days: int
    policy: RunPolicy
    sources: dict[str, Source]


def _config_path(root: pathlib.Path) -> pathlib.Path:
    return root / "workspace.json"


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


def _policy(value: object) -> RunPolicy:
    try:
        return RunPolicy.model_validate(value, strict=True)
    except ValidationError as exc:
        raise WorkspaceError(
            f"invalid workspace policy: {'; '.join(model_errors(exc))}"
        ) from exc


def policy_from_flat(
    values: dict[str, int | None], base: RunPolicy | None = None
) -> RunPolicy:
    policy = (base or RunPolicy.defaults()).model_dump(mode="json")
    targets = {
        "max_active_children": ("agents", "max_active_children"),
        "max_children_per_run": ("agents", "max_children_per_run"),
        "search_max_results": ("evidence", "search", "max_results"),
        "search_max_output_bytes": (
            "evidence",
            "search",
            "max_output_bytes",
        ),
        "read_default_lines": ("evidence", "read", "default_lines"),
        "read_max_lines": ("evidence", "read", "max_lines"),
        "read_max_output_bytes": ("evidence", "read", "max_output_bytes"),
    }
    for name, value in values.items():
        if value is None:
            continue
        target = policy
        *parents, field = targets[name]
        for parent in parents:
            target = target[parent]
        target[field] = value
    return _policy(policy)


def init(
    root: pathlib.Path,
    language: str = "en",
    freshness_days: int = 90,
    policy: RunPolicy | dict | None = None,
) -> Workspace:
    path = _config_path(root)
    if path.exists():
        raise WorkspaceError(f"workspace already exists: {path}")
    if language not in ("en", "zh"):
        raise WorkspaceError("language must be 'en' or 'zh'")
    if freshness_days < 1:
        raise WorkspaceError("freshness-days must be positive")
    policy = RunPolicy.defaults() if policy is None else _policy(policy)
    atomic_json(
        path,
        {
            "version": VERSION,
            "language": language,
            "freshness_days": freshness_days,
            "policy": policy.model_dump(mode="json"),
            "sources": [],
        },
    )
    gitignore = root / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text(".okf-wiki/\n.env\n", encoding="utf-8")
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
            f"unsupported workspace version {data.get('version')!r}; this kernel is v{VERSION}"
        )
    return data


def load(root: pathlib.Path) -> Workspace:
    data = _read(root)
    if data.get("language") not in ("en", "zh"):
        raise WorkspaceError("workspace language must be 'en' or 'zh'")
    freshness_days = data.get("freshness_days")
    if not isinstance(freshness_days, int) or freshness_days < 1:
        raise WorkspaceError("workspace freshness_days must be a positive integer")
    policy = _policy(data.get("policy"))
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
        if kind not in ("git", "opengauss", "files"):
            raise WorkspaceError(f"invalid source '{name}'")
        tables = entry.get("tables", [])
        if not isinstance(tables, list) or any(
            not isinstance(table, str) or not table for table in tables
        ):
            raise WorkspaceError(f"invalid table selection for source '{name}'")
        ref = entry.get("ref")
        stored_path = entry.get("path")
        source_path = None
        if kind in ("git", "files"):
            if not isinstance(stored_path, str) or (
                ref is not None and not isinstance(ref, str)
            ):
                raise WorkspaceError(f"invalid {kind} source '{name}'")
            pure = pathlib.PurePosixPath(stored_path)
            if pure.is_absolute() or ".." in pure.parts or stored_path in (".", ""):
                raise WorkspaceError(
                    f"source '{name}' path must be a named child of the workspace"
                )
            source_path = pathlib.Path(
                os.path.abspath(root / pathlib.Path(*pure.parts))
            )
        if kind == "opengauss" and (
            not isinstance(entry.get("url_env"), str)
            or not isinstance(entry.get("schema"), str)
        ):
            raise WorkspaceError(f"invalid opengauss source '{name}'")
        if source_path is not None and not source_path.is_dir():
            raise WorkspaceError(f"source '{name}' target not found: {source_path}")
        sources[name] = Source(
            name=name,
            kind=kind,
            path=source_path,
            remote=entry.get("remote"),
            origin=entry.get("origin"),
            ref=ref,
            url_env=entry.get("url_env"),
            schema=entry.get("schema"),
            tables=tuple(tables),
        )
    return Workspace(
        root=root,
        language=data.get("language", "en"),
        freshness_days=freshness_days,
        policy=policy,
        sources=sources,
    )


def configure(
    root: pathlib.Path,
    *,
    language: str | None = None,
    freshness_days: int | None = None,
    policy_updates: dict[str, int] | None = None,
) -> Workspace:
    data = _read(root)
    if _active_run(root):
        raise WorkspaceError(
            "workspace configuration cannot change during an active run"
        )
    current = load(root)
    language = current.language if language is None else language
    freshness_days = (
        current.freshness_days if freshness_days is None else freshness_days
    )
    if language not in ("en", "zh"):
        raise WorkspaceError("language must be 'en' or 'zh'")
    if freshness_days < 1:
        raise WorkspaceError("freshness-days must be positive")
    policy = policy_from_flat(policy_updates or {}, current.policy)
    data.update(
        language=language,
        freshness_days=freshness_days,
        policy=policy.model_dump(mode="json"),
    )
    atomic_json(_config_path(root), data)
    return load(root)


def _active_run(root: pathlib.Path) -> bool:
    import _state

    try:
        state = _state.read(root)
    except _state.StateError as exc:
        raise WorkspaceError(str(exc)) from exc
    return state is not None and state["status"] not in ("published", "abandoned")


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
    if resolved == root.resolve():
        raise WorkspaceError(
            "workspace is a hub; register each repository with --name, not '.'"
        )
    try:
        relative = resolved.relative_to(root.resolve()).as_posix()
    except ValueError:
        relative = None
    if relative == name:
        origin = relative
    else:
        mount = root / name
        if mount.exists() or mount.is_symlink():
            raise WorkspaceError(f"mount destination exists: {mount}")
        try:
            _mount_link(resolved, mount)
        except OSError as exc:
            raise WorkspaceError(
                f"cannot mount '{resolved}' at {mount}: {exc}"
            ) from exc
        relative = name
        origin = str(resolved)
    data["sources"].append(
        {
            "name": name,
            "kind": "git",
            "path": relative,
            "origin": origin,
        }
    )
    atomic_json(_config_path(root), data)
    _ignore_source(root, name)
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
    dest = root / name
    if dest.exists() or dest.is_symlink():
        raise WorkspaceError(f"clone destination exists: {dest}")
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
    origin = _safe_origin(target)
    data["sources"].append(
        {
            "name": name,
            "kind": "git",
            "path": name,
            "origin": origin,
            **({"ref": ref} if ref else {}),
        }
    )
    try:
        atomic_json(_config_path(root), data)
    except BaseException:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    _ignore_source(root, name)
    return load(root).sources[name]


def add_files_source(root: pathlib.Path, target: str, name: str) -> Source:
    data = _read(root)
    _check_add(root, data, name)
    resolved = pathlib.Path(target).resolve()
    if not resolved.is_dir():
        raise WorkspaceError(f"files source is not a directory: {resolved}")
    if resolved == root.resolve():
        raise WorkspaceError("workspace root cannot be a files source")
    try:
        relative = resolved.relative_to(root.resolve()).as_posix()
    except ValueError:
        relative = None
    if relative == name:
        origin = relative
    else:
        mount = root / name
        if mount.exists() or mount.is_symlink():
            raise WorkspaceError(f"mount destination exists: {mount}")
        try:
            _mount_link(resolved, mount)
        except OSError as exc:
            raise WorkspaceError(
                f"cannot mount '{resolved}' at {mount}: {exc}"
            ) from exc
        relative = name
        origin = str(resolved)
    data["sources"].append(
        {
            "name": name,
            "kind": "files",
            "path": relative,
            "origin": origin,
        }
    )
    atomic_json(_config_path(root), data)
    _ignore_source(root, name)
    return load(root).sources[name]


def add_opengauss_source(
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
            "opengauss source requires url-env, schema and selected tables"
        )
    if len(tables) != len(set(tables)):
        raise WorkspaceError("opengauss table selection contains duplicates")
    data["sources"].append(
        {
            "name": name,
            "kind": "opengauss",
            "url_env": url_env,
            "schema": schema,
            "tables": tables,
        }
    )
    atomic_json(_config_path(root), data)
    return load(root).sources[name]


def _ignore_source(root: pathlib.Path, name: str) -> None:
    gitignore = root / ".gitignore"
    marker = f"/{name}/"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    if marker not in existing.splitlines():
        gitignore.write_text(
            existing.rstrip()
            + ("\n" if existing and not existing.endswith("\n") else "")
            + marker
            + "\n",
            encoding="utf-8",
        )


def _check_add(root: pathlib.Path, data: dict, name: str) -> None:
    if _active_run(root):
        raise WorkspaceError("sources cannot change during an active run")
    if not _NAME_RE.fullmatch(name):
        raise WorkspaceError("source name must match [A-Za-z0-9][A-Za-z0-9-]*")
    if name.casefold() in {item.casefold() for item in _RESERVED_NAMES}:
        raise WorkspaceError(f"source name is reserved: {name}")
    if name.upper() in _WINDOWS_RESERVED:
        raise WorkspaceError(f"source name is reserved on Windows: {name}")
    if any(
        isinstance(entry.get("name"), str)
        and entry["name"].casefold() == name.casefold()
        for entry in data["sources"]
    ):
        raise WorkspaceError(f"source '{name}' already exists")


def capture_git_revision(root: pathlib.Path, source: Source) -> dict:
    assert source.path is not None
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
    origin = source.origin or source.remote or source.name
    return {"name": source.name, "commit": head, "origin": origin, "kind": "git"}


def capture_files_revision(root: pathlib.Path, source: Source) -> dict:
    assert source.path is not None
    digest = directory_digest(source.path)
    return {
        "name": source.name,
        "content_hash": digest,
        "origin": source.origin or source.name,
        "kind": "files",
    }


def pin_dir(root: pathlib.Path, run_id: str, name: str) -> pathlib.Path:
    return root / ".okf-wiki" / "pins" / run_id / name


def materialize_pin(
    root: pathlib.Path, run_id: str, source: Source, record: dict
) -> pathlib.Path:
    dest = pin_dir(root, run_id, source.name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        remove_pin(root, run_id, source)
    if source.kind == "git":
        assert source.path is not None
        commit = record["commit"]
        result = subprocess.run(
            [
                "git",
                "-C",
                str(source.path),
                "worktree",
                "add",
                "--detach",
                str(dest),
                commit,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise WorkspaceError(
                f"cannot pin '{source.name}' at {commit}: {result.stderr.strip()}"
            )
    elif source.kind == "files":
        assert source.path is not None
        shutil.copytree(source.path, dest, dirs_exist_ok=False)
    else:
        raise WorkspaceError(f"cannot pin source kind {source.kind}")
    return dest


def remove_pin(root: pathlib.Path, run_id: str, source: Source) -> None:
    dest = pin_dir(root, run_id, source.name)
    if source.kind == "git" and source.path is not None and dest.exists():
        _git(source.path, "worktree", "remove", "--force", str(dest), check=False)
    if dest.exists() or dest.is_symlink():
        shutil.rmtree(dest, ignore_errors=True)


def remove_run_pins(
    root: pathlib.Path, run_id: str, sources: dict[str, Source]
) -> None:
    for source in sources.values():
        if source.kind in ("git", "files"):
            remove_pin(root, run_id, source)
    pins = root / ".okf-wiki" / "pins" / run_id
    shutil.rmtree(pins, ignore_errors=True)


def assert_pin_current(
    root: pathlib.Path, run_id: str, source: Source, record: dict
) -> None:
    dest = pin_dir(root, run_id, source.name)
    if not dest.is_dir():
        raise WorkspaceError(f"pin missing for source '{source.name}'")
    if source.kind == "git":
        head = _git(dest, "rev-parse", "HEAD").stdout.strip()
        if head != record.get("commit"):
            raise WorkspaceError(
                f"pin for '{source.name}' drifted from the recorded commit"
            )
    elif source.kind == "files":
        if directory_digest(dest) != record.get("content_hash"):
            raise WorkspaceError(
                f"pin for '{source.name}' drifted from the recorded tree"
            )


def _safe_origin(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme not in ("http", "https"):
        return origin
    host = parsed.hostname or ""
    if parsed.port:
        host += f":{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, "", ""))


def resolve_pin_file(pin: pathlib.Path, rel: str) -> pathlib.Path | None:
    pure = pathlib.PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    candidate = pin.joinpath(*pure.parts)
    if candidate.is_symlink():
        return None
    path = candidate.resolve()
    try:
        path.relative_to(pin.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def resolve_source_file(source: Source, rel: str) -> pathlib.Path | None:
    return resolve_pin_file(source.path, rel) if source.path is not None else None


def tracked_files(source: Source, commit: str | None) -> list[str]:
    """Sorted repo-relative file paths: tracked at commit (git) or on disk (files)."""
    if source.path is None:
        return []
    if source.kind == "git":
        if commit is None or not re.fullmatch(r"[0-9a-f]{40,64}", commit):
            return []
        result = _git(
            source.path, "ls-tree", "-r", "-z", "--name-only", commit, check=False
        )
        if result.returncode:
            return []
        return sorted(item for item in result.stdout.split("\0") if item)
    return tree_files(source.path)


def tree_files(path: pathlib.Path) -> list[str]:
    return sorted(
        item.relative_to(path).as_posix() for item in path.rglob("*") if item.is_file()
    )


def captured_files(source: Source, pin: pathlib.Path, revision: dict) -> list[str]:
    return (
        tree_files(pin)
        if source.kind == "files"
        else tracked_files(source, revision.get("commit"))
    )


def scoped_files(files: list[str], paths) -> list[str]:
    selected = tuple(paths)
    return [
        item
        for item in files
        if any(
            path in ("", ".")
            or item == path.rstrip("/")
            or item.startswith(path.rstrip("/") + "/")
            for path in selected
        )
    ]


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
        [
            "git",
            "-C",
            str(source.path),
            "cat-file",
            "blob",
            f"{commit}:{pure.as_posix()}",
        ],
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def files_blob(source: Source, rel: str) -> bytes | None:
    path = resolve_source_file(source, rel)
    return path.read_bytes() if path is not None else None


def git_blob_oid(source: Source, commit: str, rel: str) -> str | None:
    pure = pathlib.PurePosixPath(rel)
    if (
        source.path is None
        or not re.fullmatch(r"[0-9a-f]{40,64}", commit)
        or pure.is_absolute()
        or ".." in pure.parts
    ):
        return None
    result = _git(source.path, "rev-parse", f"{commit}:{pure.as_posix()}", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def git_file_metadata(workspace: Workspace, revision: dict, rel: str) -> dict:
    source = workspace.sources.get(revision["name"])
    if source is None or source.path is None or source.kind != "git":
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
