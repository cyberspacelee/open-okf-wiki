"""Write a starter Wiki Run YAML configuration."""

from __future__ import annotations

from pathlib import Path

from .security import git_read


def write_wiki_run_config(
    config_path: Path,
    *,
    directory: Path | None = None,
    source: Path | None = None,
    source_id: str = "application",
    branch: str | None = None,
    revision: str | None = None,
    model: str = "openai:gpt-5-mini",
    force: bool = False,
) -> Path:
    """Create a versioned Wiki Run YAML for the operator to edit and run.

    Paths inside the YAML are relative to the configuration file's directory.

    ``directory`` (optional) is the project root to initialize. When set, it is
    created if missing, and a relative ``config_path`` is resolved under that
    root (default ``wiki-run.yaml`` → ``<directory>/wiki-run.yaml``).
    """
    if branch is not None and revision is not None:
        raise ValueError("init accepts at most one of --branch or --revision")

    root = _resolve_init_directory(directory)
    target = _resolve_config_target(config_path, root=root)

    if target.exists() and target.is_dir():
        raise ValueError(f"configuration path is a directory: {target}")
    if target.exists() and not force:
        raise ValueError(f"configuration already exists (use --force to replace): {target}")

    target.parent.mkdir(parents=True, exist_ok=True)

    repo_block = _repository_block(
        root=target.parent,
        source=source,
        source_id=source_id,
        branch=branch,
        revision=revision,
    )
    body = f"""version: 1
operation: generate
# Model identity: provider:name (OpenAI-compatible gateways use openai:<served-model-name>).
# Or object form:
# model:
#   identity: openai:gpt-5-mini
#   max_tokens: 8192          # per-completion output cap (also OKF_WIKI_MAX_TOKENS)
#   temperature: 0.2
#   timeout: 120
model: {model}
# Paths are relative to this YAML file.
staging: .okf-wiki/staging
publication: .okf-wiki/wiki
# After a successful publication, write static HTML + link graph under publication/viz/.
write_visualization: false

# Non-secret settings only. API keys and base URLs stay in process environment or .env
# (OPENAI_API_KEY, OPENAI_BASE_URL for OpenAI-compatible endpoints).
repositories:
{repo_block}
# limits:  # omitted keys still take env defaults (OKF_WIKI_*) then product defaults
#   context_target_tokens: 100000   # compaction target / operational context budget
#   input_tokens_limit: 250000
#   output_tokens_limit: 100000
#   total_tokens_limit: 350000
#   request_timeout_seconds: 120
#   request_limit: 50
#   tool_calls_limit: 200
#   wall_clock_timeout_seconds: 600
"""
    target.write_text(body, encoding="utf-8")
    return target


def _resolve_init_directory(directory: Path | None) -> Path:
    if directory is None:
        return Path.cwd().resolve()
    root = directory.expanduser()
    if not root.is_absolute():
        root = (Path.cwd() / root).resolve()
    else:
        root = root.resolve()
    if root.exists() and not root.is_dir():
        raise ValueError(f"init directory exists and is not a directory: {root}")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _resolve_config_target(config_path: Path, *, root: Path) -> Path:
    target = config_path.expanduser()
    if target.is_absolute():
        return target.resolve()
    # Relative --config is always under the init directory (cwd when directory omitted).
    return (root / target).resolve()


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
