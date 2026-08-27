import hashlib
import json
import os
import pathlib
import re
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from _files import atomic_json, directory_digest
from _frontmatter import parse_file

VERSION = 4


class PublishError(Exception):
    pass


def _publication(root: pathlib.Path) -> pathlib.Path:
    return root / ".okf-wiki" / "publication"


def _lock(root: pathlib.Path) -> int:
    path = _publication(root) / "publish.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR)
    try:
        if os.name == "nt":
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, b"0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (OSError, BlockingIOError) as exc:
        os.close(fd)
        raise PublishError(f"publication is locked: {path}") from exc


def _unlock(root: pathlib.Path, fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


def _content_pages(bundle: pathlib.Path) -> list[pathlib.Path]:
    return sorted(
        path for path in bundle.rglob("*.md") if path.name not in ("index.md", "log.md")
    )


def _description(path: pathlib.Path) -> tuple[str, str]:
    parsed = parse_file(path)
    title = parsed.meta.get("title") if not parsed.errors else None
    description = parsed.meta.get("description") if not parsed.errors else None
    return str(title or path.stem), str(description or "")


def generate_indexes(bundle: pathlib.Path, language: str) -> None:
    for stale in bundle.rglob("index.md"):
        stale.unlink()
    pages = _content_pages(bundle)
    directories = {pathlib.Path(".")}
    for page in pages:
        relative = page.relative_to(bundle)
        directories.update([relative.parent, *relative.parents])
    for directory in sorted(
        directories, key=lambda item: (len(item.parts), item.as_posix())
    ):
        actual = bundle if directory == pathlib.Path(".") else bundle / directory
        actual.mkdir(parents=True, exist_ok=True)
        child_dirs = sorted(
            {
                page.relative_to(actual).parts[0]
                for page in pages
                if page.is_relative_to(actual)
                and len(page.relative_to(actual).parts) > 1
            }
        )
        direct_pages = [page for page in pages if page.parent == actual]
        lines = []
        if directory == pathlib.Path("."):
            lines.extend(["---", 'okf_version: "0.2"', "---", ""])
        if child_dirs:
            lines.append("# 目录" if language == "zh" else "# Directories")
            lines.append("")
            for child in child_dirs:
                label = quote(child)
                href = (
                    f"/{(directory / child / 'index.md').as_posix()}"
                    if directory != pathlib.Path(".")
                    else f"/{label}/index.md"
                )
                lines.append(f"* [{child}/]({href})")
            lines.append("")
        if direct_pages:
            lines.append("# 概念" if language == "zh" else "# Concepts")
            lines.append("")
            for page in direct_pages:
                title, description = _description(page)
                rel = page.relative_to(bundle).as_posix()
                href = f"/{quote(rel, safe='/')}"
                suffix = f" - {description}" if description else ""
                lines.append(f"* [{title}]({href}){suffix}")
            lines.append("")
        if not child_dirs and not direct_pages:
            lines.extend(["# Wiki", ""])
        (actual / "index.md").write_text(
            "\n".join(lines).rstrip() + "\n", encoding="utf-8", newline="\n"
        )


def _page_hashes(bundle: pathlib.Path | None) -> dict[str, str]:
    if bundle is None or not bundle.exists():
        return {}
    return {
        path.relative_to(bundle).as_posix(): hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        for path in _content_pages(bundle)
    }


def generate_log(
    bundle: pathlib.Path, previous: pathlib.Path | None, run_id: str
) -> None:
    before = _page_hashes(previous)
    after = _page_hashes(bundle)
    created = sorted(after.keys() - before.keys())
    removed = sorted(before.keys() - after.keys())
    changed = sorted(
        path for path in before.keys() & after.keys() if before[path] != after[path]
    )
    old_log = (
        previous / "log.md" if previous and (previous / "log.md").exists() else None
    )
    prior = (
        old_log.read_text(encoding="utf-8").rstrip() if old_log else "# Wiki Update Log"
    )
    events = []
    for kind, paths in (
        ("Creation", created),
        ("Update", changed),
        ("Deprecation", removed),
    ):
        for path in paths:
            title = (
                _description(bundle / path)[0]
                if kind != "Deprecation"
                else pathlib.PurePosixPath(path).stem
            )
            events.append(
                f"* **{kind}**: [{title}](/{quote(path, safe='/')}) (`{run_id}`)."
            )
    if events:
        date = datetime.now(timezone.utc).date().isoformat()
        heading = f"## {date}"
        if prior.startswith("# Wiki Update Log"):
            existing = prior[len("# Wiki Update Log") :].lstrip()
            if existing.startswith(heading + "\n"):
                text = (
                    "# Wiki Update Log\n\n"
                    + heading
                    + "\n"
                    + "\n".join(events)
                    + "\n"
                    + existing[len(heading) + 1 :]
                )
            else:
                text = "# Wiki Update Log\n\n" + heading + "\n" + "\n".join(events)
            if existing and not existing.startswith(heading + "\n"):
                text += "\n\n" + existing
        else:
            text = "# Wiki Update Log\n\n" + heading + "\n" + "\n".join(events)
    else:
        text = prior
    (bundle / "log.md").write_text(text.rstrip() + "\n", encoding="utf-8", newline="\n")


def _page_manifest(root: pathlib.Path, candidate: pathlib.Path, state: dict) -> dict:
    import _state
    import _validate
    import _workspace

    workspace = _workspace.load(root)
    revisions = {item["name"]: item for item in state["revisions"]}
    result = {}
    for task in state["tasks"].values():
        if task["phase"] != "write":
            continue
        page = candidate / task["name"]
        parsed = parse_file(page)
        source_blobs = {}
        for source in parsed.meta.get("sources", []):
            resource = source.get("resource", "")
            item = _validate.parse_resource(resource)
            if item:
                source_name, rel, _, _ = item
                revision = revisions.get(source_name)
                registered = workspace.sources.get(source_name)
                blob = (
                    _workspace.git_blob_oid(registered, revision["commit"], rel)
                    if revision and registered
                    else None
                )
                if blob:
                    source_blobs[f"{source_name}/{rel}"] = blob
        result[task["name"]] = {
            "plan": task["spec"],
            "input_digest": _state.page_input_digest(candidate.parent, task["spec"]),
            "source_blobs": source_blobs,
        }
    return result


def current(root: pathlib.Path) -> dict | None:
    path = _publication(root) / "current.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        generation_name = data["generation"]
        if (
            data.get("version") != VERSION
            or not isinstance(generation_name, str)
            or not re.fullmatch(r"[0-9a-f]{64}", generation_name)
        ):
            raise ValueError("pointer fields are invalid")
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError) as exc:
        raise PublishError(f"invalid current publication pointer: {exc}") from exc
    generation = _publication(root) / "generations" / generation_name
    if generation.is_symlink() or not generation.is_dir():
        raise PublishError(f"current generation is missing: {generation}")
    return {**data, "path": str(generation)}


