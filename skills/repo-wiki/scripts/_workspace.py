import dataclasses
import json
import pathlib
import re
import subprocess


class WorkspaceError(Exception): ...


@dataclasses.dataclass
class Source:
    name: str
    path: pathlib.Path
    origin: str  # "self" | "link" | "clone"


@dataclasses.dataclass
class Workspace:
    root: pathlib.Path
    language: str
    implicit: bool
    sources: dict[str, Source]

    def resolve_locator(self, locator: str) -> pathlib.Path | None:
        anchor_stripped = locator.split("#")[0]
        parts = anchor_stripped.split("/", 1)
        if self.implicit:
            rel = anchor_stripped
            source = next(iter(self.sources.values()), None)
        elif len(parts) == 2 and parts[0] in self.sources:
            source = self.sources[parts[0]]
            rel = parts[1]
        else:
            return None
        if source is None:
            return None
        candidate = (source.path / rel).resolve()
        try:
            candidate.relative_to(source.path.resolve())
        except ValueError:
            return None
        return candidate


_NAME_RE = re.compile(r"^[a-z0-9-]+$")
_CONFIG_DIR = ".okf-wiki"
_CONFIG_FILE = "workspace.json"


def _config_path(root: pathlib.Path) -> pathlib.Path:
    return root / _CONFIG_DIR / _CONFIG_FILE


def _is_git_repo(path: pathlib.Path) -> bool:
    return (path / ".git").exists()


def _read_config(root: pathlib.Path) -> dict:
    return json.loads(_config_path(root).read_text())


def _write_config(root: pathlib.Path, data: dict) -> None:
    _config_path(root).write_text(json.dumps(data, indent=2))


def _build_workspace(root: pathlib.Path, data: dict, implicit: bool) -> Workspace:
    sources: dict[str, Source] = {}
    for entry in data.get("sources", []):
        name = entry["name"]
        origin = entry["origin"]
        if origin == "self":
            path = root
        elif origin == "link":
            path = pathlib.Path(entry["target"])
            if not path.is_dir():
                raise WorkspaceError(f"source '{name}': link target not found: {path}")
        else:  # clone
            path = root / _CONFIG_DIR / "sources" / name
        sources[name] = Source(name=name, path=path, origin=origin)
    return Workspace(root=root, language=data.get("language", "en"), implicit=implicit, sources=sources)


def load(root: pathlib.Path) -> Workspace:
    config = _config_path(root)
    if config.exists():
        data = _read_config(root)
        return _build_workspace(root, data, implicit=False)
    if _is_git_repo(root):
        sources = {"self": Source(name="self", path=root, origin="self")}
        return Workspace(root=root, language="en", implicit=True, sources=sources)
    raise WorkspaceError(f"no workspace.json and not a git repo: {root}")


def init(root: pathlib.Path, language: str = "en") -> Workspace:
    config = _config_path(root)
    if config.exists():
        raise WorkspaceError(f"workspace already exists: {config}")
    (root / _CONFIG_DIR).mkdir(parents=True, exist_ok=True)
    data: dict = {"version": 1, "language": language, "sources": []}
    _write_config(root, data)
    return _build_workspace(root, data, implicit=False)


def add_source(root: pathlib.Path, target: str, name: str | None = None) -> Source:
    config = _config_path(root)
    if not config.exists():
        raise WorkspaceError("workspace.json not found; run init first")
    data = _read_config(root)

    is_url = target.startswith(("http://", "https://", "git@", "git://", "file://"))

    if name is None:
        raw = target.rstrip("/").split("/")[-1]
        name = re.sub(r"\.git$", "", raw).lower()
        name = re.sub(r"[^a-z0-9-]", "-", name)

    if not _NAME_RE.match(name):
        raise WorkspaceError(f"invalid source name '{name}': must match [a-z0-9-]+")

    existing = {s["name"] for s in data["sources"]}
    if name in existing:
        raise WorkspaceError(f"source '{name}' already exists")

    if is_url:
        clone_dest = root / _CONFIG_DIR / "sources" / name
        clone_dest.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["git", "clone", target, str(clone_dest)],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            raise WorkspaceError(f"git clone failed: {result.stderr.strip()}")
        entry = {"name": name, "origin": "clone", "target": target}
        path = clone_dest
        origin = "clone"
    else:
        link_path = pathlib.Path(target).resolve()
        if not link_path.is_dir():
            raise WorkspaceError(f"target not found: {link_path}")
        if not _is_git_repo(link_path):
            raise WorkspaceError(f"target is not a git repo: {link_path}")
        entry = {"name": name, "origin": "link", "target": str(link_path)}
        path = link_path
        origin = "link"

    data["sources"].append(entry)
    _write_config(root, data)
    return Source(name=name, path=path, origin=origin)
