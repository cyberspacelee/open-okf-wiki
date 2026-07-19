"""Wiki validation, frontmatter, citations, and content digests."""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import stat
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, unquote_to_bytes, urlsplit

import yaml
from markdown_it import MarkdownIt
from mdit_py_plugins.anchors import anchors_plugin

from .config import _UniqueKeySafeLoader
from .models import WikiManifest, WikiRunLimits
from .security import MAX_ANALYZABLE_FILE_BYTES, canonical_source_path


_MARKDOWN = MarkdownIt("commonmark").use(anchors_plugin, min_level=1, max_level=6)
_CITATION_RE = re.compile(r"repo:(?P<path>[^#]+)#L(?P<start>[1-9]\d*)-L(?P<end>[1-9]\d*)")
_TEMPORARY_NAMES = {".DS_Store"}
_TEMPORARY_SUFFIXES = (".swp", ".swo", ".temp", ".tmp", "~")
# Reserved top-level directory for run-owned Wiki Visualization artifacts.
# Publication validation and refresh do not treat it as the semantic page set.
VISUALIZATION_DIR_NAME = "viz"


def validate_wiki(
    sources: Mapping[str, Path], root: Path, manifest: WikiManifest, limits: WikiRunLimits
) -> list[str]:
    """Mechanically validate a Staging or release Wiki tree against run invariants."""
    errors: list[str] = []
    actual_pages: set[str] = set()
    unreadable_pages: set[str] = set()
    entries = 0
    total_bytes = 0
    stack = [(root, PurePosixPath())]
    while stack:
        directory, prefix = stack.pop()
        for entry in os.scandir(directory):
            relative = prefix / entry.name
            relative_path = relative.as_posix()
            # Wiki Visualization artifacts are run-owned and outside the semantic page set.
            if not prefix.parts and entry.name == VISUALIZATION_DIR_NAME:
                continue
            entries += 1
            if entries > limits.wiki_entries_limit:
                return ["Staging Wiki exceeds the configured entry count limit"]
            if _is_temporary(entry.name):
                errors.append(f"Temporary artifact is not allowed: {relative_path}")
            if entry.is_symlink():
                errors.append(f"Symlink is not allowed: {relative_path}")
            elif entry.is_dir(follow_symlinks=False):
                stack.append((Path(entry.path), relative))
            elif not entry.is_file(follow_symlinks=False):
                errors.append(f"Unsupported output artifact: {relative_path}")
            else:
                try:
                    size = entry.stat(follow_symlinks=False).st_size
                except OSError as error:
                    errors.append(f"Unreadable output artifact {relative_path}: {error}")
                    continue
                if size > limits.wiki_file_bytes_limit:
                    errors.append(f"Wiki file exceeds the configured byte limit: {relative_path}")
                    unreadable_pages.add(relative_path)
                total_bytes += size
                if total_bytes > limits.wiki_total_bytes_limit:
                    return ["Staging Wiki exceeds the configured total byte limit"]
                if relative.suffix != ".md":
                    errors.append(f"Only Markdown pages are allowed: {relative_path}")
                else:
                    actual_pages.add(relative_path)

    declared_pages: set[str] = set()
    if len(manifest.pages) > limits.wiki_entries_limit:
        errors.append("Wiki Manifest exceeds the configured entry count limit")
    for page in manifest.pages:
        if not _is_canonical_page_path(page):
            errors.append(f"Wiki Manifest path is not canonical Markdown: {page!r}")
            continue
        if page in declared_pages:
            errors.append(f"Wiki Manifest contains duplicate page: {page}")
        declared_pages.add(page)

    for page in sorted(declared_pages - actual_pages):
        errors.append(f"Wiki Manifest declares missing page: {page}")
    for page in sorted(actual_pages - declared_pages):
        errors.append(f"Staging contains undeclared page: {page}")
    if "index.md" not in actual_pages:
        errors.append("Staging Wiki must contain index.md")

    headings: dict[str, set[str]] = {}
    links: list[tuple[str, str]] = []
    for page in sorted(actual_pages):
        if page in unreadable_pages:
            continue
        try:
            text = (root / page).read_text(encoding="utf-8")
        except UnicodeDecodeError:
            errors.append(f"Markdown page is not UTF-8: {page}")
            continue
        body, frontmatter_errors = _read_frontmatter(text, page)
        errors.extend(frontmatter_errors)
        if page == "index.md" and not body.strip():
            errors.append("index.md must have non-empty entry content")
        tokens = _MARKDOWN.parse(body)
        if any(
            token.type == "html_block"
            or any(child.type == "html_inline" for child in (token.children or []))
            for token in tokens
        ):
            errors.append(f"{page}: raw HTML is not allowed")
        headings[page] = {
            identifier
            for token in tokens
            if token.type == "heading_open"
            if isinstance((identifier := token.attrGet("id")), str)
        }
        links.extend(
            (page, target)
            for token in tokens
            for child in (token.children or [])
            if child.type == "link_open"
            if isinstance((target := child.attrGet("href")), str)
        )

    pages_with_valid_citations: set[str] = set()
    for page, target in links:
        if target.startswith("repo:"):
            citation_error = _validate_citation(sources, target)
            if citation_error:
                errors.append(f"{page}: {citation_error}")
            else:
                pages_with_valid_citations.add(page)
            continue
        parsed = urlsplit(target)
        if parsed.scheme:
            if parsed.scheme.lower() not in {"http", "https", "mailto"}:
                errors.append(f"{page}: unsupported link scheme: {target}")
            continue
        if parsed.netloc or parsed.query:
            errors.append(f"{page}: internal Wiki link must be a relative .md path: {target}")
            continue
        link_path = unquote(parsed.path)
        if not link_path and parsed.fragment:
            resolved = page
        elif not link_path or "\\" in link_path or not link_path.endswith(".md"):
            errors.append(f"{page}: internal Wiki link must be a relative .md path: {target}")
            continue
        else:
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(page), link_path))
        if resolved == ".." or resolved.startswith("../") or resolved.startswith("/"):
            errors.append(f"{page}: internal Wiki link escapes staging: {target}")
            continue
        if resolved not in actual_pages:
            errors.append(f"{page}: internal Wiki link target does not exist: {target}")
            continue
        if parsed.fragment and unquote(parsed.fragment) not in headings.get(resolved, set()):
            errors.append(f"{page}: internal Wiki link fragment does not exist: {target}")
    for page in sorted(actual_pages - pages_with_valid_citations):
        errors.append(f"{page}: at least one valid Source Citation is required")
    return errors


