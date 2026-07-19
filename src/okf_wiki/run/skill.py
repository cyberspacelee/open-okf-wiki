"""Producer skill validation, digest, and selection."""

from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath

import yaml

from .errors import RunValidationError
from .config import _UniqueKeySafeLoader
from .models import ProducerSkillVersion
from .mounts import _existing_directory
from .validation import _content_digest, _tree_hashes


_DEFAULT_PRODUCER_SKILL = Path(__file__).resolve().parents[1] / "producer_skill"
_DEFAULT_PRODUCER_SKILL_DIGEST = "18035cd3dd3c8eb50e15aff602e4f2bbdbd3a5ee27a9dcefaa6d8183381603a1"

_REQUIRED_PRODUCER_SKILL_PATHS = {
    "SKILL.md",
    "references/domain-research.md",
    "references/generate.md",
    "references/leaf-research.md",
    "references/refresh.md",
    "references/review.md",
    "templates/architecture.md",
    "templates/concept.md",
    "templates/flow.md",
    "templates/module.md",
    "templates/overview.md",
}
_SKILL_DIRECTORIES = {"references", "templates"}


def _validate_producer_skill(path: Path) -> tuple[Path, str]:
    root = _existing_directory(path, "Producer Skill")
    errors: list[str] = []
    contents: dict[str, bytes] = {}
    folded_paths: dict[str, str] = {}
    stack = [(root, PurePosixPath())]
    while stack:
        directory, prefix = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError as error:
            errors.append(f"unreadable directory {prefix.as_posix() or '.'}: {error}")
            continue
        for entry in entries:
            relative = prefix / entry.name
            relative_path = relative.as_posix()
            previous = folded_paths.setdefault(relative_path.casefold(), relative_path)
            if previous != relative_path:
                errors.append(f"ambiguous paths {previous!r} and {relative_path!r}")
            if entry.is_symlink():
                errors.append(f"symlink is not allowed: {relative_path}")
                continue
            if entry.is_dir(follow_symlinks=False):
                if len(relative.parts) != 1 or relative_path not in _SKILL_DIRECTORIES:
                    errors.append(f"unexpected directory: {relative_path}")
                else:
                    stack.append((Path(entry.path), relative))
                continue
            if not entry.is_file(follow_symlinks=False):
                errors.append(f"unsupported artifact: {relative_path}")
                continue
            if relative_path != "SKILL.md" and (
                len(relative.parts) != 2
                or relative.parts[0] not in _SKILL_DIRECTORIES
                or relative.suffix != ".md"
            ):
                errors.append(f"unexpected file: {relative_path}")
            file_path = Path(entry.path)
            try:
                mode = file_path.stat().st_mode
            except OSError as error:
                errors.append(f"unreadable file {relative_path}: {error}")
                continue
            if mode & 0o444 == 0:
                errors.append(f"unreadable file: {relative_path}")
                continue
            try:
                data = file_path.read_bytes()
            except OSError as error:
                errors.append(f"unreadable file {relative_path}: {error}")
                continue
            contents[relative_path] = data
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                errors.append(f"file is not UTF-8: {relative_path}")
                continue
            if not text.strip():
                errors.append(f"file is empty: {relative_path}")

    for missing in sorted(_REQUIRED_PRODUCER_SKILL_PATHS - contents.keys()):
        errors.append(f"missing required file: {missing}")
    if skill_bytes := contents.get("SKILL.md"):
        errors.extend(_validate_skill_frontmatter(skill_bytes))
    if errors:
        raise RunValidationError("Invalid Producer Skill bundle:\n- " + "\n- ".join(errors))
    return root, _content_digest(_tree_hashes(root))


def _validate_skill_frontmatter(data: bytes) -> list[str]:
    text = data.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        return ["SKILL.md must start with YAML frontmatter"]
    closing = next(
        (index for index, line in enumerate(lines[1:], 1) if line.rstrip("\r\n") == "---"),
        None,
    )
    if closing is None:
        return ["SKILL.md YAML frontmatter is not closed"]
    try:
        metadata = yaml.load("".join(lines[1:closing]), Loader=_UniqueKeySafeLoader)
    except yaml.YAMLError as error:
        return [f"SKILL.md has invalid YAML frontmatter: {error}"]
    errors: list[str] = []
    if not isinstance(metadata, dict) or set(metadata) != {"name", "description"}:
        errors.append("SKILL.md frontmatter must contain only name and description")
    else:
        name = metadata["name"]
        if not isinstance(name, str) or re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) is None:
            errors.append("SKILL.md name must use lowercase hyphen-case")
        description = metadata["description"]
        if not isinstance(description, str) or not description.strip():
            errors.append("SKILL.md description must be a non-empty string")
    if not "".join(lines[closing + 1 :]).strip():
        errors.append("SKILL.md instructions must not be empty")
    return errors


def _selected_producer_skill(version: ProducerSkillVersion) -> Path:
    path, digest = _validate_producer_skill(version.path)
    if digest != version.digest:
        raise RunValidationError(
            f"Selected Skill Version content changed: expected {version.digest}, found {digest}"
        )
    return path
