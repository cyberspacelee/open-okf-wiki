import dataclasses
import pathlib
from typing import Any

import yaml


@dataclasses.dataclass
class ParsedPage:
    meta: dict[str, Any]
    body: str
    errors: list[str]


FRONTMATTER_MAX_BYTES = 128 * 1024
FRONTMATTER_MAX_DEPTH = 32


class FrontmatterError(ValueError):
    pass


class _Loader(yaml.SafeLoader):
    pass


def _mapping(loader: _Loader, node: yaml.MappingNode, deep: bool = False):
    result: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise FrontmatterError(f"Duplicate key: {key!r}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


_Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


def _depth(value: Any) -> int:
    if isinstance(value, dict):
        return 1 + max(
            (max(_depth(key), _depth(child)) for key, child in value.items()), default=0
        )
    if isinstance(value, list):
        return 1 + max((_depth(child) for child in value), default=0)
    return 0


def parse_page(text: str, *, reserved: bool = False) -> ParsedPage:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        if reserved:
            return ParsedPage(meta={}, body=text, errors=[])
        return ParsedPage(meta={}, body=text, errors=["No frontmatter found"])

    end = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end = idx
            break

    if end is None:
        return ParsedPage(
            meta={}, body=text, errors=["Frontmatter closing '---' not found"]
        )

    raw = "".join(lines[1:end])
    if len(raw.encode("utf-8")) > FRONTMATTER_MAX_BYTES:
        return ParsedPage(meta={}, body=text, errors=["Frontmatter exceeds 128 KiB"])
    try:
        for token in yaml.scan(raw):
            if isinstance(token, (yaml.tokens.AnchorToken, yaml.tokens.AliasToken)):
                raise FrontmatterError("YAML aliases are not allowed")
        meta = yaml.load(raw, Loader=_Loader) or {}
    except (yaml.YAMLError, FrontmatterError) as exc:
        return ParsedPage(meta={}, body=text, errors=[f"Invalid YAML: {exc}"])
    if not isinstance(meta, dict):
        return ParsedPage(
            meta={}, body=text, errors=["Frontmatter must be a YAML mapping"]
        )
    if not all(isinstance(key, str) for key in meta):
        return ParsedPage(
            meta={}, body=text, errors=["Frontmatter keys must be strings"]
        )
    if _depth(meta) > FRONTMATTER_MAX_DEPTH:
        return ParsedPage(
            meta={}, body=text, errors=["Frontmatter exceeds maximum depth 32"]
        )
    return ParsedPage(meta=meta, body="".join(lines[end + 1 :]), errors=[])


def parse_file(path: pathlib.Path, *, reserved: bool = False) -> ParsedPage:
    return parse_page(path.read_text(encoding="utf-8"), reserved=reserved)


def render(meta: dict[str, Any], body: str) -> str:
    raw = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).rstrip()
    return f"---\n{raw}\n---\n\n{body.lstrip()}"
