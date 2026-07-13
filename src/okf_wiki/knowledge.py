import base64
import difflib
import hashlib
import json
import mimetypes
import posixpath
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt
from markdown_it.token import Token
from mdit_py_plugins.dollarmath import dollarmath_plugin
from pygments import lex
from pygments.lexers import get_lexer_by_name
from pygments.lexers.special import TextLexer
from pygments.token import Token as PygmentsToken

from .accepted_knowledge import AcceptedKnowledgeStore
from .bundle import published_run_id
from .worker import GitObjectSnapshotReader


MAX_BUNDLE_PAGE_BYTES = 1_000_000
MAX_BUNDLE_ASSET_BYTES = 1_000_000
MAX_SEARCH_RESULTS = 50
MAX_MERMAID_EDGES = 32
MAX_MERMAID_NODES = MAX_MERMAID_EDGES * 2
MAX_MERMAID_LABEL_CHARS = 80
CLAIM_MARKER_RE = re.compile(r"<!--\s*claims:\s*(claim:[0-9a-f]{64})\s*-->")
MERMAID_NODE_RE = re.compile(
    r"(?P<id>[A-Za-z][A-Za-z0-9_-]*)(?:\[(?P<square>[^\]\n]+)\]|"
    r"\((?P<round>[^)\n]+)\)|\{(?P<brace>[^}\n]+)\})?"
)
MERMAID_EDGE_RE = re.compile(r"^\s*(.+?)\s*--+>?\s*(?:\|([^|\n]+)\|\s*)?(.+?)\s*$")
SAFE_IMAGE_TYPES = {"image/gif", "image/jpeg", "image/png", "image/webp"}


def _markdown() -> MarkdownIt:
    return (
        MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": False})
        .enable(["table", "strikethrough"])
        .use(dollarmath_plugin)
    )


@dataclass(frozen=True)
class BundleSelection:
    kind: Literal["staged", "published", "previous"]
    run_id: str
    root: Path
    state: str
    source_set: dict[str, Any]

    def identity(self) -> dict[str, str]:
        return {
            "kind": self.kind,
            "run_id": self.run_id,
            "source_set_digest": str(self.source_set.get("digest", "")),
            "state": self.state,
        }


