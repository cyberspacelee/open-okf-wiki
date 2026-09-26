"""Derive the current phase and next actions from the wiki directory and git."""

import shlex
from pathlib import Path

import _config
import _git
import _impact
import _page
import _review
import _validate

MAX_ISSUES = 20
STRUCTURE_CODES = ("coverage", "scope", "not-covered")


def status(root: Path, wiki: str | None = None) -> dict:
    try:
        ws = _config.load(root, wiki)
    except _config.NotInitialized:
        return _result("init", ["okf init [--wiki DIR] [--lang en|zh]"], None, root=root)
    except _config.ConfigError as exc:
        return _result("blocked", [f"fix the configuration: {exc}"], None, root=root)

    dirty = []
    for source in ws.sources:
        clean, files = _git.is_clean(source.path, [] if ws.hub else [ws.wiki_rel])
        if not clean:
            dirty += [source.prefix + f for f in files]
    if dirty:
        shown = ", ".join(dirty[:10]) + (" ..." if len(dirty) > 10 else "")
        return _result(
            "blocked",
            [f"ask the user to commit or stash these source changes: {shown}"],
            ws,
        )

    facts = _validate.Facts(ws)
    pages = _page.load_pages(ws)
    issues = _validate.validate(ws, pages, facts=facts)
    author = [p for p in pages if not p.is_generated and not p.error]
    drafts = _review.drafts(pages)
    canon_paths = set(_page.CANON.values())
    counts = {
        "pages": len(pages),
        "draft": len(drafts),
        "stable": sum(p.status == "stable" for p in pages),
        "todo": sum(bool(p.todos) for p in pages),
    } | _validate.counts(issues)

    def done(phase, actions, focus):
        # Every phase lists the issues its counts count; the phase's own issues first.
        first = set(map(id, focus))
        rest = [i for i in issues if id(i) not in first]
        return _result(phase, actions, ws, counts, _ordered(focus) + _ordered(rest), facts.head)

    # A missing, unparsable or mistyped canon page comes before update: update files
    # unmapped modules and deleted Not covered rows under architecture.md, so without
    # it update could not act and status would repeat "update" forever.
    broken = [i for i in issues if i.code == "canon-missing"]
    if broken:
        return done("research", [_canon_fix(ws, pages, i.page) for i in broken], broken)

    stale = [p.path for p in drafts if p.revision and not facts.page_current(p)]
    if stale:
        return done("update", ["okf update --json"], [])
    report = None
    if not drafts:
        report = _impact.impact(ws, facts, pages)
        to_draft, _ = _impact.plan(ws, report, pages)
        if to_draft:
            return done("update", ["okf update --json"], [])

    errors = [i for i in issues if i.severity == "error"]
    blocking = [i for i in issues if i.severity in ("error", "pending")]
    body_pages = [p for p in author if p.type in ("Module", "Workflow")]
    canon = [p for p in author if p.path in canon_paths]
    stubs = [p.path for p in body_pages if empty_brief(p)]
    if canon and all(empty_brief(p) for p in canon) and (not body_pages or stubs):
        if not body_pages:
            return done("discover", ["okf scan --json, then stage 1 (Discover)"], [])
        shown = ", ".join(stubs[:10]) + (" ..." if len(stubs) > 10 else "")
        return done(
            "discover",
            [f"stage 1 (Discover): write briefs into the todo blocks of the canon pages and of {shown}"],
            [],
        )

    structure = [i for i in errors if i.code in STRUCTURE_CODES]
    if structure:
        return done("structure", ["fix the coverage and scope issues below (stage 2)"], structure)

    canon_open = [i for i in blocking if i.page in canon_paths or i.code in ("canon-missing", "canon-table")]
    if canon_open:
        names = sorted({i.page for i in canon_open if i.page})
        return done("research", [f"finish canon pages (stage 3): {', '.join(names)}"], canon_open)

    other_open = [i for i in blocking if i.code != "index"]
    if other_open:
        names = sorted({i.page for i in other_open if i.page})
        return done("write", [f"finish pages (stage 4): {', '.join(names)}"], other_open)

    if drafts:
        review_state, report = _review.state(ws, pages)
        if review_state == "approved":
            return done("stamp", ["okf stamp --by repo-wiki/<model>"], [])
        reviewer = "okf review prepare --json, then dispatch a fresh reviewer with references/review.md"
        actions = {
            "missing": [reviewer],
            "stale": [f"pages changed since the last review; {reviewer}"],
            "invalid": [f"{_review.REVIEW_FILE} is invalid ({'; '.join(_review.load(ws)[1][:3])}); {reviewer}"],
            "changes_requested": [
                (f"repair the {len(report['issues']) if report else 0} issues in "
                 f"{ws.wiki_rel}/{_review.REVIEW_FILE}, then {reviewer}")
            ],
        }[review_state]
        if _review.open_changes(ws) is None:
            # A report that requested changes is never skipped with --unreviewed.
            actions.append("without an independent reviewer: okf stamp --unreviewed --by repo-wiki/<model>")
        return done("review", actions, [])

    index = [i for i in issues if i.code == "index"]
    if index:
        return done("done", ["okf stamp --by repo-wiki/<model> (rewrites index.md)"], index)
    changed = _git.changed(ws.root, ws.wiki_rel)
    if changed:
        return done("done", [f"review and commit the wiki ({len(changed)} changed files): git diff -- {shlex.quote(ws.wiki_rel)}"], [])
    return done("done", ["nothing to do: the wiki is committed and current"], [])


def _canon_fix(ws, pages, path: str) -> str:
    """The exact command or edit that restores one canon page."""
    type = next(t for t, p in _page.CANON.items() if p == path)
    page = next((p for p in pages if p.path == path), None)
    if page is None:
        title, description = _page.canon_text(ws.lang, type)
        return (f"recreate the canon page: okf new {shlex.quote(path)} --type {type} "
                f"--title {shlex.quote(title)} --description {shlex.quote(description)}")
    if page.error:
        return f"fix the frontmatter of {ws.wiki_rel}/{path} by hand ({page.error})"
    return f"set type: {type} in {ws.wiki_rel}/{path}; {path} is reserved for the {type} page"


def empty_brief(page) -> bool:
    """A page whose todo blocks are all still the template's empty block."""
    return bool(page.todos) and all(not text.strip() for _, text in page.todos)


def _ordered(issues):
    return sorted(issues, key=lambda i: (_validate.SEVERITY_ORDER[i.severity], i.page or "", i.line or 0, i.code))


def _result(phase, actions, ws, counts=None, issues=(), head=None, root=None) -> dict:
    ordered = list(issues)
    return {
        "phase": phase,
        "next_actions": actions,
        "root": str(ws.root if ws else root) if (ws or root) else None,
        "wiki": ws.wiki_rel if ws else None,
        "head": head or {},
        "counts": counts or {},
        "issues": [i.to_dict() for i in ordered[:MAX_ISSUES]],
        "issues_truncated": max(0, len(ordered) - MAX_ISSUES),
    }
