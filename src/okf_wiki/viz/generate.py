"""Host-owned deterministic Wiki Visualization of a Published Wiki."""

from __future__ import annotations

import html
import json
import os
import posixpath
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt
from mdit_py_plugins.anchors import anchors_plugin

GENERATOR_VERSION = "1"
VISUALIZATION_DIR_NAME = "viz"
PUBLICATION_METADATA_NAME = ".okf-wiki.json"
_MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"

_MARKDOWN = MarkdownIt("commonmark", {"html": False}).use(anchors_plugin, min_level=1, max_level=6)
_FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)


@dataclass(frozen=True, slots=True)
class WikiVisualizationResult:
    """Filesystem result of generating a Wiki Visualization."""

    output_dir: Path
    index_path: Path
    graph_path: Path
    generator_version: str
    page_count: int
    edge_count: int


def generate_wiki_visualization(
    publication: Path,
    *,
    output: Path | None = None,
) -> WikiVisualizationResult:
    """Generate a deterministic static HTML Wiki Visualization from a Published Wiki.

    Does not call the model provider and does not mutate Published Wiki markdown pages.
    Artifacts default to ``<publication>/viz/`` (a reserved visualization directory).
    """
    root = _resolve_publication_root(publication)
    pages = _discover_pages(root)
    if not pages:
        raise ValueError("Published Wiki contains no markdown pages")

    nodes, edges, graph = _build_link_graph(root, pages)
    output_dir = (output if output is not None else root / VISUALIZATION_DIR_NAME).resolve()
    if output_dir.exists() and not output_dir.is_dir():
        raise ValueError(f"Wiki Visualization output must be a directory: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    graph_path = output_dir / "graph.json"
    index_path = output_dir / "index.html"
    graph_json = json.dumps(graph, indent=2, sort_keys=True) + "\n"
    graph_path.write_text(graph_json, encoding="utf-8")
    index_path.write_text(_render_index_html(root, pages, graph), encoding="utf-8")

    return WikiVisualizationResult(
        output_dir=output_dir,
        index_path=index_path,
        graph_path=graph_path,
        generator_version=GENERATOR_VERSION,
        page_count=len(nodes),
        edge_count=len(edges),
    )


def _resolve_publication_root(publication: Path) -> Path:
    if not publication.exists():
        raise ValueError(f"Published Wiki path does not exist: {publication}")
    try:
        root = publication.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"Published Wiki path is not readable: {publication}: {error}") from error
    if not root.is_dir():
        raise ValueError("Published Wiki path must name a directory")
    return root


def _is_visualization_path(relative_path: str) -> bool:
    return relative_path == VISUALIZATION_DIR_NAME or relative_path.startswith(
        f"{VISUALIZATION_DIR_NAME}/"
    )


def _discover_pages(root: Path) -> list[str]:
    pages: list[str] = []
    stack = [(root, PurePosixPath())]
    while stack:
        directory, prefix = stack.pop()
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError:
            continue
        for entry in entries:
            relative = prefix / entry.name
            relative_path = relative.as_posix()
            if _is_visualization_path(relative_path):
                continue
            if entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                stack.append((Path(entry.path), relative))
            elif entry.is_file(follow_symlinks=False) and relative.suffix == ".md":
                pages.append(relative_path)
    return sorted(pages)


def _read_page(root: Path, page: str) -> tuple[str, str]:
    text = root.joinpath(*PurePosixPath(page).parts).read_text(encoding="utf-8")
    match = _FRONTMATTER_RE.match(text)
    title = Path(page).stem
    body = text
    if match is not None:
        body = text[match.end() :]
        try:
            metadata = yaml.safe_load(match.group(1))
        except yaml.YAMLError:
            metadata = None
        if isinstance(metadata, dict):
            raw_title = metadata.get("title")
            if isinstance(raw_title, str) and raw_title.strip():
                title = raw_title.strip()
    return title, body


def _extract_link_targets(body: str) -> list[str]:
    tokens = _MARKDOWN.parse(body)
    targets: list[str] = []
    for token in tokens:
        for child in token.children or []:
            if child.type != "link_open":
                continue
            href = child.attrGet("href")
            if isinstance(href, str):
                targets.append(href)
    return targets