class KnowledgeReader:
    def __init__(self, database: Path) -> None:
        self.database = database

    def _rows(self) -> list[sqlite3.Row]:
        with sqlite3.connect(self.database) as connection:
            connection.row_factory = sqlite3.Row
            return list(connection.execute("SELECT * FROM runs ORDER BY updated_at DESC, id DESC"))

    @staticmethod
    def _source_set(row: sqlite3.Row) -> dict[str, Any]:
        return json.loads(row["source_set_json"]) if row["source_set_json"] else {"digest": ""}

    @staticmethod
    def _release(row: sqlite3.Row) -> Path:
        destination = Path(row["publish_dir"])
        return destination.parent / f".{destination.name}.releases" / row["id"]

    @staticmethod
    def _published_root(row: sqlite3.Row) -> Path | None:
        release = KnowledgeReader._release(row)
        if release.is_dir():
            return release
        destination = Path(row["publish_dir"])
        if published_run_id(destination) == row["id"] and destination.is_dir():
            return destination
        return None

    def selection(
        self, kind: Literal["staged", "published", "previous"], run_id: str | None = None
    ) -> BundleSelection:
        rows = self._rows()
        by_id = {row["id"]: row for row in rows}
        if kind == "staged":
            candidates = [by_id[run_id]] if run_id in by_id else ([] if run_id else rows)
            row = next(
                (
                    item
                    for item in candidates
                    if item["state"] != "published" and Path(item["staging_dir"]).is_dir()
                ),
                None,
            )
            root = Path(row["staging_dir"]) if row is not None else None
        elif kind == "published":
            candidates = [by_id[run_id]] if run_id in by_id else ([] if run_id else rows)
            row = next((item for item in candidates if item["state"] == "published"), None)
            root = self._published_root(row) if row is not None else None
        else:
            if run_id is None:
                current = self.selection("staged")
                current_row = by_id[current.run_id]
                current_source_set = self._source_set(current_row)
                base_run_id = current_source_set.get("base_run_id")
                row = by_id.get(base_run_id) if isinstance(base_run_id, str) else None
            else:
                row = by_id.get(run_id)
            if row is not None and row["state"] != "published":
                row = None
            root = self._published_root(row) if row is not None else None
        if row is None or root is None or not root.is_dir():
            label = kind.title()
            raise ValueError(f"{label} Knowledge Bundle is not available")
        return BundleSelection(kind, row["id"], root.resolve(), row["state"], self._source_set(row))

    def available(self) -> list[dict[str, str]]:
        bundles = []
        for kind in ("staged", "published"):
            try:
                bundles.append(self.selection(kind).identity())
            except ValueError:
                pass
        return bundles

    def _previous_of(self, run_id: str) -> BundleSelection:
        rows = {row["id"]: row for row in self._rows()}
        row = rows.get(run_id)
        source_set = self._source_set(row) if row is not None else {}
        base_run_id = source_set.get("base_run_id")
        if not isinstance(base_run_id, str):
            raise ValueError("Previous Knowledge Bundle is not available")
        return self.selection("previous", base_run_id)

    def _diff_options_for_target(self, target: BundleSelection) -> list[dict[str, str]]:
        try:
            previous = self._previous_of(target.run_id)
        except ValueError:
            return []
        if previous.run_id == target.run_id:
            return []
        if target.kind == "published":
            return [
                {
                    "base": "previous",
                    "base_run_id": previous.run_id,
                    "target": "published",
                    "target_run_id": target.run_id,
                }
            ]
        return [
            {
                "base": "published",
                "base_run_id": previous.run_id,
                "target": "staged",
                "target_run_id": target.run_id,
            },
            {
                "base": "previous",
                "base_run_id": previous.run_id,
                "target": "staged",
                "target_run_id": target.run_id,
            },
        ]

    def diff_options(self, selected: BundleSelection) -> list[dict[str, str]]:
        targets = []
        for kind in ("published", "staged"):
            try:
                target = selected if selected.kind == kind else self.selection(kind)
            except ValueError:
                continue
            if all(item.run_id != target.run_id or item.kind != target.kind for item in targets):
                targets.append(target)
        options = []
        for target in targets:
            options.extend(self._diff_options_for_target(target))
        return options

    @staticmethod
    def _canonical_page(path: str) -> str:
        parsed = PurePosixPath(path)
        if (
            not path
            or parsed.is_absolute()
            or ".." in parsed.parts
            or "\\" in path
            or "\x00" in path
            or parsed.as_posix() != path
            or parsed.suffix.casefold() != ".md"
        ):
            raise ValueError("Page must be a canonical Bundle path ending in .md")
        return path

    @staticmethod
    def _resolve_page(root: Path, path: str, *, missing_ok: bool) -> Path | None:
        target = root / KnowledgeReader._canonical_page(path)
        if target.is_symlink():
            raise ValueError("Bundle page symlinks are not allowed")
        try:
            target.resolve().relative_to(root)
        except ValueError as error:
            raise ValueError("Page must be a canonical Bundle path ending in .md") from error
        if not target.exists() and missing_ok:
            return None
        if not target.exists():
            raise ValueError(f"Bundle page does not exist: {path}")
        if not target.is_file():
            raise ValueError(f"Bundle page is not a file: {path}")
        return target

    @staticmethod
    def _target(root: Path, path: str) -> Path:
        target = KnowledgeReader._resolve_page(root, path, missing_ok=False)
        if target is None:
            raise ValueError(f"Bundle page does not exist: {path}")
        return target

    @staticmethod
    def _read(target: Path) -> str:
        try:
            data = target.read_bytes()
        except OSError as error:
            raise ValueError("Bundle page could not be read") from error
        if len(data) > MAX_BUNDLE_PAGE_BYTES:
            raise ValueError("Bundle page exceeds the 1 MB reader limit")
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("Bundle page is not valid UTF-8") from error

    @staticmethod
    def _optional_read(root: Path, path: str) -> str | None:
        target = KnowledgeReader._resolve_page(root, path, missing_ok=True)
        if target is None:
            return None
        return KnowledgeReader._read(target)

    @staticmethod
    def _frontmatter(text: str) -> tuple[dict[str, Any], str]:
        if not text.startswith("---\n"):
            return {}, text
        end = text.find("\n---\n", 4)
        if end < 0:
            raise ValueError("Bundle page has unterminated YAML frontmatter")
        try:
            metadata = yaml.safe_load(text[4:end])
        except yaml.YAMLError as error:
            raise ValueError("Bundle page has malformed YAML frontmatter") from error
        if not isinstance(metadata, dict) or any(not isinstance(key, str) for key in metadata):
            raise ValueError("Bundle page frontmatter must be a string-keyed mapping")
        try:
            json.dumps(metadata)
        except (TypeError, ValueError) as error:
            raise ValueError("Bundle page frontmatter contains unsupported values") from error
        return metadata, text[end + 5 :]

    def pages(self, selection: BundleSelection) -> list[dict[str, Any]]:
        records: dict[str, dict[str, Any]] = {}
        links: dict[str, set[str]] = {}
        for target in sorted(selection.root.rglob("*.md")):
            if target.is_symlink():
                continue
            relative = target.relative_to(selection.root).as_posix()
            try:
                text = self._read(target)
                metadata, body = self._frontmatter(text)
                title = self._title(metadata, body, relative)
                targets = self._internal_links(body, relative)
            except ValueError:
                title, targets = relative, set()
            records[relative] = {"path": relative, "title": title, "backlinks": []}
            links[relative] = targets
        for source, targets in links.items():
            for target in targets:
                if target in records:
                    records[target]["backlinks"].append(source)
        for record in records.values():
            record["backlinks"].sort()
        return sorted(records.values(), key=lambda item: (item["title"].casefold(), item["path"]))

    @staticmethod
    def _title(metadata: dict[str, Any], body: str, fallback: str) -> str:
        if isinstance(metadata.get("title"), str) and metadata["title"].strip():
            return metadata["title"].strip()
        for token in _markdown().parse(body):
            if token.type == "inline" and token.map and token.map[0] == 0:
                return token.content.strip() or fallback
            if token.type == "heading_open":
                continue
        match = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        return match.group(1).strip() if match else fallback

    @staticmethod
    def _internal_links(body: str, page: str) -> set[str]:
        targets = set()
        for token in _markdown().parse(body):
            for child in token.children or []:
                if child.type != "link_open":
                    continue
                href = str(child.attrGet("href") or "")
                target = _internal_target(page, href)
                if target:
                    targets.add(target)
        return targets

    def snapshot(self, kind: Literal["staged", "published"], run_id: str | None) -> dict:
        selected = self.selection(kind, run_id)
        pages = self.pages(selected)
        paths = {page["path"] for page in pages}
        default = "index.md" if "index.md" in paths else (pages[0]["path"] if pages else None)
        return {
            "bundles": self.available(),
            "default_page": default,
            "diff_options": self.diff_options(selected),
            "pages": pages,
            "selected": selected.identity(),
        }

    def page(self, kind: Literal["staged", "published"], path: str, run_id: str | None) -> dict:
        selection = self.selection(kind, run_id)
        target = self._target(selection.root, path)
        source = self._read(target)
        metadata, body = self._frontmatter(source)
        renderer = StructuredMarkdown(selection.root, path)
        blocks = renderer.render(body)
        backlinks = next(
            (item["backlinks"] for item in self.pages(selection) if item["path"] == path), []
        )
        return {
            **selection.identity(),
            "backlinks": backlinks,
            "blocks": blocks,
            "diagnostics": renderer.diagnostics,
            "metadata": metadata,
            "outline": renderer.outline,
            "path": path,
            "source": source,
            "title": self._title(metadata, body, path),
        }

    def search(
        self, query: str, kind: Literal["staged", "published"], run_id: str | None
    ) -> list[dict[str, str]]:
        query = query.strip()
        if not query:
            raise ValueError("Search query must not be blank")
        selection = self.selection(kind, run_id)
        results = []
        needle = query.casefold()
        for page in self.pages(selection):
            text = self._read(self._target(selection.root, page["path"]))
            _metadata, body = self._frontmatter(text)
            line = next(
                (line.strip() for line in body.splitlines() if needle in line.casefold()), None
            )
            if line:
                results.append({"path": page["path"], "title": page["title"], "excerpt": line})
            if len(results) == MAX_SEARCH_RESULTS:
                break
        return results

    def diff(
        self,
        path: str,
        base: Literal["published", "previous"],
        target: Literal["staged", "published"],
        base_run_id: str,
        target_run_id: str,
    ) -> dict:
        target_selection = self.selection(target, target_run_id)
        requested = {
            "base": base,
            "base_run_id": base_run_id,
            "target": target,
            "target_run_id": target_run_id,
        }
        if requested not in self._diff_options_for_target(target_selection):
            raise ValueError("Knowledge diff selection is not an authoritative Run relationship")
        base_selection = self.selection(base, base_run_id)
        left_text = self._optional_read(base_selection.root, path)
        right_text = self._optional_read(target_selection.root, path)
        if left_text is None and right_text is None:
            raise ValueError(f"Bundle page does not exist: {path}")
        left = (left_text or "").splitlines()
        right = (right_text or "").splitlines()
        lines = []
        left_number = right_number = 1
        for tag, left_start, left_end, right_start, right_end in difflib.SequenceMatcher(
            None, left, right, autojunk=False
        ).get_opcodes():
            if tag == "equal":
                for left_line, right_line in zip(
                    left[left_start:left_end], right[right_start:right_end], strict=True
                ):
                    lines.append(
                        {
                            "kind": "unchanged",
                            "left": left_line,
                            "left_number": left_number,
                            "right": right_line,
                            "right_number": right_number,
                        }
                    )
                    left_number += 1
                    right_number += 1
            else:
                removed = left[left_start:left_end]
                added = right[right_start:right_end]
                for index in range(max(len(removed), len(added))):
                    has_left = index < len(removed)
                    has_right = index < len(added)
                    lines.append(
                        {
                            "kind": "changed"
                            if has_left and has_right
                            else "removed"
                            if has_left
                            else "added",
                            "left": removed[index] if has_left else None,
                            "left_number": left_number if has_left else None,
                            "right": added[index] if has_right else None,
                            "right_number": right_number if has_right else None,
                        }
                    )
                    left_number += has_left
                    right_number += has_right
        return {
            "base": base_selection.identity(),
            "lines": lines,
            "page_change": (
                "added"
                if left_text is None
                else "removed"
                if right_text is None
                else "unchanged"
                if left_text == right_text
                else "changed"
            ),
            "path": path,
            "target": target_selection.identity(),
        }

    def claim(
        self, claim_id: str, kind: Literal["staged", "published"], run_id: str | None
    ) -> dict:
        selection = self.selection(kind, run_id)
        claim = AcceptedKnowledgeStore(self.database).get_claim(selection.run_id, claim_id)
        if claim is None:
            raise ValueError(f"Accepted Claim does not exist: {claim_id}")
        sources = {source["id"]: source for source in selection.source_set.get("sources", [])}
        evidence_payload = []
        for evidence in claim["evidence"]:
            payload = {
                "authority": evidence["authority"],
                "digest": evidence["digest"],
                "end_line": evidence["end_line"],
                "evidence_kind": evidence["evidence_kind"],
                "id": evidence["id"],
                "path": evidence["path"],
                "revision": evidence["revision"],
                "source_id": evidence["source_id"],
                "start_line": evidence["start_line"],
            }
            source = sources.get(evidence["source_id"])
            try:
                if (
                    source is None
                    or source["revision"].casefold() != evidence["revision"].casefold()
                ):
                    raise ValueError("Evidence Source Snapshot is unavailable")
                reader = GitObjectSnapshotReader(
                    Path(source["repository"]), evidence["source_id"], evidence["revision"]
                )
                excerpt = reader.read_text_sync(
                    evidence["path"],
                    evidence["start_line"],
                    evidence["end_line"],
                    allowed=(evidence["path"],),
                )
                if "sha256:" + hashlib.sha256(excerpt.encode()).hexdigest() != evidence["digest"]:
                    raise ValueError("Evidence excerpt digest no longer matches")
                payload["excerpt"] = excerpt
                payload["error"] = None
            except (OSError, UnicodeError, ValueError) as error:
                payload["excerpt"] = None
                payload["error"] = str(error)
            evidence_payload.append(payload)
        return {
            **{key: value for key, value in claim.items() if key != "evidence"},
            "evidence": evidence_payload,
        }


