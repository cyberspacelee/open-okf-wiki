import dataclasses
import re


@dataclasses.dataclass
class Section:
    title: str
    level: int
    start_line: int
    content: str


@dataclasses.dataclass
class Structure:
    sections: list[Section]
    links: list[tuple[str, int]]
    footnote_refs: list[tuple[str, int]]
    footnote_defs: dict[str, str]
    placeholders: list[tuple[str, int]]
    mermaid_blocks: list[tuple[int, str]]


_HEADING = re.compile(r"^(#{1,3}) (.+)$")
_LINK = re.compile(r"\[(?:[^\]]*)\]\(([^)]+)\)")
_FNREF = re.compile(r"\[\^([^\]]+)\](?!:)")
_FNDEF = re.compile(r"^\[\^([^\]]+)\]:\s*(.+)$")
_PLACEHOLDER = re.compile(r"\{\{[^}]*\}\}")
_FENCE = re.compile(r"^(`{3,}|~{3,})(.*)")


def _in_fence(line: str, fence_char: str | None, fence_len: int) -> tuple[bool, str | None, int]:
    """Return (is_closing, new_fence_char, new_fence_len)."""
    m = _FENCE.match(line)
    if fence_char is None:
        if m:
            ch = m.group(1)[0]
            return False, ch, len(m.group(1))
        return False, None, 0
    else:
        if m and m.group(1)[0] == fence_char and len(m.group(1)) >= fence_len:
            return True, None, 0
        return False, fence_char, fence_len


def extract(body: str) -> Structure:
    lines = body.splitlines()

    sections: list[Section] = []
    links: list[tuple[str, int]] = []
    footnote_refs: list[tuple[str, int]] = []
    footnote_defs: dict[str, str] = {}
    placeholders: list[tuple[str, int]] = []
    mermaid_blocks: list[tuple[int, str]] = []

    fence_char: str | None = None
    fence_len: int = 0
    fence_start: int = 0
    in_mermaid: bool = False
    mermaid_lines: list[str] = []

    for lineno, raw in enumerate(lines, 1):
        line = raw

        # fence state machine
        if fence_char is None:
            m = _FENCE.match(line)
            if m:
                fence_char = m.group(1)[0]
                fence_len = len(m.group(1))
                lang = m.group(2).strip()
                in_mermaid = lang == "mermaid"
                fence_start = lineno
                mermaid_lines = []
                continue
        else:
            m = _FENCE.match(line)
            if m and m.group(1)[0] == fence_char and len(m.group(1)) >= fence_len:
                if in_mermaid:
                    mermaid_blocks.append((fence_start, "\n".join(mermaid_lines)))
                fence_char = None
                fence_len = 0
                in_mermaid = False
                continue
            if in_mermaid:
                mermaid_lines.append(line)
            continue  # inside any fence: skip all other processing

        # headings
        hm = _HEADING.match(line)
        if hm:
            level = len(hm.group(1))
            title = hm.group(2).strip()
            sections.append(Section(title=title, level=level, start_line=lineno, content=""))
            continue

        # footnote definition (must come before link scan)
        fdm = _FNDEF.match(line)
        if fdm:
            footnote_defs[fdm.group(1)] = fdm.group(2)
            continue

        # footnote refs
        for frm in _FNREF.finditer(line):
            footnote_refs.append((frm.group(1), lineno))

        # links (exclude http/https)
        for lm in _LINK.finditer(line):
            target = lm.group(1)
            if not target.startswith("http://") and not target.startswith("https://"):
                links.append((target, lineno))

        # placeholders
        for pm in _PLACEHOLDER.finditer(line):
            placeholders.append((pm.group(0), lineno))

    # fill section content
    for i, sec in enumerate(sections):
        start = sec.start_line  # 1-based heading line
        if i + 1 < len(sections):
            end = sections[i + 1].start_line - 1
        else:
            end = len(lines)
        # content = lines after heading up to next section
        content_lines = lines[start:end]  # lines[start] is line after heading (0-indexed = start_line)
        sec.content = "\n".join(content_lines).strip()

    return Structure(
        sections=sections,
        links=links,
        footnote_refs=footnote_refs,
        footnote_defs=footnote_defs,
        placeholders=placeholders,
        mermaid_blocks=mermaid_blocks,
    )