def _resolve_internal_link(page: str, target: str, pages: set[str]) -> tuple[str, bool] | None:
    """Resolve an internal wiki link the same way as publication validation.

    Returns ``(resolved_path, broken)`` for graph edges, or ``None`` when the target is not
    an internal page link (external URL, Source Citation, or non-.md path).
    """
    if target.startswith("repo:"):
        return None
    parsed = urlsplit(target)
    if parsed.scheme:
        return None
    if parsed.netloc or parsed.query:
        return None
    link_path = unquote(parsed.path)
    if not link_path and parsed.fragment:
        resolved = page
    elif not link_path or "\\" in link_path or not link_path.endswith(".md"):
        return None
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(page), link_path))
    if resolved == ".." or resolved.startswith("../") or resolved.startswith("/"):
        return None
    return resolved, resolved not in pages


def _build_link_graph(
    root: Path, pages: list[str]
) -> tuple[list[dict[str, object]], list[dict[str, object]], dict[str, object]]:
    page_set = set(pages)
    nodes: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    seen_edges: set[tuple[str, str, bool]] = set()

    for page in pages:
        title, body = _read_page(root, page)
        nodes.append({"id": page, "path": page, "title": title})
        for target in _extract_link_targets(body):
            resolved = _resolve_internal_link(page, target, page_set)
            if resolved is None:
                continue
            target_path, broken = resolved
            key = (page, target_path, broken)
            if key in seen_edges:
                continue
            seen_edges.add(key)
            edges.append(
                {
                    "source": page,
                    "target": target_path,
                    "href": target,
                    "broken": broken,
                }
            )

    nodes.sort(key=lambda node: str(node["id"]))
    edges.sort(key=lambda edge: (str(edge["source"]), str(edge["target"]), bool(edge["broken"])))
    graph: dict[str, object] = {
        "edges": edges,
        "generator_version": GENERATOR_VERSION,
        "nodes": nodes,
    }
    return nodes, edges, graph


def _render_markdown_html(body: str) -> str:
    rendered = _MARKDOWN.render(body)
    # Promote mermaid fences so mermaid.js can render them in the visualization layer.
    return re.sub(
        r'<pre><code class="language-mermaid">(.*?)</code></pre>',
        lambda match: f'<pre class="mermaid">{match.group(1)}</pre>',
        rendered,
        flags=re.DOTALL,
    )


def _render_index_html(root: Path, pages: list[str], graph: dict[str, object]) -> str:
    page_payload: list[dict[str, str]] = []
    for page in pages:
        title, body = _read_page(root, page)
        page_payload.append(
            {
                "id": page,
                "title": title,
                "html": _render_markdown_html(body),
            }
        )

    graph_json = json.dumps(graph, sort_keys=True, separators=(",", ":"))
    pages_json = json.dumps(page_payload, sort_keys=True, separators=(",", ":"))

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="generator" content="okf-wiki-visualization/{html.escape(GENERATOR_VERSION)}"/>
<title>Wiki Visualization</title>
<style>
:root {{
  color-scheme: light dark;
  --bg: #0f1419;
  --panel: #1a2332;
  --text: #e7ecf3;
  --muted: #9aa7b8;
  --accent: #6cb6ff;
  --broken: #ff7b72;
  --border: #2d3a4d;
  --edge: #5b6b7c;
}}
@media (prefers-color-scheme: light) {{
  :root {{
    --bg: #f6f8fb;
    --panel: #ffffff;
    --text: #1f2937;
    --muted: #5b6775;
    --accent: #0969da;
    --broken: #cf222e;
    --border: #d0d7de;
    --edge: #8c959f;
  }}
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  background: var(--bg);
  color: var(--text);
}}
header {{
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}}
header h1 {{
  margin: 0;
  font-size: 1.15rem;
}}
header p {{
  margin: 0.35rem 0 0;
  color: var(--muted);
  font-size: 0.9rem;
}}
main {{
  display: grid;
  grid-template-columns: minmax(240px, 320px) 1fr;
  min-height: calc(100vh - 5rem);
}}
aside {{
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 1rem;
  overflow: auto;
}}
section {{
  padding: 1rem 1.25rem 2rem;
  overflow: auto;
}}
h2 {{
  margin: 0 0 0.75rem;
  font-size: 1rem;
}}
#page-list {{
  list-style: none;
  margin: 0 0 1.25rem;
  padding: 0;
}}
#page-list button {{
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  padding: 0.45rem 0.55rem;
  border-radius: 0.4rem;
  cursor: pointer;
  font: inherit;
}}
#page-list button:hover,
#page-list button.active {{
  border-color: var(--border);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}}