def _commit_generation(
    root: pathlib.Path, partial: pathlib.Path, manifest: dict, previous: dict | None
) -> tuple[pathlib.Path, dict]:
    publication = _publication(root)
    content_digest = directory_digest(partial, exclude_names={".okf-manifest.json"})
    manifest = {**manifest, "digest": content_digest}
    (partial / ".okf-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    generation = publication / "generations" / content_digest
    if generation.exists():
        shutil.rmtree(partial)
    else:
        os.replace(partial, generation)
    if previous:
        atomic_json(
            publication / "previous.json",
            {
                "version": VERSION,
                "generation": previous["generation"],
                "run_id": previous.get("run_id"),
            },
        )
    pointer = {
        "version": VERSION,
        "generation": content_digest,
        "run_id": manifest["run_id"],
    }
    atomic_json(publication / "current.json", pointer)
    return generation, pointer


def publish(root: pathlib.Path) -> dict:
    import _state
    import _validate

    state = _state.read(root)
    if state is None or state["status"] != "approved":
        raise PublishError("publication requires an approved run")
    _state.assert_revisions_current(root, state)
    candidate = _state.candidate_dir(root, state)
    if directory_digest(candidate) != state.get("approved_digest"):
        raise PublishError("candidate changed after approval")
    errors = [
        item
        for item in _validate.validate_candidate(root, state, published=True)
        if item["severity"] == "error"
    ]
    if errors:
        raise PublishError(f"candidate validation failed: {errors[:3]}")

    fd = _lock(root)
    partial = None
    try:
        publication = _publication(root)
        generations = publication / "generations"
        generations.mkdir(parents=True, exist_ok=True)
        partial = pathlib.Path(tempfile.mkdtemp(prefix=".partial-", dir=generations))
        shutil.copytree(candidate, partial, dirs_exist_ok=True)
        old = current(root)
        previous = pathlib.Path(old["path"]) if old else None
        generate_indexes(partial, state["language"])
        generate_log(partial, previous, state["run_id"])
        bundle_issues = _validate.validate_bundle(partial)
        bundle_errors = [item for item in bundle_issues if item["severity"] == "error"]
        if bundle_errors:
            raise PublishError(f"generated bundle is invalid: {bundle_errors[:3]}")
        manifest = {
            "version": VERSION,
            "okf_version": "0.2",
            "run_id": state["run_id"],
            "published_at": datetime.now(timezone.utc).isoformat(),
            "producer_run_id": state["run_id"],
            "revisions": state["revisions"],
            "catalogs": state["catalogs"],
            "pages": _page_manifest(root, candidate, state),
        }
        generation, pointer = _commit_generation(root, partial, manifest, old)
        partial = None
        result = {
            **pointer,
            "digest": pointer["generation"],
            "path": str(generation),
            "pages": len(_content_pages(generation)),
        }
        _state.mark_published(root, result)
        return result
    finally:
        if partial and partial.exists():
            shutil.rmtree(partial, ignore_errors=True)
        _unlock(root, fd)


def verify(root: pathlib.Path, actor: str, pages: list[str]) -> dict:
    """Record an explicit human verification as a new immutable generation."""
    import _validate
    import _workspace
    from _frontmatter import render

    if not actor.startswith("human:") or len(actor) == len("human:"):
        raise PublishError("verification actor must use human:<identity>")
    selected = current(root)
    if selected is None:
        raise PublishError("nothing has been published")
    workspace = _workspace.load(root)
    source = pathlib.Path(selected["path"])
    requested = sorted(set(pages))
    if not requested:
        raise PublishError("at least one page is required")

    fd = _lock(root)
    partial = None
    try:
        publication = _publication(root)
        generations = publication / "generations"
        partial = pathlib.Path(tempfile.mkdtemp(prefix=".partial-", dir=generations))
        shutil.copytree(source, partial, dirs_exist_ok=True)
        now = datetime.now(timezone.utc)
        for relative in requested:
            pure = pathlib.PurePosixPath(relative)
            if (
                pure.is_absolute()
                or ".." in pure.parts
                or pure.name in ("index.md", "log.md")
            ):
                raise PublishError(f"invalid concept page: {relative}")
            path = partial.joinpath(*pure.parts)
            if not path.is_file() or path.suffix != ".md":
                raise PublishError(f"concept page not found: {relative}")
            parsed = parse_file(path)
            if parsed.errors:
                raise PublishError(
                    f"invalid concept page {relative}: {parsed.errors[0]}"
                )
            verified = [
                item
                for item in parsed.meta.get("verified", [])
                if item.get("by") != actor
            ]
            verified.append({"by": actor, "at": now})
            parsed.meta["verified"] = verified
            parsed.meta["status"] = "stable"
            parsed.meta["stale_after"] = (
                now + timedelta(days=workspace.freshness_days)
            ).date()
            path.write_text(
                render(parsed.meta, parsed.body), encoding="utf-8", newline="\n"
            )

        run_id = f"verify-{now.strftime('%Y%m%dT%H%M%SZ')}"
        generate_indexes(partial, workspace.language)
        generate_log(partial, source, run_id)
        issues = _validate.validate_bundle(partial)
        errors = [item for item in issues if item["severity"] == "error"]
        if errors:
            raise PublishError(f"verified bundle is invalid: {errors[:3]}")
        old_manifest = json.loads(
            (source / ".okf-manifest.json").read_text(encoding="utf-8")
        )
        manifest = {
            **old_manifest,
            "run_id": run_id,
            "published_at": now.isoformat(),
            "verified_from": selected["generation"],
        }
        generation, pointer = _commit_generation(root, partial, manifest, selected)
        partial = None
        return {**pointer, "path": str(generation), "pages": requested, "actor": actor}
    finally:
        if partial and partial.exists():
            shutil.rmtree(partial, ignore_errors=True)
        _unlock(root, fd)


def rollback(root: pathlib.Path) -> dict:
    fd = _lock(root)
    try:
        return _rollback_locked(root)
    finally:
        _unlock(root, fd)


def _rollback_locked(root: pathlib.Path) -> dict:
    import _validate

    publication = _publication(root)
    previous = publication / "previous.json"
    if not previous.exists():
        raise PublishError("no previous generation")
    try:
        prior = json.loads(previous.read_text(encoding="utf-8"))
        if prior.get("version") != VERSION or not re.fullmatch(
            r"[0-9a-f]{64}", prior.get("generation", "")
        ):
            raise ValueError("pointer fields are invalid")
    except (
        AttributeError,
        TypeError,
        ValueError,
        OSError,
        json.JSONDecodeError,
    ) as exc:
        raise PublishError(f"invalid previous publication pointer: {exc}") from exc
    old = current(root)
    generation = publication / "generations" / prior["generation"]
    if not generation.is_dir():
        raise PublishError("previous generation is missing")
    errors = [
        item
        for item in _validate.validate_publication(root, generation)
        if item["severity"] == "error"
    ]
    if errors:
        raise PublishError(f"previous generation is invalid: {errors[:3]}")
    atomic_json(publication / "current.json", prior)
    if old:
        atomic_json(
            previous,
            {
                "version": VERSION,
                "generation": old["generation"],
                "run_id": old.get("run_id"),
            },
        )
    return {**prior, "path": str(generation)}


def export(root: pathlib.Path, target: pathlib.Path) -> dict:
    selected = current(root)
    if selected is None:
        raise PublishError("nothing has been published")
    source = pathlib.Path(selected["path"])
    target = target.resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as exc:
        raise PublishError("export target must be inside the workspace") from exc
    if target.exists() and not (target / ".okf-manifest.json").is_file():
        raise PublishError(f"refusing to replace unmanaged directory: {target}")
    staging = target.with_name(target.name + ".next")
    previous = target.with_name(target.name + ".previous")
    for stale in (staging, previous):
        if stale.exists():
            if not (stale / ".okf-manifest.json").is_file():
                raise PublishError(
                    f"refusing to remove unmanaged export artifact: {stale}"
                )
            shutil.rmtree(stale)
    shutil.copytree(source, staging)
    try:
        if target.exists():
            os.replace(target, previous)
        os.replace(staging, target)
    except BaseException:
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        if previous.exists():
            os.replace(previous, target)
        raise
    shutil.rmtree(previous, ignore_errors=True)
    return {
        "target": str(target),
        "generation": selected["generation"],
        "pages": len(_content_pages(target)),
    }