# Private alias kept for in-package call sites during the deepening transition.
_validate_wiki = validate_wiki


def _read_frontmatter(text: str, page: str) -> tuple[str, list[str]]:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        return text, [f"{page}: YAML frontmatter is required"]
    closing = next(
        (index for index, line in enumerate(lines[1:], 1) if line.rstrip("\r\n") == "---"),
        None,
    )
    if closing is None:
        return text, [f"{page}: YAML frontmatter is not closed"]
    try:
        metadata = yaml.load("".join(lines[1:closing]), Loader=_UniqueKeySafeLoader)
    except yaml.YAMLError as error:
        return "".join(lines[closing + 1 :]), [f"{page}: invalid YAML frontmatter: {error}"]
    errors = []
    if not isinstance(metadata, dict):
        errors.append(f"{page}: YAML frontmatter must be a mapping")
    elif not isinstance(metadata.get("title"), str) or not metadata["title"].strip():
        errors.append(f"{page}: YAML frontmatter title must be a non-empty string")
    return "".join(lines[closing + 1 :]), errors


def _validate_citation(sources: Mapping[str, Path], target: str) -> str | None:
    match = _CITATION_RE.fullmatch(target)
    if match is None:
        return f"malformed Source Citation: {target}"
    try:
        path = canonical_source_path(match.group("path"))
    except ValueError:
        return f"Source Citation path is not repository-relative POSIX: {target}"
    decoded_path = os.fsdecode(unquote_to_bytes(path))
    parts = PurePosixPath(decoded_path).parts
    if len(sources) == 1:
        source = next(iter(sources.values()))
    else:
        if len(parts) < 2 or parts[0] not in sources:
            return f"Source Citation must start with a repository ID: {target}"
        source = sources[parts[0]]
        parts = parts[1:]
    cited = source.joinpath(*parts)
    try:
        cited_stat = cited.stat(follow_symlinks=False)
    except OSError:
        return f"Source Citation path does not exist: {target}"
    if not stat.S_ISREG(cited_stat.st_mode):
        return f"Source Citation path is not a regular file: {target}"
    if cited_stat.st_size > MAX_ANALYZABLE_FILE_BYTES:
        return f"Source Citation path exceeds the static-analysis size limit: {target}"
    content = cited.read_bytes()
    if b"\0" in content:
        return f"Source Citation path is binary: {target}"
    try:
        line_count = len(content.decode("utf-8").splitlines())
    except UnicodeDecodeError:
        return f"Source Citation path is not UTF-8 text: {target}"
    start, end = int(match.group("start")), int(match.group("end"))
    if start > end or end > line_count:
        return f"Source Citation line range does not resolve: {target}"
    return None


def _is_canonical_page_path(path: str) -> bool:
    return _is_canonical_relative_path(path) and path.endswith(".md")


def _is_canonical_relative_path(path: str) -> bool:
    pure = PurePosixPath(path)
    return (
        bool(path)
        and "\\" not in path
        and not pure.is_absolute()
        and all(part not in {"", ".", ".."} for part in path.split("/"))
        and pure.as_posix() == path
    )


def _is_temporary(name: str) -> bool:
    return name in _TEMPORARY_NAMES or name.startswith(".#") or name.endswith(_TEMPORARY_SUFFIXES)


def page_hashes(root: Path, paths: list[str]) -> dict[str, str]:
    """SHA-256 digests for the listed relative paths under ``root``."""
    return {
        path: hashlib.sha256(root.joinpath(*PurePosixPath(path).parts).read_bytes()).hexdigest()
        for path in sorted(paths)
    }


# Private alias kept for in-package call sites during the deepening transition.
_hashes = page_hashes


def _tree_hashes(root: Path) -> dict[str, str]:
    return page_hashes(
        root,
        [path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()],
    )


def _content_digest(hashes: dict[str, str]) -> str:
    canonical = json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()


__all__ = [
    "VISUALIZATION_DIR_NAME",
    "page_hashes",
    "validate_wiki",
]
