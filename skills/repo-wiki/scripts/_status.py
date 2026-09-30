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
STRUCTURE_CODES = ("coverage", "trigger-coverage", "link-coverage", "contract-claim", "scope", "not-covered", "page-path")
DERIVED_CODES = ("index", "log", "map")
RESEARCH_ROLES = ("glossary", "conventions", "system-conventions")  # stage 3: what every writer needs
ASSEMBLE_ROLES = ("architecture", "system-architecture", "overview")  # stage 5: written from the pages below


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
    canon = _page.canon(ws)
    canon_paths = set(canon)
    research_paths = {path for path, (role, _) in canon.items() if role in RESEARCH_ROLES}
    assemble_paths = {path for path, (role, _) in canon.items() if role in ASSEMBLE_ROLES}
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
    body_pages = [p for p in author if p.type in ("Module", "Workflow", "Flow")]
    canon_pages = [p for p in author if p.path in canon_paths]
    stubs = [p.path for p in body_pages if empty_brief(p)]
    empty_canon = [p.path for p in canon_pages if empty_brief(p)]
    open_triggers = [i for i in issues if i.code == "trigger-coverage"]
    untraced = bool(open_triggers) and not any(p.type in ("Workflow", "Flow") for p in body_pages)
    open_contracts = [i for i in issues if i.code == "link-coverage"]
    untraced_contracts = bool(open_contracts) and not any(p.type == "Flow" for p in body_pages)
    uncaptured = [db.name for db in ws.databases
                  if not any((p.meta.get("db") or {}).get("name") == db.name for p in pages if p.is_generated)]
    capture = (f"okf db tables, then okf db capture: databases {', '.join(uncaptured)} have no pages yet "
               "(references/extensions.md)")
    if canon_pages and (empty_canon or stubs or untraced or untraced_contracts):
        if not body_pages and len(empty_canon) == len(canon_pages):
            return done("discover", ["okf scan --json, then stage 1 (Discover)"] + ([capture] if uncaptured else []), [])
        actions = [capture] if uncaptured else []
        if empty_canon or stubs:
            missing = empty_canon + stubs
            shown = ", ".join(missing[:10]) + (" ..." if len(missing) > 10 else "")
            actions.append(f"stage 1 (Discover): write briefs into the todo blocks of {shown}")
        if untraced:
            actions.append(
                f"stage 1 (Discover): trace the {len(open_triggers)} trigger files no Workflow page "
                "claims (okf validate --json, code trigger-coverage) into Workflow stubs"
            )
        if untraced_contracts:
            actions.append(
                f"stage 1 (Discover): trace the {len(open_contracts)} contracts between sources no page "
                "claims (okf links --json; okf validate --json, code link-coverage) into Flow stubs"
            )
        focus = (open_triggers if untraced else []) + (open_contracts if untraced_contracts else [])
        return done("discover", actions, focus)

    structure = [i for i in errors if i.code in STRUCTURE_CODES]
    if structure:
        return done(
            "structure",
            [("stage 2 (Structure): fix the issues below; put each unclaimed trigger file in a "
              "Workflow page scope (trace it first) or a Not covered row with a reason, and claim each "
              "contract on a Flow page or architecture.md, or give it a Not covered row")],
            structure,
        )

    blocking = [i for i in blocking if i.code not in DERIVED_CODES]
    research_open = [i for i in blocking if i.page in research_paths]
    if research_open:
        names = sorted({i.page for i in research_open if i.page})
        return done("research", [f"finish canon pages (stage 3): {', '.join(names)}"], research_open)

    write_open = [i for i in blocking if i.page not in assemble_paths]
    if write_open:
        names = sorted({i.page for i in write_open if i.page})
        return done("write", [f"finish pages (stage 4): {', '.join(names)}"], write_open)

    assemble_open = [i for i in blocking if i.page in assemble_paths]
    if assemble_open:
        names = sorted({i.page for i in assemble_open if i.page})
        return done(
            "assemble",
            [f"assemble the overview and architecture pages from the pages below them (stage 5): {', '.join(names)}"],
            assemble_open,
        )

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

    derived = [i for i in issues if i.code in DERIVED_CODES]
    if derived:
        return done("done", ["okf stamp --by repo-wiki/<model> (rewrites the indexes, log.md and the System map)"], derived)
    changed = _git.changed(ws.root, ws.wiki_rel)
    if changed:
        return done("done", [f"review and commit the wiki ({len(changed)} changed files): git diff -- {shlex.quote(ws.wiki_rel)}"], [])
    return done("done", ["nothing to do: the wiki is committed and current"], [])


def _canon_fix(ws, pages, path: str) -> str:
    """The exact command or edit that restores one canon page."""
    role, source = _page.canon(ws)[path]
    type = _page.ROLE_TYPES[role]
    page = next((p for p in pages if p.path == path), None)
    if page is None:
        where = f" --source {shlex.quote(source)}" if source else ""
        return f"recreate the canon page: okf new --type {type}{where}"
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
