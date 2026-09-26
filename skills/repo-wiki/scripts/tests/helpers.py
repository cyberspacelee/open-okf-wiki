"""Shared test fixtures: real temporary git repositories, never mocks."""

import subprocess
from pathlib import Path

import _config
import _frontmatter


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def _put(repo: Path, files: dict[str, str | None]) -> None:
    for rel, text in files.items():
        target = repo / rel
        if text is None:
            target.unlink()
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")


def git_repo(path: Path, files: dict[str, str], message: str = "init") -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.name", "Test")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "commit.gpgsign", "false")
    commit(path, files, message)
    return path


def commit(repo: Path, files: dict[str, str | None], message: str = "change") -> str:
    _put(repo, files)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "--allow-empty", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


def wiki_ws(repo: Path, lang: str = "en") -> _config.Workspace:
    ws = _config.init(repo, lang=lang, create_canon=False)
    commit(repo, {}, "wiki")
    return ws


def write(page_file: Path, meta: dict, body: str) -> None:
    page_file.parent.mkdir(parents=True, exist_ok=True)
    page_file.write_text(_frontmatter.render(meta, body), encoding="utf-8", newline="\n")
