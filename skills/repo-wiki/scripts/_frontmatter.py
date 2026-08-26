import dataclasses
import pathlib
import re


@dataclasses.dataclass
class ParsedPage:
    meta: dict
    body: str
    errors: list[str]


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    return value


def _parse_frontmatter(lines: list[str]) -> tuple[dict, list[str]]:
    meta: dict = {}
    errors: list[str] = []
    seen: set[str] = set()
    i = 0
    in_sources = False
    current_source: dict | None = None

    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip("\n")

        # sources list item
        if in_sources:
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            if indent >= 2 and stripped.startswith("- "):
                if current_source is not None:
                    meta.setdefault("sources", []).append(current_source)
                current_source = {}
                kv = stripped[2:].strip()
                if ":" in kv:
                    k, _, v = kv.partition(":")
                    current_source[k.strip()] = _strip_quotes(v)
                i += 1
                continue
            if indent >= 4 and ":" in stripped and not stripped.startswith("- "):
                if current_source is not None:
                    k, _, v = stripped.partition(":")
                    current_source[k.strip()] = _strip_quotes(v)
                i += 1
                continue
            # left sources block
            if current_source is not None:
                meta.setdefault("sources", []).append(current_source)
                current_source = None
            in_sources = False
            # fall through to normal parsing

        if ":" not in line:
            if line.strip():
                errors.append(f"Unrecognised line in frontmatter: {line!r}")
            i += 1
            continue

        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()

        if not key or " " in key:
            errors.append(f"Unrecognised line in frontmatter: {line!r}")
            i += 1
            continue

        if key in seen:
            errors.append(f"Duplicate key: {key!r}")
        seen.add(key)

        if key == "sources" and value == "":
            in_sources = True
            meta.setdefault("sources", [])
            i += 1
            continue

        if value == "":
            errors.append(f"Unsupported nested value for key {key!r}")
            i += 1
            continue

        meta[key] = _strip_quotes(value)
        i += 1

    if in_sources and current_source is not None:
        meta.setdefault("sources", []).append(current_source)

    return meta, errors


def parse_page(text: str) -> ParsedPage:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != "---":
        return ParsedPage(meta={}, body=text, errors=["No frontmatter found"])

    end = None
    for idx in range(1, len(lines)):
        if lines[idx].rstrip() == "---":
            end = idx
            break

    if end is None:
        return ParsedPage(meta={}, body=text, errors=["Frontmatter closing '---' not found"])

    fm_lines = lines[1:end]
    body = "".join(lines[end + 1 :])
    meta, errors = _parse_frontmatter(fm_lines)
    return ParsedPage(meta=meta, body=body, errors=errors)


def parse_file(path: pathlib.Path) -> ParsedPage:
    return parse_page(path.read_text(encoding="utf-8"))
