import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

from markdown_it import MarkdownIt


ROOT = Path(__file__).parents[1]
PRODUCT_DOC_PATHS = (
    "README.md",
    "CONTEXT.md",
    ":(glob)docs/**/*.md",
    ":(glob)src/okf_wiki/producer_skill/**/*.md",
)


def test_product_documentation_has_no_broken_local_links() -> None:
    tracked = set(
        subprocess.run(
            ["git", "ls-files", "--"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
    )
    documents = subprocess.run(
        ["git", "ls-files", "--", *PRODUCT_DOC_PATHS],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    errors: list[str] = []
    parser = MarkdownIt()

    for relative in documents:
        document = ROOT / relative
        if not document.is_file():
            continue
        for block in parser.parse(document.read_text(encoding="utf-8")):
            for token in block.children or ():
                link = token.attrGet("href") if token.type == "link_open" else token.attrGet("src")
                if not isinstance(link, str) or not link:
                    continue
                parsed = urlsplit(link)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                target = (document.parent / unquote(parsed.path)).resolve()
                if not target.is_relative_to(ROOT):
                    errors.append(f"{relative}: link escapes the repository: {link}")
                    continue
                target_relative = target.relative_to(ROOT).as_posix()
                tracked_target = target_relative in tracked or any(
                    path.startswith(f"{target_relative}/") for path in tracked
                )
                if not target.exists() or not tracked_target:
                    errors.append(f"{relative}: missing tracked target: {link}")

    assert errors == []