#page-list .path {{
  display: block;
  color: var(--muted);
  font-size: 0.75rem;
}}
#graph {{
  width: 100%;
  height: 280px;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--panel) 80%, var(--bg));
}}
#graph text {{
  fill: var(--text);
  font-size: 11px;
}}
#content {{
  max-width: 52rem;
}}
#content a {{ color: var(--accent); }}
#content pre {{
  overflow: auto;
  padding: 0.85rem;
  border-radius: 0.45rem;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 70%, var(--bg));
}}
#content code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }}
#content pre.mermaid {{
  background: transparent;
  border-style: dashed;
}}
.legend {{
  margin-top: 0.75rem;
  color: var(--muted);
  font-size: 0.8rem;
}}
.legend .broken {{ color: var(--broken); }}
</style>
</head>
<body>
<header>
  <h1>Wiki Visualization</h1>
  <p>Read-only static presentation of a Published Wiki (generator {html.escape(GENERATOR_VERSION)}).</p>
</header>
<main>
  <aside>
    <h2>Pages</h2>
    <ul id="page-list"></ul>
    <h2>Link graph</h2>
    <svg id="graph" role="img" aria-label="Published Wiki link graph"></svg>
    <p class="legend">Solid edges are internal page links. <span class="broken">Dashed red</span> edges are broken targets.</p>
  </aside>
  <section>
    <article id="content"></article>
  </section>
</main>
<script type="application/json" id="graph-data">{html.escape(graph_json, quote=False)}</script>
<script type="application/json" id="pages-data">{html.escape(pages_json, quote=False)}</script>
<script src="{_MERMAID_CDN}"></script>
<script>
(function () {{
  const graph = JSON.parse(document.getElementById("graph-data").textContent);
  const pages = JSON.parse(document.getElementById("pages-data").textContent);
  const pageById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const list = document.getElementById("page-list");
  const content = document.getElementById("content");
  let active = pages[0] ? pages[0].id : null;

  function showPage(id) {{
    const page = pageById[id];
    if (!page) return;
    active = id;
    content.innerHTML = "<h1>" + escapeHtml(page.title) + "</h1>" + page.html;
    list.querySelectorAll("button").forEach((button) => {{
      button.classList.toggle("active", button.dataset.id === id);
    }});
    if (window.mermaid) {{
      window.mermaid.run({{ nodes: content.querySelectorAll("pre.mermaid") }});
    }}
  }}

  function escapeHtml(value) {{
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }}

  pages.forEach((page) => {{
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.id = page.id;
    button.innerHTML = "<strong>" + escapeHtml(page.title) + "</strong>"
      + '<span class="path">' + escapeHtml(page.id) + "</span>";
    button.addEventListener("click", () => showPage(page.id));
    item.appendChild(button);
    list.appendChild(item);
  }});

  function drawGraph() {{
    const svg = document.getElementById("graph");
    const width = svg.clientWidth || 300;
    const height = svg.clientHeight || 280;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const positions = {{}};
    const count = Math.max(nodes.length, 1);
    const radius = Math.min(width, height) * 0.36;
    const cx = width / 2;
    const cy = height / 2;
    nodes.forEach((node, index) => {{
      const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
      positions[node.id] = {{
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        title: node.title || node.id,
      }};
    }});

    edges.forEach((edge) => {{
      const source = positions[edge.source];
      if (!source) return;
      let target = positions[edge.target];
      if (!target) {{
        target = {{
          x: source.x + 48,
          y: source.y - 36,
          title: edge.target,
        }};
      }}
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
      line.setAttribute("stroke", edge.broken ? "var(--broken)" : "var(--edge)");
      line.setAttribute("stroke-width", edge.broken ? "1.5" : "1.25");
      if (edge.broken) line.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(line);
      if (edge.broken && !positions[edge.target]) {{
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", target.x);
        label.setAttribute("y", target.y - 6);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "var(--broken)");
        label.textContent = edge.target;
        svg.appendChild(label);
      }}
    }});

    nodes.forEach((node) => {{
      const pos = positions[node.id];
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", pos.x);
      circle.setAttribute("cy", pos.y);
      circle.setAttribute("r", "10");
      circle.setAttribute("fill", node.id === active ? "var(--accent)" : "var(--panel)");
      circle.setAttribute("stroke", "var(--accent)");
      circle.setAttribute("stroke-width", "2");
      circle.style.cursor = "pointer";
      circle.addEventListener("click", () => showPage(node.id));
      svg.appendChild(circle);
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", pos.x);
      label.setAttribute("y", pos.y + 24);
      label.setAttribute("text-anchor", "middle");
      label.textContent = pos.title;
      svg.appendChild(label);
    }});
  }}

  if (window.mermaid) {{
    window.mermaid.initialize({{ startOnLoad: false, securityLevel: "strict" }});
  }}
  if (active) showPage(active);
  drawGraph();
  window.addEventListener("resize", drawGraph);
}})();
</script>
</body>
</html>
"""
