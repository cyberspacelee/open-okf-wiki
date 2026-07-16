"""Write a starter Wiki Run YAML configuration."""

from __future__ import annotations

from pathlib import Path

from .security import git_read


def write_wiki_run_config(
    config_path: Path,
    *,
    source: Path | None = None,
    source_id: str = "application",
    branch: str | None = None,
    revision: str | None = None,
    model: str = "openai:gpt-5-mini",
    force: bool = False,
) -> Path:
    """Create a versioned Wiki Run YAML for the operator to edit and run.

    Paths inside the YAML are relative to the configuration file's directory.
    """
    if branch is not None and revision is not None:
        raise ValueError("init accepts at most one of --branch or --revision")
    target = config_path.expanduser()
    if not target.is_absolute():
        target = (Path.cwd() / target).resolve()
    else:
        target = target.resolve()
    if target.exists() and not force:
        raise ValueError(f"configuration already exists (use --force to replace): {target}")
    if target.exists() and target.is_dir():
        raise ValueError(f"configuration path is a directory: {target}")

    root = target.parent
    root.mkdir(parents=True, exist_ok=True)

    repo_block = _repository_block(
        root=root,
        source=source,
        source_id=source_id,
        branch=branch,
        revision=revision,
    )
    body = f"""version: 1
operation: generate
model: {model}
# Paths are relative to this YAML file.
staging: .okf-wiki/staging
publication: .okf-wiki/wiki
# After a successful publication, write static HTML + link graph under publication/viz/.
write_visualization: false

# Non-secret settings only. Provider credentials stay in process environment or .env.
repositories:
{repo_block}
# limits:
#   request_limit: 50
#   tool_calls_limit: 200
#   total_tokens_limit: 350000
#   wall_clock_timeout_seconds: 600
"""
    target.write_text(body, encoding="utf-8")
    return target


def _repository_block(
    *,
    root: Path,
    source: Path | None,
    source_id: str,
    branch: str | None,
    revision: str | None,
) -> str:
    if source is None:
        return f"""  - id: {source_id}
    path: ../path/to/repository
    branch: main
    # Host Default Source Ignores (node_modules, dist, venv, …) apply when true.
    apply_default_source_ignores: true
    # Optional extra repository-relative fnmatch patterns (additive; never disable defaults).
    ignore: []
"""

    checkout = source.expanduser()
    if not checkout.is_absolute():
        checkout = (Path.cwd() / checkout).resolve()
    else:
        checkout = checkout.resolve()
    if not checkout.is_dir():
        raise ValueError(f"source path is not a directory: {checkout}")
    try:
        rel = checkout.relative_to(root)
        path_text = rel.as_posix() if str(rel) != "." else "."
    except ValueError:
        path_text = str(checkout)

    if revision is not None:
        ref_line = f"    revision: {revision}"
    else:
        selected_branch = branch
        if selected_branch is None:
            try:
                selected_branch = git_read(checkout, "rev-parse", "--abbrev-ref", "HEAD").strip()
            except Exception:
                selected_branch = "main"
            if selected_branch in {"", "HEAD"}:
                selected_branch = "main"
        ref_line = f"    branch: {selected_branch}"

    return f"""  - id: {source_id}
    path: {path_text}
{ref_line}
    apply_default_source_ignores: true
    ignore: []
"""