class StructuredMarkdown:
    def __init__(self, root: Path, page: str) -> None:
        self.root = root
        self.page = page
        self.diagnostics: list[str] = []
        self.outline: list[dict[str, Any]] = []
        self._heading_ids: dict[str, int] = {}

    def render(self, source: str) -> list[dict[str, Any]]:
        for unsafe in re.findall(
            r"\]\(((?:javascript|vbscript|data):[^\n]+)\)\s*$", source, re.I | re.M
        ):
            self._diagnostic(f"Unsafe URL was omitted: {unsafe}")
        tokens = _markdown().parse(source)
        blocks, _ = self._blocks(tokens, 0)
        return blocks

    def _blocks(
        self, tokens: list[Token], index: int, stop: str | None = None
    ) -> tuple[list[dict[str, Any]], int]:
        blocks = []
        while index < len(tokens):
            token = tokens[index]
            if stop and token.type == stop:
                return blocks, index + 1
            if token.type == "heading_open":
                inline = tokens[index + 1]
                nodes = self._inline(inline.children or [])
                text = _plain(nodes)
                slug = self._slug(text)
                level = int(token.tag[1])
                self.outline.append({"level": level, "text": text, "id": slug})
                blocks.append({"type": "heading", "level": level, "id": slug, "children": nodes})
                index += 3
            elif token.type == "paragraph_open":
                inline = tokens[index + 1]
                marker = CLAIM_MARKER_RE.fullmatch(inline.content.strip())
                if marker:
                    blocks.append({"type": "claim", "claim_id": marker.group(1)})
                elif _looks_like_raw_html(inline.content):
                    self._diagnostic("Raw HTML was omitted.")
                else:
                    blocks.append(
                        {"type": "paragraph", "children": self._inline(inline.children or [])}
                    )
                index += 3
            elif token.type in {"bullet_list_open", "ordered_list_open"}:
                block, index = self._list(tokens, index)
                blocks.append(block)
            elif token.type == "blockquote_open":
                children, index = self._blocks(tokens, index + 1, "blockquote_close")
                blocks.append({"type": "blockquote", "children": children})
            elif token.type == "table_open":
                block, index = self._table(tokens, index)
                blocks.append(block)
            elif token.type in {"fence", "code_block"}:
                language = (
                    token.info.strip().split()[0].casefold() if token.info.strip() else "text"
                )
                if language == "mermaid":
                    blocks.append(_mermaid(token.content))
                else:
                    blocks.append(
                        {
                            "type": "code",
                            "language": language,
                            "segments": _highlight(token.content, language),
                            "source": token.content,
                        }
                    )
                index += 1
            elif token.type == "math_block":
                blocks.append({"type": "math", "display": True, "source": token.content})
                index += 1
            elif token.type == "hr":
                blocks.append({"type": "separator"})
                index += 1
            else:
                index += 1
        return blocks, index

    def _list(self, tokens: list[Token], index: int) -> tuple[dict[str, Any], int]:
        ordered = tokens[index].type == "ordered_list_open"
        start = int(tokens[index].attrGet("start") or 1)
        stop = "ordered_list_close" if ordered else "bullet_list_close"
        index += 1
        items = []
        while tokens[index].type != stop:
            if tokens[index].type != "list_item_open":
                index += 1
                continue
            children, index = self._blocks(tokens, index + 1, "list_item_close")
            checked = None
            if children and children[0]["type"] == "paragraph":
                text = _plain(children[0]["children"])
                match = re.match(r"^\s*\[([ xX])\]\s+", text)
                if match:
                    checked = match.group(1).casefold() == "x"
                    _trim_inline_prefix(children[0]["children"], match.end())
            items.append({"checked": checked, "children": children})
        return {"type": "list", "ordered": ordered, "start": start, "items": items}, index + 1

    def _table(self, tokens: list[Token], index: int) -> tuple[dict[str, Any], int]:
        headers: list[list[dict[str, Any]]] = []
        rows: list[list[list[dict[str, Any]]]] = []
        current: list[list[dict[str, Any]]] | None = None
        in_header = False
        index += 1
        while tokens[index].type != "table_close":
            token = tokens[index]
            if token.type == "thead_open":
                in_header = True
            elif token.type == "thead_close":
                in_header = False
            elif token.type == "tr_open":
                current = []
            elif token.type == "tr_close" and current is not None:
                if in_header:
                    headers = current
                else:
                    rows.append(current)
                current = None
            elif token.type in {"th_open", "td_open"} and current is not None:
                current.append(self._inline(tokens[index + 1].children or []))
                index += 2
            index += 1
        return {"type": "table", "headers": headers, "rows": rows}, index + 1

    def _inline(self, tokens: list[Token]) -> list[dict[str, Any]]:
        root: list[dict[str, Any]] = []
        stack = [root]
        for token in tokens:
            if token.type == "text":
                stack[-1].append({"type": "text", "text": token.content})
            elif token.type == "code_inline":
                if re.fullmatch(r"claim:[0-9a-f]{64}", token.content):
                    stack[-1].append({"type": "claim", "claim_id": token.content})
                else:
                    stack[-1].append({"type": "code", "text": token.content})
            elif token.type in {"softbreak", "hardbreak"}:
                stack[-1].append({"type": "break"})
            elif token.type == "math_inline":
                stack[-1].append({"type": "math", "source": token.content})
            elif token.type in {"strong_open", "em_open", "s_open"}:
                node = {"type": token.type.removesuffix("_open"), "children": []}
                stack[-1].append(node)
                stack.append(node["children"])
            elif token.type in {"strong_close", "em_close", "s_close"}:
                if len(stack) > 1:
                    stack.pop()
            elif token.type == "link_open":
                href = str(token.attrGet("href") or "")
                link = self._link(href)
                if link is None:
                    stack.append(stack[-1])
                else:
                    node = {"type": "link", **link, "children": []}
                    stack[-1].append(node)
                    stack.append(node["children"])
            elif token.type == "link_close":
                if len(stack) > 1:
                    stack.pop()
            elif token.type == "image":
                image = self._image(str(token.attrGet("src") or ""), token.content)
                if image:
                    stack[-1].append(image)
            elif token.type == "html_inline":
                self._diagnostic("Raw HTML was omitted.")
        return root

    def _link(self, href: str) -> dict[str, Any] | None:
        parts = urlsplit(href)
        if parts.scheme.casefold() in {"http", "https", "mailto"} and not parts.netloc.startswith(
            "."
        ):
            return {
                "href": href,
                "external": True,
                "page": None,
                "fragment": parts.fragment or None,
            }
        if parts.scheme or parts.netloc:
            self._diagnostic(f"Unsafe URL was omitted: {href}")
            return None
        target = _internal_target(self.page, href)
        if target is None:
            return {
                "href": href,
                "external": False,
                "page": self.page,
                "fragment": parts.fragment or None,
            }
        try:
            self._target_exists(target)
        except ValueError:
            self._diagnostic(f"Broken internal link: {href}")
        return {"href": href, "external": False, "page": target, "fragment": parts.fragment or None}

    def _image(self, source: str, alt: str) -> dict[str, Any] | None:
        parts = urlsplit(source)
        target = _internal_target(self.page, source)
        if parts.scheme or parts.netloc or target is None:
            self._diagnostic(f"Unsafe image URL was omitted: {source}")
            return None
        asset = self.root / target
        try:
            resolved = asset.resolve()
            resolved.relative_to(self.root)
            if asset.is_symlink() or not asset.is_file():
                raise ValueError
            data = asset.read_bytes()
        except OSError, ValueError:
            self._diagnostic(f"Broken image was omitted: {source}")
            return None
        mime = mimetypes.guess_type(asset.name)[0]
        if mime not in SAFE_IMAGE_TYPES or len(data) > MAX_BUNDLE_ASSET_BYTES:
            self._diagnostic(f"Unsupported image was omitted: {source}")
            return None
        encoded = base64.b64encode(data).decode()
        return {"type": "image", "alt": alt, "source": f"data:{mime};base64,{encoded}"}

    def _target_exists(self, path: str) -> None:
        target = self.root / path
        if target.is_symlink() or not target.is_file():
            raise ValueError
        target.resolve().relative_to(self.root)

    def _slug(self, text: str) -> str:
        base = re.sub(r"[^a-z0-9]+", "-", text.casefold()).strip("-") or "section"
        count = self._heading_ids.get(base, 0)
        self._heading_ids[base] = count + 1
        return base if count == 0 else f"{base}-{count + 1}"

    def _diagnostic(self, message: str) -> None:
        if message not in self.diagnostics:
            self.diagnostics.append(message)


