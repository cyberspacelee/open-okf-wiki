import dataclasses
import re

import _files


@dataclasses.dataclass
class Section:
    title: str
    level: int
    start_line: int
    content: str


@dataclasses.dataclass
class CodeFence:
    language: str
    content: str
    start_line: int
    end_line: int | None


@dataclasses.dataclass
class MdRow:
    cells: list[str]
    line: int


@dataclasses.dataclass
class MdTable:
    header: list[str]
    rows: list[MdRow]
    line: int


@dataclasses.dataclass
class Structure:
    sections: list[Section]
    links: list[tuple[str, int]]
    footnote_refs: list[tuple[str, int]]
    footnote_defs: dict[str, tuple[str, int]]
    duplicate_defs: list[tuple[str, int]]
    tables: list[MdTable]
    todos: list[tuple[int, str]]
    prose: list[tuple[int, str]]
    fences: list[CodeFence]
    lines: list[str]


_HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.+?)\s*$")
_FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_FENCE_CLOSE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*$")
_CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]*)\)")
_LINK_TITLE = re.compile(r'^(\S+)\s+"[^"]*"$')
_FNREF = re.compile(r"\[\^([^\]]+)\]")
_FNDEF = re.compile(r"^\[\^([^\]]+)\]:\s*(.*?)\s*$")
_DELIMITER_CELL = re.compile(r"^:?-+:?$")
_TODO = "okf:todo"


def strip_code_spans(text: str) -> str:
    return _CODE_SPAN.sub("", text)


def _split_row(line: str) -> list[str]:
    spans = [m.span() for m in _CODE_SPAN.finditer(line)]
    cells: list[str] = []
    start = 0
    for i, char in enumerate(line):
        if char != "|" or (i and line[i - 1] == "\\"):
            continue
        if any(a <= i < b for a, b in spans):
            continue
        cells.append(line[start:i])
        start = i + 1
    cells.append(line[start:])
    if len(cells) > 1 and not cells[0].strip():
        cells = cells[1:]
    if len(cells) > 1 and not cells[-1].strip():
        cells = cells[:-1]
    return [cell.strip().replace("\\|", "|") for cell in cells]


def _is_table_start(header: str, delimiter: str) -> bool:
    if "|" not in header or "|" not in delimiter:
        return False
    cells = _split_row(delimiter)
    return len(cells) == len(_split_row(header)) and all(
        _DELIMITER_CELL.match(cell) for cell in cells
    )


def _scan_inline(
    text: str,
    lineno: int,
    links: list[tuple[str, int]],
    refs: list[tuple[str, int]],
) -> None:
    text = strip_code_spans(text)
    for m in _LINK.finditer(text):
        target = m.group(1).strip()
        titled = _LINK_TITLE.match(target)
        links.append((titled.group(1) if titled else target, lineno))
    for m in _FNREF.finditer(text):
        refs.append((m.group(1), lineno))


def extract(body: str) -> Structure:
    lines = _files.text_lines(body)

    sections: list[Section] = []
    links: list[tuple[str, int]] = []
    footnote_refs: list[tuple[str, int]] = []
    footnote_defs: dict[str, tuple[str, int]] = {}
    duplicate_defs: list[tuple[str, int]] = []
    tables: list[MdTable] = []
    todos: list[tuple[int, str]] = []
    prose: list[tuple[int, str]] = []
    fences: list[CodeFence] = []

    fence: CodeFence | None = None
    fence_marker = ""
    fence_lines: list[str] = []
    comment: list[str] | None = None  # inner lines of an open HTML comment
    comment_start = 0
    table: MdTable | None = None

    def close_comment() -> None:
        text = "\n".join(comment).strip()
        if text.startswith(_TODO):
            todos.append((comment_start, text[len(_TODO) :].strip()))

    i = 0
    while i < len(lines):
        line = lines[i]
        lineno = i + 1
        i += 1

        if comment is not None:
            inner, closed, _ = line.partition("-->")
            comment.append(inner)
            if closed:
                close_comment()
                comment = None
            continue

        if fence is not None:
            m = _FENCE_CLOSE.match(line)
            if (
                m
                and m.group(1)[0] == fence_marker[0]
                and len(m.group(1)) >= len(fence_marker)
            ):
                fence.content = "\n".join(fence_lines)
                fence.end_line = lineno
                fence = None
            else:
                fence_lines.append(line)
            continue

        if table is not None:
            if "|" in line and line.strip():
                table.rows.append(MdRow(cells=_split_row(line), line=lineno))
                _scan_inline(line, lineno, links, footnote_refs)
                continue
            table = None

        stripped = line.strip()
        if not stripped:
            continue

        m = _FENCE_OPEN.match(line)
        if m:
            fence_marker = m.group(1)
            info = m.group(2).split(maxsplit=1)
            fence = CodeFence(
                language=info[0].lower() if info else "",
                content="",
                start_line=lineno,
                end_line=None,
            )
            fences.append(fence)
            fence_lines = []
            continue

        if stripped.startswith("<!--"):
            inner, closed, _ = stripped[len("<!--") :].partition("-->")
            comment, comment_start = [inner], lineno
            if closed:
                close_comment()
                comment = None
            continue

        m = _HEADING.match(line)
        if m:
            _scan_inline(line, lineno, links, footnote_refs)
            sections.append(
                Section(
                    title=m.group(2),
                    level=len(m.group(1)),
                    start_line=lineno,
                    content="",
                )
            )
            continue

        m = _FNDEF.match(line)
        if m:
            label, text = m.groups()
            if label in footnote_defs:
                duplicate_defs.append((label, lineno))
            else:
                footnote_defs[label] = (text, lineno)
            continue

        if i < len(lines) and _is_table_start(line, lines[i]):
            table = MdTable(header=_split_row(line), rows=[], line=lineno)
            tables.append(table)
            _scan_inline(line, lineno, links, footnote_refs)
            i += 1  # delimiter row
            continue

        _scan_inline(line, lineno, links, footnote_refs)
        text = strip_code_spans(line)
        if text.strip():
            prose.append((lineno, text))

    if fence is not None:
        fence.content = "\n".join(fence_lines)
    if comment is not None:
        close_comment()

    for n, sec in enumerate(sections):
        end = sections[n + 1].start_line - 1 if n + 1 < len(sections) else len(lines)
        sec.content = "\n".join(lines[sec.start_line : end]).strip()

    return Structure(
        sections=sections,
        links=links,
        footnote_refs=footnote_refs,
        footnote_defs=footnote_defs,
        duplicate_defs=duplicate_defs,
        tables=tables,
        todos=todos,
        prose=prose,
        fences=fences,
        lines=lines,
    )
