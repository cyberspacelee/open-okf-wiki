import hashlib
import pathlib
import shutil


class PublishError(Exception): ...


def _candidate(root: pathlib.Path) -> pathlib.Path:
    return root / ".okf-wiki" / "candidate"


def _wiki(root: pathlib.Path) -> pathlib.Path:
    return root / "wiki"


def _previous(root: pathlib.Path) -> pathlib.Path:
    return root / ".okf-wiki" / "publication" / "previous"


def _safe(root: pathlib.Path, path: pathlib.Path) -> None:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        raise PublishError(f"path escapes root: {path}")


def generate_index(root: pathlib.Path) -> pathlib.Path:
    import _frontmatter  # noqa: PLC0415

    candidate = _candidate(root)
    _safe(root, candidate)
    mds = sorted(p for p in candidate.rglob("*.md") if p.name != "index.md")
    if not mds:
        raise PublishError("candidate is empty")

    lines: list[str] = []
    current_dir: pathlib.Path | None = None
    for p in mds:
        rel = p.relative_to(candidate)
        parent = rel.parent
        if parent != pathlib.Path(".") and parent != current_dir:
            current_dir = parent
            lines.append(f"\n### {parent}\n")
        elif parent == pathlib.Path(".") and current_dir is not None:
            current_dir = None
        parsed = _frontmatter.parse_file(p)
        title = parsed.meta.get("title") or p.stem
        desc = parsed.meta.get("description", "")
        entry = f"- [{title}]({rel.as_posix()})"
        if desc:
            entry += f" — {desc}"
        lines.append(entry)

    index_path = candidate / "index.md"
    index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return index_path


def digest(root: pathlib.Path) -> str:
    candidate = _candidate(root)
    _safe(root, candidate)
    h = hashlib.sha256()
    for p in sorted(candidate.rglob("*")):
        if p.is_file():
            rel = p.relative_to(candidate).as_posix()
            h.update(rel.encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def publish(root: pathlib.Path) -> dict:
    import _validate  # noqa: PLC0415

    generate_index(root)

    import _workspace  # noqa: PLC0415
    workspace = _workspace.load(root)
    issues = _validate.validate_candidate(workspace)
    errors = [i for i in issues if i.get("severity") == "error"]
    if errors:
        sample = "; ".join(str(e) for e in errors[:3])
        raise PublishError(f"validation errors: {sample}")

    d = digest(root)
    candidate = _candidate(root)
    wiki = _wiki(root)
    prev = _previous(root)
    _safe(root, candidate)
    _safe(root, wiki)
    _safe(root, prev)

    had_previous = prev.exists()
    had_wiki = wiki.exists()

    # remove stale previous
    if prev.exists():
        shutil.rmtree(prev)

    prev.parent.mkdir(parents=True, exist_ok=True)

    # move current wiki → previous
    if wiki.exists():
        shutil.move(str(wiki), str(prev))

    try:
        shutil.copytree(str(candidate), str(wiki))
    except Exception as exc:
        # rollback: restore wiki from previous
        try:
            if wiki.exists():
                shutil.rmtree(wiki)
            if prev.exists():
                shutil.move(str(prev), str(wiki))
        except Exception:
            pass
        raise PublishError(f"copy failed, rolled back: {exc}") from exc

    pages = sum(1 for _ in wiki.rglob("*.md"))
    return {"digest": d, "pages": pages, "previous": had_wiki}


def rollback(root: pathlib.Path) -> None:
    wiki = _wiki(root)
    prev = _previous(root)
    _safe(root, wiki)
    _safe(root, prev)
    if not prev.exists():
        raise PublishError("no previous publication to roll back to")
    if wiki.exists():
        shutil.rmtree(wiki)
    shutil.move(str(prev), str(wiki))
