#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Tier-2 citation support rate: blind judge packets, scoring and calibration.

The judge is an agent or subagent run by the host; this script never calls a
model. Workflow:

    eval_citations.py sample --out DIR [--wiki W] [--per-page 3] [--seed 0]
        -> DIR/judge/packets.jsonl    one blind packet per claim: id, claim, cited lines
           DIR/judge/judge_prompt.md  exact judge instructions and verdict schema
           DIR/claims.jsonl           the answer key: page, kind, line, locators, revision
           DIR/manifest.json          counts and sampling parameters
    (host) give the judge only DIR/judge/: it reads judge_prompt.md +
           packets.jsonl and writes DIR/judge/verdicts.jsonl; the answer key and
           manifest (which name pages) stay outside the directory it sees
    eval_citations.py score --out DIR [--min-support 0.9] [--json]
    eval_citations.py calibrate --out DIR [--n 20]    -> DIR/calibration.md
    (human) fills "Human verdict:" lines in calibration.md
    eval_citations.py agreement --out DIR [--json]    percent agreement, Cohen's kappa
    eval_citations.py selftest

A claim is every canon table row (glossary, commands, rules, invariants,
change_impact) plus every prose sentence that carries a footnote: all causal
sentences, and up to --per-page other sentences per page, drawn with --seed.
Cited lines are read from git at the page's revision (per source in a hub).
Claim ids hash page, first footnote label and the claim text, so they are
stable across runs and line moves but reveal nothing about the page.
"""

import argparse
import contextlib
import hashlib
import io
import json
import random
import re
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import _config
import _files
import _git
import _page
import _validate

VERDICTS = ("supported", "partial", "unsupported", "invented-why")
MAX_LINES = 80
# Blindness is structural: the judge is given only JUDGE_DIR (packets, prompt,
# and its own verdicts); the answer key and manifest name pages and stay outside.
JUDGE_DIR = "judge"
PACKETS = f"{JUDGE_DIR}/packets.jsonl"
PROMPT = f"{JUDGE_DIR}/judge_prompt.md"
VERDICT_FILE = f"{JUDGE_DIR}/verdicts.jsonl"
CLAIMS = "claims.jsonl"
MANIFEST = "manifest.json"
SHEET = "calibration.md"

_CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
_REF = re.compile(r"\[\^([^\]\s]+)\]")
# Sentence end: ASCII terminator (plus trailing footnote refs) before a space and a
# non-lowercase character or the end; CJK terminators need no space.
_SENTENCE_END = re.compile(
    r"[.!?](?:\[\^[^\]\s]+\])*(?=\s+[^a-z\s]|\s*$)|[。！？](?:\[\^[^\]\s]+\])*"
)
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_QUOTE = re.compile(r"^\s*>\s?")


class EvalError(Exception):
    """User-facing; the message names the fix."""


# --- claims ---------------------------------------------------------------------


@dataclass
class Claim:
    id: str
    page: str
    kind: str  # a cited canon table kind or "prose"
    line: int  # file line of the row or of the sentence's first footnote reference
    labels: list[str]
    text: str
    causal: bool
    pool: str  # "canon" (exhaustive), "causal" (exhaustive) or "prose" (sampled)
    locators: list[str] = field(default_factory=list)
    evidence: list[dict] = field(default_factory=list)
    revision: dict = field(default_factory=dict)


def _mask(text: str) -> str:
    """Same length as ``text`` with code spans blanked, so positions still line up."""
    return _CODE_SPAN.sub(lambda m: "\0" * len(m.group(0)), text)


def strip_refs(text: str) -> str:
    """Remove footnote references outside code spans and collapse whitespace."""
    masked = _mask(text)
    out, last = [], 0
    for m in _REF.finditer(masked):
        out.append(text[last : m.start()])
        last = m.end()
    out.append(text[last:])
    return " ".join("".join(out).split())


def is_causal(text: str) -> bool:
    plain = _CODE_SPAN.sub("", text)
    return bool(_validate._CAUSAL.search(plain)) and not _validate._NO_RATIONALE.search(plain)


# Cells that record project choices or session state, not facts the cited lines can back.
_UNJUDGED_CELLS = {"glossary": {2}, "commands": {2}}  # Avoid, Status


def _row_text(kind: str | None, header: list[str], cells: list[str]) -> str:
    parts = []
    skip = _UNJUDGED_CELLS.get(kind, set())
    for index, (name, cell) in enumerate(zip(header, cells)):
        if index in skip:
            continue
        value = strip_refs(cell)
        if value:
            parts.append(f"{name.strip()}: {value}")
    return "; ".join(parts)


def _paragraphs(page: _page.Page) -> list[list[tuple[int, str]]]:
    """Consecutive prose lines joined into paragraphs; a list item starts a new one."""
    lines = page.structure.lines
    paragraphs: list[list[tuple[int, str]]] = []
    previous = -1
    for number, _ in page.structure.prose:
        raw = lines[number - 1]
        if number != previous + 1 or _LIST_ITEM.match(raw) or not paragraphs:
            paragraphs.append([])
        paragraphs[-1].append((number, raw))
        previous = number
    return paragraphs


def _sentences(paragraph: list[tuple[int, str]]) -> list[tuple[str, list[str], int]]:
    """(sentence text, footnote labels, body line of the first label) per cited sentence."""
    parts, starts = [], []
    offset = 0
    for index, (number, raw) in enumerate(paragraph):
        text = raw.strip()
        if index == 0:
            text = _LIST_ITEM.sub("", text)
        text = _QUOTE.sub("", text)
        starts.append((offset, number))
        parts.append(text)
        offset += len(text) + 1
    joined = " ".join(parts)
    masked = _mask(joined)

    def line_at(pos: int) -> int:
        found = starts[0][1]
        for start, number in starts:
            if start <= pos:
                found = number
        return found

    bounds, start = [], 0
    for m in _SENTENCE_END.finditer(masked):
        bounds.append((start, m.end()))
        start = m.end()
    if start < len(joined):
        bounds.append((start, len(joined)))
    found = []
    for a, b in bounds:
        refs = list(_REF.finditer(masked, a, b))
        if not refs:
            continue
        labels = list(dict.fromkeys(m.group(1) for m in refs))
        text = strip_refs(joined[a:b])
        if text:
            found.append((text, labels, line_at(refs[0].start())))
    return found


def _claim_id(page: str, kind: str, label: str, text: str) -> str:
    key = "\0".join((page, kind, label, " ".join(text.casefold().split())))
    return "c-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def page_claims(page: _page.Page) -> list[Claim]:
    """Every cited claim of one page, before sampling and evidence resolution."""
    claims: list[Claim] = []
    offset = page.body_offset
    refs: dict[int, list[str]] = {}
    for label, line in page.structure.footnote_refs:
        refs.setdefault(line, [])
        if label not in refs[line]:
            refs[line].append(label)

    def add(kind, line, labels, text, pool):
        causal = is_causal(text)
        if pool == "prose" and causal:
            pool = "causal"
        claims.append(Claim("", page.path, kind, line + offset, labels, text, causal, pool))

    for table in page.structure.tables:
        kind = _page.table_kind(table.header)
        if kind == "not_covered":
            continue
        for row in table.rows:
            labels = refs.get(row.line, [])
            text = _row_text(kind, table.header, row.cells)
            if kind in _page.CITED_KINDS:
                add(kind, row.line, labels, text, "canon")
            elif labels and text:
                add("prose", row.line, labels, text, "prose")
    for paragraph in _paragraphs(page):
        for text, labels, line in _sentences(paragraph):
            add("prose", line, labels, text, "prose")

    seen: Counter = Counter()
    for claim in claims:
        base = _claim_id(page.path, claim.kind, claim.labels[0] if claim.labels else "-", claim.text)
        seen[base] += 1
        claim.id = base if seen[base] == 1 else f"{base}-{seen[base]}"
    return claims


def select(claims: list[Claim], per_page: int, seed: int) -> list[Claim]:
    """Canon rows and causal sentences always; other prose sampled per page."""
    kept = [c for c in claims if c.pool != "prose"]
    by_page: dict[str, list[Claim]] = {}
    for claim in claims:
        if claim.pool == "prose":
            by_page.setdefault(claim.page, []).append(claim)
    for page, pool in by_page.items():
        pool = sorted(pool, key=lambda c: c.id)
        if per_page < 0 or len(pool) <= per_page:
            kept += pool
        else:
            kept += random.Random(f"{seed}\0{page}").sample(pool, per_page)
    return sorted(kept, key=lambda c: (c.page, c.line, c.id))


# --- evidence -------------------------------------------------------------------


def _number(lines: list[str], first: int) -> str:
    width = len(str(first + len(lines) - 1))
    return "\n".join(f"{first + i:>{width}} | {line}" for i, line in enumerate(lines))


class Evidence:
    """Reads cited lines at a page's revision, one BlobReader per source."""

    def __init__(self, ws: _config.Workspace, stack: contextlib.ExitStack, max_lines: int):
        self.ws = ws
        self.max_lines = max_lines
        self.readers = {s.name: stack.enter_context(_git.BlobReader(s.path)) for s in ws.sources}
        self.head = {s.name: _git.head(s.path) for s in ws.sources}
        self._revs: dict[tuple[str, object], tuple[str, bool]] = {}

    def revision(self, source: _config.Source, rev) -> tuple[str, bool]:
        """(commit to read, True when the page revision was unusable and HEAD is used)."""
        key = (source.name, rev)
        if key not in self._revs:
            ok = (
                isinstance(rev, str)
                and _validate.HEX40.fullmatch(rev) is not None
                and _git.rev_exists(source.path, rev)
            )
            self._revs[key] = (rev, False) if ok else (self.head[source.name], True)
        return self._revs[key]

    def read(self, page: _page.Page, label: str, locator_text: str) -> dict:
        item: dict = {"label": label, "locator": locator_text}
        try:
            locator = _config.parse_locator(locator_text)
            source, rel = _config.resolve(self.ws, locator.path)
        except _config.LocatorError as exc:
            return item | {"error": str(exc)}
        if _config.is_forbidden(locator.path):
            return item | {"error": "secret file; content not shown"}
        rev, fallback = self.revision(source, page.revision.get(source.name))
        item["source"] = source.name
        item["rev"] = rev
        if fallback:
            item["rev_note"] = "page revision missing or unknown; read at HEAD"
        data = self.readers[source.name].read(rev, rel)
        if data is None:
            return item | {"error": f"not a tracked file at {rev[:12]}"}
        if b"\0" in data[:8192]:
            return item | {"error": "binary file"}
        lines = _files.text_lines(data)  # git's line count, as validate uses
        start = locator.start or 1
        end = locator.end if locator.end is not None else len(lines)
        notes = []
        if end > len(lines):
            notes.append(f"range ends past the file ({len(lines)} lines)")
            end = len(lines)
        if start > end:
            return item | {"error": f"range starts past the end of the file ({len(lines)} lines)"}
        shown_end = min(end, start + self.max_lines - 1)
        if shown_end < end:
            notes.append(f"truncated: showing L{start}-L{shown_end} of L{start}-L{end}")
        item |= {"start": start, "end": shown_end, "text": _number(lines[start - 1 : shown_end], start)}
        if notes:
            item["note"] = "; ".join(notes)
        return item


