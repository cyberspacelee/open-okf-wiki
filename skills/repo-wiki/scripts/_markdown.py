import dataclasses
import re


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
class Structure:
    sections: list[Section]
    links: list[tuple[str, int]]
    footnote_refs: list[tuple[str, int]]
    footnote_defs: dict[str, str]
    placeholders: list[tuple[str, int]]
    fences: list[CodeFence]
    lines: list[str]


_HEADING = re.compile(r"^(#{1,3}) (.+)$")
_LINK = re.compile(r"\[(?:[^\]]*)\]\(([^)]+)\)")
_FNREF = re.compile(r"\[\^([^\]]+)\](?!:)")
_FNDEF = re.compile(r"^\[\^([^\]]+)\]:\s*(.+)$")
_PLACEHOLDER = re.compile(r"\{\{[^}]*\}\}")
_FENCE = re.compile(r"^(`{3,}|~{3,})(.*)")


def extract(body: str) -> Structure:
    lines = body.splitlines()

    sections: list[Section] = []
    links: list[tuple[str, int]] = []
    footnote_refs: list[tuple[str, int]] = []
    footnote_defs: dict[str, str] = {}
    placeholders: list[tuple[str, int]] = []
    fences: list[CodeFence] = []

    fence_char: str | None = None
    fence_len: int = 0
    fence_language = ""
    fence_start = 0
    fence_content: list[str] = []

    for lineno, raw in enumerate(lines, 1):
        line = raw

        # fence state machine
        if fence_char is None:
            m = _FENCE.match(line)
            if m:
                fence_char = m.group(1)[0]
                fence_len = len(m.group(1))
                fence_language = m.group(2).strip().split(maxsplit=1)[0].lower()
                fence_start = lineno
                fence_content = []
                continue
        else:
            m = _FENCE.match(line)
            if m and m.group(1)[0] == fence_char and len(m.group(1)) >= fence_len:
                fences.append(
                    CodeFence(
                        language=fence_language,
                        content="\n".join(fence_content),
                        start_line=fence_start,
                        end_line=lineno,
                    )
                )
                fence_char = None
                fence_len = 0
                continue
            fence_content.append(line)
            continue  # inside any fence: skip all other processing

        # headings
        hm = _HEADING.match(line)
        if hm:
            level = len(hm.group(1))
            title = hm.group(2).strip()
            sections.append(
                Section(title=title, level=level, start_line=lineno, content="")
            )
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

    if fence_char is not None:
        fences.append(
            CodeFence(
                language=fence_language,
                content="\n".join(fence_content),
                start_line=fence_start,
                end_line=None,
            )
        )

    # fill section content
    for i, sec in enumerate(sections):
        start = sec.start_line  # 1-based heading line
        if i + 1 < len(sections):
            end = sections[i + 1].start_line - 1
        else:
            end = len(lines)
        # content = lines after heading up to next section
        content_lines = lines[
            start:end
        ]  # lines[start] is line after heading (0-indexed = start_line)
        sec.content = "\n".join(content_lines).strip()

    return Structure(
        sections=sections,
        links=links,
        footnote_refs=footnote_refs,
        footnote_defs=footnote_defs,
        placeholders=placeholders,
        fences=fences,
        lines=lines,
    )