def _looks_like_raw_html(text: str) -> bool:
    return bool(re.search(r"<\s*/?\s*[A-Za-z!][^>]*>", text))


def _internal_target(page: str, href: str) -> str | None:
    parts = urlsplit(href)
    path = unquote(parts.path)
    if not path:
        return None
    normalized = posixpath.normpath(posixpath.join(posixpath.dirname(page), path))
    if normalized == ".." or normalized.startswith("../") or normalized.startswith("/"):
        return None
    return normalized


def _plain(nodes: list[dict[str, Any]]) -> str:
    return "".join(
        node.get("text", "")
        if node["type"] in {"text", "code"}
        else "\n"
        if node["type"] == "break"
        else _plain(node.get("children", []))
        for node in nodes
    )


def _trim_inline_prefix(nodes: list[dict[str, Any]], count: int) -> None:
    for node in nodes:
        if node["type"] == "text":
            removed = min(count, len(node["text"]))
            node["text"] = node["text"][removed:]
            count -= removed
        elif "children" in node:
            before = len(_plain(node["children"]))
            _trim_inline_prefix(node["children"], count)
            count -= min(count, before)
        if count == 0:
            return


def _highlight(source: str, language: str) -> list[dict[str, str]]:
    try:
        lexer = get_lexer_by_name(language, stripall=False)
    except Exception:
        lexer = TextLexer(stripall=False)
    segments = []
    for token_type, text in lex(source, lexer):
        if not text:
            continue
        category = "text"
        for name, token in (
            ("comment", PygmentsToken.Comment),
            ("keyword", PygmentsToken.Keyword),
            ("name", PygmentsToken.Name),
            ("number", PygmentsToken.Number),
            ("operator", PygmentsToken.Operator),
            ("string", PygmentsToken.String),
        ):
            if token_type in token:
                category = name
                break
        segments.append({"kind": category, "text": text})
    return segments