def attach_evidence(ws: _config.Workspace, pages: dict[str, _page.Page], claims: list[Claim], max_lines: int) -> None:
    with contextlib.ExitStack() as stack:
        evidence = Evidence(ws, stack, max_lines)
        for claim in claims:
            page = pages[claim.page]
            defs = page.structure.footnote_defs
            claim.revision = {s.name: page.revision.get(s.name) for s in ws.sources}
            for label in claim.labels:
                if label not in defs:
                    claim.evidence.append({"label": label, "error": "footnote has no definition"})
                    continue
                token, _ = _config.definition_locator(defs[label][0])
                if not token:
                    claim.evidence.append({"label": label, "error": "footnote definition has no locator"})
                    continue
                if token in claim.locators:
                    continue
                claim.locators.append(token)
                claim.evidence.append(evidence.read(page, label, token))


def packet(claim: Claim) -> dict:
    """The blind judge input: no page, title, kind label or other claims."""
    cited = []
    for item in claim.evidence:
        entry = {"locator": item.get("locator", f"[^{item['label']}]")}
        if "text" in item:
            entry["lines"] = item["text"]
        if item.get("note"):
            entry["note"] = item["note"]
        if item.get("error"):
            entry["error"] = item["error"]
        cited.append(entry)
    return {"id": claim.id, "claim": claim.text, "cited": cited}