def _mermaid(source: str) -> dict[str, Any]:
    lines = [
        line.strip()
        for line in source.splitlines()
        if line.strip() and not line.lstrip().startswith("%%")
    ]
    if not lines:
        return {
            "type": "mermaid",
            "direction": "LR",
            "nodes": [],
            "edges": [],
            "source": source,
            "error": "Empty Mermaid diagram",
        }
    header = re.fullmatch(r"(?:flowchart|graph)\s+(TB|TD|BT|RL|LR)", lines[0], re.IGNORECASE)
    if header is None:
        return {
            "type": "mermaid",
            "direction": "LR",
            "nodes": [],
            "edges": [],
            "source": source,
            "error": "Only Mermaid flowchart diagrams are supported",
        }
    nodes: dict[str, str] = {}
    edges = []
    if len(lines) - 1 > MAX_MERMAID_EDGES:
        return {
            "type": "mermaid",
            "direction": header.group(1).upper(),
            "nodes": [],
            "edges": [],
            "source": source,
            "error": "Mermaid flowchart exceeds the safe edge limit",
        }
    for line in lines[1:]:
        match = MERMAID_EDGE_RE.fullmatch(line)
        if (
            match is None
            or _looks_like_raw_html(line)
            or any(
                value in line.casefold() for value in ("click", "javascript:", "http:", "https:")
            )
        ):
            return {
                "type": "mermaid",
                "direction": header.group(1).upper(),
                "nodes": [],
                "edges": [],
                "source": source,
                "error": "Mermaid statement is outside the safe flowchart subset",
            }
        left = MERMAID_NODE_RE.fullmatch(match.group(1))
        right = MERMAID_NODE_RE.fullmatch(match.group(3))
        if left is None or right is None:
            return {
                "type": "mermaid",
                "direction": header.group(1).upper(),
                "nodes": [],
                "edges": [],
                "source": source,
                "error": "Mermaid statement is outside the safe flowchart subset",
            }
        values = [
            left.group("id"),
            left.group("square") or left.group("round") or left.group("brace") or "",
            right.group("id"),
            right.group("square") or right.group("round") or right.group("brace") or "",
            match.group(2) or "",
        ]
        if any(len(value) > MAX_MERMAID_LABEL_CHARS for value in values):
            return {
                "type": "mermaid",
                "direction": header.group(1).upper(),
                "nodes": [],
                "edges": [],
                "source": source,
                "error": "Mermaid flowchart label exceeds the safe length limit",
            }
        for node in (left, right):
            nodes[node.group("id")] = (
                node.group("square")
                or node.group("round")
                or node.group("brace")
                or node.group("id")
            )
        edges.append({"from": left.group("id"), "to": right.group("id"), "label": match.group(2)})
        if len(nodes) > MAX_MERMAID_NODES:
            return {
                "type": "mermaid",
                "direction": header.group(1).upper(),
                "nodes": [],
                "edges": [],
                "source": source,
                "error": "Mermaid flowchart exceeds the safe node limit",
            }
    return {
        "type": "mermaid",
        "direction": header.group(1).upper(),
        "nodes": [{"id": key, "label": value} for key, value in nodes.items()],
        "edges": edges,
        "source": source,
        "error": None,
    }