# --- io -----------------------------------------------------------------------------


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> tuple[list[dict], list[dict]]:
    """(rows, problems); tolerates blank lines and markdown code fence lines."""
    if not path.is_file():
        raise EvalError(f"{path} not found; write it first (see judge_prompt.md)")
    rows, problems = [], []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("```"):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            problems.append({"line": number, "error": f"not JSON: {exc.msg}"})
            continue
        if not isinstance(row, dict):
            problems.append({"line": number, "error": "not a JSON object"})
            continue
        rows.append(row | {"_line": number})
    return rows, problems


def normalize_verdict(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip().lower().replace("_", "-").replace(" ", "-")
    return value if value in VERDICTS else None


def workspace(root: str, wiki: str | None) -> _config.Workspace:
    try:
        return _config.load(Path(root), wiki)
    except _config.ConfigError as exc:
        raise EvalError(str(exc)) from None


# --- sample ---------------------------------------------------------------------------

JUDGE_PROMPT = """# Citation support judge

You judge whether source lines support claims taken from a repository wiki.
Each line of `packets.jsonl` is one claim:

```json
{"id": "c-...", "claim": "...", "cited": [{"locator": "path#L3-L9", "lines": "3 | ...", "note": "...", "error": "..."}]}
```

Rules:

1. Judge each claim alone, using only its `cited` lines. Do not open other files,
   use other packets, or rely on what you know about the project or similar code.
2. A table row arrives as `Column: value; Column: value`. Judge the facts it
   states: a glossary row's meaning and where it is defined, a command and where
   it is defined, a rule and its enforcement, an invariant with where it is
   enforced and what breaks, a change and what must change with it.
3. Identifiers in backticks must appear in, or be clearly defined by, the
   cited lines to count as supported.
4. A `note` saying `truncated` means only part of the cited range is shown;
   judge on what is shown. An `error` means nothing could be shown for that
   citation.
5. Choose exactly one verdict:
   - `supported`: every fact in the claim is stated by or directly follows from
     the cited lines.
   - `partial`: the main fact is backed, but some detail (a number, a name, a
     scope, a second fact) is missing from or contradicted by the cited lines.
   - `unsupported`: the cited lines do not back the claim, contradict it, or
     nothing is shown.
   - `invented-why`: the claim gives a reason or purpose ("because", "so that",
     "to avoid", "in order to", 因为, 为了, 以免) and the cited lines do not
     state that reason, even if the rest of the claim is backed. A reason is
     stated when code comments, docs, messages or names in the cited lines say
     it; a plausible guess does not count. A claim that says "rationale not
     recorded" is not a reason.
6. `note`: one short sentence naming what is missing or wrong; empty when
   supported.

Output: write `verdicts.jsonl` next to `packets.jsonl`, one JSON object per
packet and per line, in any order, nothing else in the file:

```json
{"id": "c-...", "verdict": "supported|partial|unsupported|invented-why", "note": "..."}
```

Use each packet id exactly once and do not invent ids. There are {count} packets.
"""


def cmd_sample(args) -> int:
    ws = workspace(args.root, args.wiki)
    pages = {p.path: p for p in _page.load_pages(ws) if not p.error and not p.is_generated}
    every = [claim for page in pages.values() for claim in page_claims(page)]
    chosen = select(every, args.per_page, args.seed)
    attach_evidence(ws, pages, chosen, args.max_lines)
    out = Path(args.out)
    write_jsonl(out / PACKETS, [packet(c) for c in chosen])
    write_jsonl(out / CLAIMS, [asdict(c) for c in chosen])
    (out / PROMPT).parent.mkdir(parents=True, exist_ok=True)
    (out / PROMPT).write_text(JUDGE_PROMPT.replace("{count}", str(len(chosen))), encoding="utf-8", newline="\n")
    total = Counter(c.pool for c in every)
    kept = Counter(c.pool for c in chosen)
    manifest = {
        "wiki": ws.wiki_rel,
        "hub": ws.hub,
        "seed": args.seed,
        "per_page": args.per_page,
        "max_lines": args.max_lines,
        "claims": len(chosen),
        "pool_total": dict(sorted(total.items())),
        "pool_sampled": dict(sorted(kept.items())),
        "by_kind": dict(sorted(Counter(c.kind for c in chosen).items())),
        "by_page": dict(sorted(Counter(c.page for c in chosen).items())),
        "uncited": sorted(c.id for c in chosen if not c.labels),
        "evidence_errors": sum(1 for c in chosen for e in c.evidence if e.get("error")),
        "files": {"packets": PACKETS, "claims": CLAIMS, "prompt": PROMPT, "verdicts": VERDICT_FILE},
    }
    (out / MANIFEST).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    if args.json:
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
    else:
        print(f"{len(chosen)} claims from {len(manifest['by_page'])} pages -> {out / PACKETS}")
        for pool in ("canon", "causal", "prose"):
            print(f"  {pool:<7} {kept.get(pool, 0)}/{total.get(pool, 0)}")
        if manifest["evidence_errors"]:
            print(f"  {manifest['evidence_errors']} citation(s) could not be resolved; see {CLAIMS}")
        print(f"next: give a judge only {out / JUDGE_DIR}; it follows {PROMPT.split('/')[-1]} "
              f"and writes {out / VERDICT_FILE}")
    return 0


# --- score ----------------------------------------------------------------------------


def load_claims(out: Path) -> dict[str, dict]:
    rows, problems = read_jsonl(out / CLAIMS)
    if problems:
        raise EvalError(f"{out / CLAIMS} is damaged ({problems[0]}); rerun sample")
    return {row["id"]: row for row in rows}


def load_verdicts(path: Path, known: set[str]) -> dict:
    rows, invalid = read_jsonl(path)
    verdicts: dict[str, dict] = {}
    unknown, duplicates = [], []
    for row in rows:
        cid = row.get("id")
        verdict = normalize_verdict(row.get("verdict"))
        if not isinstance(cid, str):
            invalid.append({"line": row["_line"], "error": "missing id"})
        elif verdict is None:
            invalid.append({"line": row["_line"], "id": cid, "error": f"verdict {row.get('verdict')!r} is not one of {', '.join(VERDICTS)}"})
        elif cid not in known:
            unknown.append(cid)
        elif cid in verdicts:
            duplicates.append(cid)
        else:
            verdicts[cid] = {"verdict": verdict, "note": str(row.get("note") or "")}
    missing = sorted(known - set(verdicts) - {i.get("id") for i in invalid})
    return {"verdicts": verdicts, "unknown": sorted(set(unknown)), "duplicates": sorted(set(duplicates)), "invalid": invalid, "missing": missing}


def rates(verdicts: list[str]) -> dict:
    counts = Counter(verdicts)
    judged = len(verdicts)
    result = {v: counts.get(v, 0) for v in VERDICTS} | {"judged": judged}
    if judged:
        result["support_rate"] = round(counts["supported"] / judged, 4)
        result["weighted_support"] = round((counts["supported"] + 0.5 * counts["partial"]) / judged, 4)
    else:
        result["support_rate"] = result["weighted_support"] = None
    return result


def score(out: Path, verdict_path: Path, min_support: float | None) -> dict:
    claims = load_claims(out)
    loaded = load_verdicts(verdict_path, set(claims))
    verdicts = loaded["verdicts"]
    judged = [(claims[cid], v) for cid, v in verdicts.items()]
    groups: dict[str, dict[str, list[str]]] = {"kind": {}, "page": {}, "pool": {}}
    for claim, v in judged:
        for key, group in groups.items():
            group.setdefault(claim[key], []).append(v["verdict"])
    failures = [
        {
            "id": claim["id"], "page": claim["page"], "line": claim["line"], "kind": claim["kind"],
            "verdict": v["verdict"], "note": v["note"], "claim": claim["text"], "locators": claim["locators"],
        }
        for claim, v in sorted(judged, key=lambda item: (item[0]["page"], item[0]["line"]))
        if v["verdict"] in ("unsupported", "invented-why")
    ]
    overall = rates([v["verdict"] for v in verdicts.values()])
    complete = not (loaded["missing"] or loaded["unknown"] or loaded["duplicates"] or loaded["invalid"])
    passed = complete and (
        min_support is None or (overall["support_rate"] is not None and overall["support_rate"] >= min_support)
    )
    return {
        "claims": len(claims),
        "overall": overall,
        "by_kind": {k: rates(v) for k, v in sorted(groups["kind"].items())},
        "by_page": {k: rates(v) for k, v in sorted(groups["page"].items())},
        "by_pool": {k: rates(v) for k, v in sorted(groups["pool"].items())},
        "failures": failures,
        "partial": sorted(cid for cid, v in verdicts.items() if v["verdict"] == "partial"),
        "missing": loaded["missing"],
        "unknown": loaded["unknown"],
        "duplicates": loaded["duplicates"],
        "invalid": loaded["invalid"],
        "complete": complete,
        "min_support": min_support,
        "passed": passed,
    }


def _pct(value) -> str:
    return "-" if value is None else f"{value:.1%}"


def _rate_table(title: str, groups: dict[str, dict]) -> list[str]:
    lines = [f"{title:<34} {'n':>4} {'sup':>4} {'part':>4} {'uns':>4} {'why':>4} {'support':>8}"]
    for name, r in groups.items():
        lines.append(
            f"  {name[:32]:<32} {r['judged']:>4} {r['supported']:>4} {r['partial']:>4} "
            f"{r['unsupported']:>4} {r['invented-why']:>4} {_pct(r['support_rate']):>8}"
        )
    return lines


def print_score(report: dict) -> None:
    o = report["overall"]
    print(
        f"citation support: {_pct(o['support_rate'])} supported, {_pct(o['weighted_support'])} weighted "
        f"({o['judged']}/{report['claims']} claims judged)"
    )
    for title, key in (("by kind", "by_kind"), ("by pool", "by_pool"), ("by page", "by_page")):
        print("\n".join(_rate_table(title, report[key])))
    if report["failures"]:
        print(f"unsupported or invented-why ({len(report['failures'])}):")
        for f in report["failures"]:
            print(f"  {f['verdict']:<12} {f['page']}:{f['line']} [{f['kind']}] {f['claim'][:100]}")
            if f["note"]:
                print(f"               note: {f['note']}")
    for key in ("missing", "unknown", "duplicates"):
        if report[key]:
            print(f"{key} verdict ids ({len(report[key])}): {', '.join(report[key][:20])}")
    for item in report["invalid"]:
        print(f"invalid verdict line {item['line']}: {item['error']}")
    if report["min_support"] is not None:
        print(f"threshold {report['min_support']:.1%}: {'pass' if report['passed'] else 'FAIL'}")
    elif not report["complete"]:
        print("verdicts incomplete: FAIL")


def cmd_score(args) -> int:
    out = Path(args.out)
    report = score(out, Path(args.verdicts) if args.verdicts else out / VERDICT_FILE, args.min_support)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print_score(report)
    return 0 if report["passed"] else 1


# --- calibration ------------------------------------------------------------------------

_SHEET_ITEM = re.compile(r"^## \d+\. (c-[0-9a-f]{12}(?:-\d+)?)\s*$")
_SHEET_HUMAN = re.compile(r"^Human verdict:[ \t]*(.*?)\s*$", re.IGNORECASE)
_SHEET_NOTE = re.compile(r"^Human note:[ \t]*(.*?)\s*$", re.IGNORECASE)


def _fence(text: str) -> str:
    ticks = "```"
    while ticks in text:
        ticks += "`"
    return f"{ticks}text\n{text}\n{ticks}"


def calibration_sheet(out: Path, verdict_path: Path, n: int, seed: int) -> tuple[str, list[str]]:
    claims = load_claims(out)
    verdicts = load_verdicts(verdict_path, set(claims))["verdicts"]
    ids = sorted(verdicts)
    chosen = ids if len(ids) <= n else random.Random(seed).sample(ids, n)
    lines = [
        "# Citation judge calibration sheet",
        "",
        "For each claim, read only the cited lines and write one verdict after",
        f"`Human verdict:` ({', '.join(VERDICTS)}), same definitions as `{PROMPT}`.",
        "Fill in your verdict before opening the judge's answer. Then run",
        "`eval_citations.py agreement`.",
        "",
    ]
    for number, cid in enumerate(chosen, 1):
        claim = claims[cid]
        lines += [f"## {number}. {cid}", "", f"**Claim:** {claim['text']}", ""]
        for item in claim["evidence"]:
            where = item.get("locator", f"[^{item.get('label')}]")
            extra = "; ".join(x for x in (item.get("note"), item.get("error")) if x)
            lines.append(f"**Cited:** `{where}`" + (f" ({extra})" if extra else ""))
            lines.append("")
            if "text" in item:
                lines += [_fence(item["text"]), ""]
        if not claim["evidence"]:
            lines += ["**Cited:** nothing", ""]
        judge = verdicts[cid]
        lines += [
            "Human verdict: ",
            "Human note: ",
            "",
            "<details><summary>Judge verdict (open after filling in yours)</summary>",
            "",
            f"{judge['verdict']}" + (f": {judge['note']}" if judge["note"] else ""),
            "",
            "</details>",
            "",
        ]
    return "\n".join(lines), chosen


def cmd_calibrate(args) -> int:
    out = Path(args.out)
    verdict_path = Path(args.verdicts) if args.verdicts else out / VERDICT_FILE
    text, chosen = calibration_sheet(out, verdict_path, args.n, args.seed)
    sheet = Path(args.sheet) if args.sheet else out / SHEET
    sheet.write_text(text, encoding="utf-8", newline="\n")
    print(f"{len(chosen)} claims -> {sheet}")
    return 0


def read_human(path: Path) -> dict[str, str | None]:
    """id -> human verdict (None when left empty or not a known verdict)."""
    if path.suffix == ".jsonl":
        rows, _ = read_jsonl(path)
        return {
            row["id"]: normalize_verdict(row.get("verdict", row.get("human")))
            for row in rows if isinstance(row.get("id"), str)
        }
    found: dict[str, str | None] = {}
    current = None
    fence = None
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if fence:
            if stripped.startswith(fence) and set(stripped) == {"`"}:
                fence = None
            continue
        if stripped.startswith("```"):
            fence = stripped[: len(stripped) - len(stripped.lstrip("`"))]
            continue
        m = _SHEET_ITEM.match(line)
        if m:
            current = m.group(1)
            found[current] = None
            continue
        m = _SHEET_HUMAN.match(line)
        if m and current:
            found[current] = normalize_verdict(m.group(1))
    return found


def cohen_kappa(pairs: list[tuple[str, str]], labels: tuple[str, ...]) -> float | None:
    """Cohen's kappa of two raters; 1.0 when both agree perfectly on a single label."""
    n = len(pairs)
    if not n:
        return None
    observed = sum(a == b for a, b in pairs) / n
    first = Counter(a for a, _ in pairs)
    second = Counter(b for _, b in pairs)
    expected = sum(first[k] * second[k] for k in labels) / (n * n)
    if expected == 1:
        return 1.0 if observed == 1 else None
    return (observed - expected) / (1 - expected)


def agreement(verdict_path: Path, sheet: Path, known: set[str]) -> dict:
    judge = load_verdicts(verdict_path, known)["verdicts"]
    human = read_human(sheet)
    pairs, unfilled, unjudged = [], [], []
    for cid, verdict in sorted(human.items()):
        if verdict is None:
            unfilled.append(cid)
        elif cid not in judge:
            unjudged.append(cid)
        else:
            pairs.append((cid, judge[cid]["verdict"], verdict))
    labelled = [(j, h) for _, j, h in pairs]
    binary = [("supported" if j == "supported" else "not", "supported" if h == "supported" else "not") for j, h in labelled]
    kappa = cohen_kappa(labelled, VERDICTS)
    binary_kappa = cohen_kappa(binary, ("supported", "not"))
    confusion = {j: {h: 0 for h in VERDICTS} for j in VERDICTS}
    for j, h in labelled:
        confusion[j][h] += 1
    return {
        "compared": len(pairs),
        "unfilled": unfilled,
        "unjudged": unjudged,
        "agreement": round(sum(j == h for j, h in labelled) / len(labelled), 4) if labelled else None,
        "kappa": None if kappa is None else round(kappa, 4),
        "binary_agreement": round(sum(a == b for a, b in binary) / len(binary), 4) if binary else None,
        "binary_kappa": None if binary_kappa is None else round(binary_kappa, 4),
        "confusion": confusion,  # judge verdict -> human verdict -> count
        "disagreements": [{"id": cid, "judge": j, "human": h} for cid, j, h in pairs if j != h],
    }


def cmd_agreement(args) -> int:
    out = Path(args.out)
    verdict_path = Path(args.verdicts) if args.verdicts else out / VERDICT_FILE
    sheet = Path(args.sheet) if args.sheet else out / SHEET
    report = agreement(verdict_path, sheet, set(load_claims(out)))
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    k = report["kappa"]
    bk = report["binary_kappa"]
    print(
        f"judge-human agreement on {report['compared']} claims: {_pct(report['agreement'])}, "
        f"kappa {'-' if k is None else f'{k:.3f}'}; supported-vs-not {_pct(report['binary_agreement'])}, "
        f"kappa {'-' if bk is None else f'{bk:.3f}'}"
    )
    corner = "judge/human"
    print(f"{corner:<14}" + "".join(f"{h:>14}" for h in VERDICTS))
    for j in VERDICTS:
        print(f"{j:<14}" + "".join(f"{report['confusion'][j][h]:>14}" for h in VERDICTS))
    for d in report["disagreements"]:
        print(f"  {d['id']}: judge {d['judge']}, human {d['human']}")
    if report["unfilled"]:
        print(f"{len(report['unfilled'])} sheet item(s) have no human verdict yet")
    return 0


# --- selftest ------------------------------------------------------------------------------

_SELF_FILES = {
    "Makefile": "test:\n\tpython -m pytest -q\n",
    "src/billing/run.py": (
        "class BillingRun:\n"
        "    def post(self, invoice):\n"
        "        # Posted invoices are immutable so that the ledger never drifts.\n"
        "        if invoice.posted:\n"
        "            raise ValueError('immutable')\n"
        "        invoice.posted = True\n"
    ),
    "src/billing/retry.py": "MAX = 3\n\n\ndef schedule(n):\n    return None if n >= MAX else n + 1\n",
    "src/billing/big.py": "".join(f"X{i} = {i}\n" for i in range(1, 121)),
}

_SELF_GLOSSARY = """| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Billing run | Pass that posts invoices. | invoice job | `BillingRun`[^run] |
| Retry cap | Most charge attempts. | - | `MAX`[^cap] |

[^run]: src/billing/run.py#L1-L2
[^cap]: src/billing/retry.py#L1
"""

_SELF_CONVENTIONS = """## Commands

| Purpose | Command | Status |
|---|---|---|
| Tests | `python -m pytest -q`[^test] | verified |

## Rules

| Area | Rule | Enforced by |
|---|---|---|
| testing | Tests live in tests/.[^test] | convention |

[^test]: Makefile#L1-L2
"""

_SELF_MODULE = """## Responsibility and boundaries

Billing posts invoices. Posting is guarded in `post()`.[^post] Posted invoices are
immutable so that the ledger never drifts.[^guard] Retries stop at `MAX`.[^cap]
The cap lives in `retry.py` and uses `a.b` names.[^cap] Constants live in a
big module.[^big] Nothing here is cited.

- Retry scheduling returns None at the cap.[^cap]
- Uncited list item.

| Invariant | Enforced at | Breaks when |
|---|---|---|
| A posted invoice is never posted again. | `post`[^guard] | Double charge. |
| Every row is judged. | nowhere | Nothing. |

| Change | Also change or check |
|---|---|
| `MAX` | `schedule`[^cap] |

| Note | Detail |
|---|---|
| Plain table cell. | Cited detail.[^post] |

Retries are capped because the gateway limits calls.[^cap] See `x[^fake]`.

[^post]: src/billing/run.py#L2-L6
[^guard]: src/billing/run.py#L3-L6
[^cap]: src/billing/retry.py#L1-L5
[^big]: src/billing/big.py
"""


def _git_run(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def _put(repo: Path, files: dict[str, str]) -> None:
    for rel, text in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")


def _commit(repo: Path, files: dict[str, str], message: str) -> str:
    _put(repo, files)
    _git_run(repo, "add", "-A")
    _git_run(repo, "commit", "-q", "--allow-empty", "-m", message)
    return _git_run(repo, "rev-parse", "HEAD")


def fixture(base: Path) -> tuple[Path, str]:
    """A repository with a draft wiki bound to its first commit; HEAD moved on since."""
    repo = base / "repo"
    repo.mkdir(parents=True)
    _git_run(repo, "init", "-q", "-b", "main")
    for key, value in (("user.name", "Eval"), ("user.email", "eval@example.com"), ("commit.gpgsign", "false")):
        _git_run(repo, "config", key, value)
    rev = _commit(repo, _SELF_FILES, "init")
    ws = _config.init(repo, create_canon=False)
    revision = {".": rev}
    for path, type, body in (
        ("glossary.md", "Glossary", _SELF_GLOSSARY),
        ("conventions.md", "Conventions", _SELF_CONVENTIONS),
        ("modules/billing.md", "Module", _SELF_MODULE),
    ):
        meta = {"type": type, "title": "Secret Title " + type, "description": "d", "status": "draft", "revision": revision}
        if type == "Module":
            meta["scope"] = ["src/billing/**"]
        target = ws.wiki / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(_page.render_page(meta, body), encoding="utf-8", newline="\n")
    _commit(repo, {"src/billing/retry.py": "# moved\n" + _SELF_FILES["src/billing/retry.py"].replace("3", "7")}, "later")
    return repo, rev


def _check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def selftest(base: Path) -> None:
    with contextlib.redirect_stdout(io.StringIO()):
        _selftest(base)


def _selftest(base: Path) -> None:
    repo, rev = fixture(base)
    out = base / "out"
    common = ["--root", str(repo)]
    _check(main(["sample", *common, "--out", str(out), "--per-page", "2", "--seed", "1"]) == 0, "sample failed")
    claims = [json.loads(line) for line in (out / CLAIMS).read_text(encoding="utf-8").splitlines()]
    packets = [json.loads(line) for line in (out / PACKETS).read_text(encoding="utf-8").splitlines()]
    by_kind = Counter(c["kind"] for c in claims)
    _check(by_kind["glossary"] == 2 and by_kind["commands"] == 1 and by_kind["rules"] == 1, f"canon rows {by_kind}")
    _check(by_kind["invariants"] == 2 and by_kind["change_impact"] == 1, f"module rows {by_kind}")
    pools = Counter(c["pool"] for c in claims)
    manifest = json.loads((out / MANIFEST).read_text(encoding="utf-8"))
    # Prose sentences: post, big, list item, table row (+ "cap lives", "Retries stop"); 2 sampled.
    _check(manifest["pool_total"] == {"canon": 7, "causal": 2, "prose": 6}, f"pool totals {manifest['pool_total']}")
    _check(pools == Counter({"canon": 7, "causal": 2, "prose": 2}), f"sampled pools {pools}")
    _check(len({c["id"] for c in claims}) == len(claims), "duplicate claim ids")
    texts = [c["text"] for c in claims]
    _check(not any("[^" in t and "`x[^fake]`" not in t for t in texts), f"footnote markers left in {texts}")
    _check(not any("Nothing here is cited" in t for t in texts), "uncited sentence became a claim")
    causal = [c for c in claims if c["pool"] == "causal"]
    _check(any("so that the ledger" in c["text"] for c in causal), f"causal claims {causal}")
    uncited = [c for c in claims if not c["labels"]]
    _check(len(uncited) == 1 and uncited[0]["kind"] == "invariants", f"uncited rows {uncited}")
    # Evidence is read at the page revision, not HEAD, and large ranges are bounded.
    cap = next(c for c in claims if c["kind"] == "change_impact")
    _check("1 | MAX = 3" in cap["evidence"][0]["text"] and cap["evidence"][0]["rev"] == rev, f"cap evidence {cap['evidence']}")
    big = [e for c in claims for e in c["evidence"] if e.get("locator") == "src/billing/big.py"]
    for item in big:
        _check(item["end"] == MAX_LINES and "truncated" in item["note"], f"big evidence {item}")
    # Packets are blind, and the judge directory holds nothing that names a page.
    judge_files = sorted(p.name for p in (out / JUDGE_DIR).iterdir())
    _check(judge_files == ["judge_prompt.md", "packets.jsonl"], f"judge directory holds {judge_files}")
    raw = (out / PACKETS).read_text(encoding="utf-8")
    for leak in ("Secret Title", "billing.md", "glossary.md", '"page"', '"kind"', "Responsibility"):
        _check(leak not in raw, f"packet leaks {leak!r}")
    _check(all(set(p) == {"id", "claim", "cited"} for p in packets), "packet keys")
    _check("{count}" not in (out / PROMPT).read_text(encoding="utf-8"), "prompt placeholder left")
    # Determinism.
    again = base / "again"
    main(["sample", *common, "--out", str(again), "--per-page", "2", "--seed", "1"])
    _check((again / PACKETS).read_text(encoding="utf-8") == raw, "sampling is not deterministic")

    # Synthetic verdicts: the uncited row is unsupported, the causal claim invented-why, one partial.
    verdicts = []
    for c in claims:
        verdict = "supported"
        if not c["labels"]:
            verdict = "unsupported"
        elif c["pool"] == "causal" and "gateway" in c["text"]:
            verdict = "invented-why"
        elif c["kind"] == "rules":
            verdict = "partial"
        verdicts.append({"id": c["id"], "verdict": verdict, "note": "" if verdict == "supported" else "x"})
    write_jsonl(out / VERDICT_FILE, verdicts)
    report = score(out, out / VERDICT_FILE, 0.7)
    n = len(claims)
    _check(report["complete"] and report["overall"]["judged"] == n, f"score {report}")
    _check(report["overall"]["support_rate"] == round((n - 3) / n, 4), f"support {report['overall']}")
    _check(report["overall"]["weighted_support"] == round((n - 2.5) / n, 4), f"weighted {report['overall']}")
    _check(len(report["failures"]) == 2 and report["passed"], f"failures {report['failures']}")
    _check(report["by_kind"]["rules"]["partial"] == 1, f"by kind {report['by_kind']}")
    _check(main(["score", "--out", str(out), "--min-support", "0.95"]) == 1, "threshold not enforced")
    write_jsonl(out / "broken.jsonl", verdicts[1:] + [{"id": "c-000000000000", "verdict": "supported"}, {"id": verdicts[2]["id"], "verdict": "maybe"}])
    broken = score(out, out / "broken.jsonl", None)
    _check(broken["missing"] == [verdicts[0]["id"]] and broken["unknown"] == ["c-000000000000"], f"broken {broken}")
    _check(len(broken["invalid"]) == 1 and not broken["passed"], f"broken invalid {broken['invalid']}")

    # Calibration sheet and agreement: the human disagrees on one claim.
    _check(main(["calibrate", "--out", str(out), "--n", "5", "--seed", "3"]) == 0, "calibrate failed")
    sheet = out / SHEET
    text = sheet.read_text(encoding="utf-8")
    ids = [m.group(1) for m in (_SHEET_ITEM.match(line) for line in text.splitlines()) if m]
    _check(len(ids) == 5, f"sheet ids {ids}")
    judge = {v["id"]: v["verdict"] for v in verdicts}
    filled, flip = [], ids[0]
    for line in text.splitlines():
        m = _SHEET_ITEM.match(line)
        if m:
            current = m.group(1)
        if line.startswith("Human verdict:"):
            human = judge[current]
            if current == flip:
                human = "unsupported" if human != "unsupported" else "supported"
            line = f"Human verdict: {human}"
        filled.append(line)
    sheet.write_text("\n".join(filled) + "\n", encoding="utf-8", newline="\n")
    result = agreement(out / VERDICT_FILE, sheet, set(judge))
    _check(result["compared"] == 5 and result["agreement"] == 0.8, f"agreement {result}")
    _check(len(result["disagreements"]) == 1 and result["disagreements"][0]["id"] == flip, f"disagreements {result}")
    pairs = [(judge[i], judge[i]) for i in ids[1:]] + [(judge[flip], "unsupported" if judge[flip] != "unsupported" else "supported")]
    _check(result["kappa"] == round(cohen_kappa(pairs, VERDICTS), 4), f"kappa {result}")


def cmd_selftest(args) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        try:
            selftest(Path(tmp))
        except AssertionError as exc:
            print(f"FAIL: {exc}")
            return 1
    print("eval_citations selftest: ok")
    return 0


# --- cli -------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eval_citations.py", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("sample", help="write blind judge packets for every cited claim")
    s.add_argument("--root", default=".", help="repository or hub root (default: current directory)")
    s.add_argument("--wiki", help="wiki directory (default: found via repo-wiki.yaml)")
    s.add_argument("--out", required=True, help="output directory for packets, key and prompt")
    s.add_argument("--per-page", type=int, default=3, help="non-causal prose claims per page; -1 for all")
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--max-lines", type=int, default=MAX_LINES, help="cited lines shown per locator")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_sample)

    s = sub.add_parser("score", help="join packets with judge verdicts")
    s.add_argument("--out", required=True, help="directory written by sample")
    s.add_argument("--verdicts", help=f"verdict JSONL (default: OUT/{VERDICT_FILE})")
    s.add_argument("--min-support", type=float, help="exit 1 when the support rate is below this (0-1)")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_score)

    s = sub.add_parser("calibrate", help="write a human spot-check sheet")
    s.add_argument("--out", required=True)
    s.add_argument("--verdicts")
    s.add_argument("--sheet", help=f"sheet path (default: OUT/{SHEET})")
    s.add_argument("--n", type=int, default=20)
    s.add_argument("--seed", type=int, default=0)
    s.set_defaults(func=cmd_calibrate)

    s = sub.add_parser("agreement", help="judge-human agreement from a filled sheet (.md) or JSONL")
    s.add_argument("--out", required=True)
    s.add_argument("--verdicts")
    s.add_argument("--sheet", help=f"filled sheet .md or .jsonl (default: OUT/{SHEET})")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_agreement)

    s = sub.add_parser("selftest", help="fixture wiki -> sample -> verdicts -> score -> agreement")
    s.set_defaults(func=cmd_selftest)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.func(args)
    except (EvalError, _git.GitError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
