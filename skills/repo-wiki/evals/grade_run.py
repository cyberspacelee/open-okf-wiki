#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML>=6,<7"]
# ///
"""Outcome grader for a published artifact-loop run."""

import argparse
import hashlib
import json
import pathlib
import random
import re
import subprocess
import sys

SKILL = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL / "scripts"))

from _frontmatter import parse_file
from _markdown import extract

CITE = re.compile(
    r"^\s*resource:\s*\"?([A-Za-z0-9][A-Za-z0-9-]*/[^\s#\"]+)"
    r"(?:#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?)?\"?\s*$",
    re.MULTILINE,
)

KILLBILL_INTENTS = {
    "account-context": (r"account|账户",),
    "tenant-context": (r"tenant|租户",),
    "currency-boundary": (r"currency|币种|货币",),
    "catalog-product-plan-phase": (
        r"catalog|目录",
        r"product|产品",
        r"\bplan\b|方案",
        r"phase|阶段",
    ),
    "subscription-entitlement": (r"subscription|订阅", r"entitlement|权益"),
    "usage-capture-rollup": (
        r"usage|用量",
        r"raw|capture|record|采集|记录",
        r"roll(?:ed)?[-_ ]?up|聚合|汇总",
    ),
    "invoice-generation-commit": (
        r"invoice|发票",
        r"generat|开票|生成",
        r"commit|persist|提交|落盘|持久",
    ),
    "payment-retry-recovery": (
        r"payment|支付",
        r"retri|recover|repair|重试|恢复|修复",
    ),
    "overdue-blocking-feedback": (
        r"overdue|dunning|逾期|催收",
        r"block|lock|阻断|阻塞|锁",
        r"feedback|clear|恢复|反馈|解除",
    ),
    "public-internal-plugin": (
        r"public|external|公开|公共|外部",
        r"internal|内部",
        r"\bapis?\b|接口",
        r"plugin|插件|spi",
    ),
    "durable-event-delivery": (
        r"queue|bus|队列|事件总线",
        r"persist|durable|持久",
        r"retr(?:y|ies)|deliver|重试|投递",
    ),
    "runtime-lifecycle-osgi": (
        r"lifecycle|生命周期",
        r"osgi|runtime|bootstrap|运行时|启动",
    ),
    "persistence-locking": (
        r"database|jdbc|jdbi|embeddeddb|persist|数据库|持久",
        r"lock|transaction|锁|事务",
    ),
}


def matches(record: str, patterns: tuple[str, ...]) -> bool:
    return all(re.search(pattern, record, re.IGNORECASE) for pattern in patterns)


def has_open_issues(report: dict) -> bool:
    return any(item.get("status") == "open" for item in report.get("issues", []))


def scope_has_seed(scope: dict, seeds: list[str], catalogs: list[dict]) -> bool:
    source = scope.get("source")
    paths = set(scope.get("paths", []))
    for seed in seeds:
        if str(seed).startswith(f"{source}/"):
            return True
        for catalog in catalogs:
            if catalog.get("name") != source:
                continue
            if seed == catalog.get("resource") and "." in paths:
                return True
            for table in catalog.get("tables", []):
                if seed == table.get("resource") and (
                    "." in paths
                    or table.get("name") in paths
                    or table.get("page_slug") in paths
                ):
                    return True
    return False


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def frontmatter(path: pathlib.Path) -> dict:
    parsed = parse_file(path)
    if parsed.errors:
        raise ValueError(f"invalid frontmatter in {path}: {'; '.join(parsed.errors)}")
    return parsed.meta


def plan_subject_digest(plan: pathlib.Path, state: dict) -> str:
    payload = {
        "plan": hashlib.sha256(plan.read_bytes()).hexdigest(),
        "revisions": state["revisions"],
        "catalogs": [
            {"name": item["name"], "content_hash": item["content_hash"]}
            for item in state["catalogs"]
        ],
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def composition_subject_digest(
    plan: pathlib.Path,
    plan_review: pathlib.Path,
    composition: pathlib.Path,
    state: dict,
) -> str:
    payload = {
        "plan_subject_digest": plan_subject_digest(plan, state),
        "plan_review": hashlib.sha256(plan_review.read_bytes()).hexdigest(),
        "composition": hashlib.sha256(composition.read_bytes()).hexdigest(),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


_TERMINAL_AGENT_STATES = {
    "completed",
    "failed",
    "canceled",
    "cancelled",
    "errored",
    "interrupted",
    "shutdown",
}


def trace_data(path: pathlib.Path) -> tuple[int, list[dict], list[str], dict]:
    parsed = 0
    commands = []
    spawn_prompts = []
    active_agents: set[str] = set()
    stats = {
        "peak_active": 0,
        "unique_children": 0,
        "max_depth": 0,
        "failed_spawns": 0,
        "rolling_refill_observed": False,
    }
    children: set[str] = set()
    depths: dict[str, int] = {}
    terminal_seen = False
    if not path.is_file():
        return parsed, commands, spawn_prompts, stats
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed += 1
        item = event.get("item", event)
        if (
            item.get("type") == "command_execution"
            and item.get("exit_code") is not None
        ):
            commands.append(item)
        elif item.get("type") == "tool_use" and item.get("name") == "Bash":
            command = item.get("input", {}).get("command")
            if command:
                commands.append(
                    {"command": command, "exit_code": item.get("exit_code", 0)}
                )
        elif event.get("type") == "item.completed" and item.get("type") == (
            "collab_tool_call"
        ):
            states = item.get("agents_states", {})
            for thread_id, state in states.items():
                if state.get("status") in _TERMINAL_AGENT_STATES:
                    terminal_seen = terminal_seen or thread_id in active_agents
                    active_agents.discard(thread_id)
            if item.get("tool") == "spawn_agent":
                receivers = item.get("receiver_thread_ids") or []
                if not receivers:
                    stats["failed_spawns"] += 1
                    continue
                spawn_prompts.append(item.get("prompt", ""))
                if terminal_seen and active_agents:
                    stats["rolling_refill_observed"] = True
                parent = item.get("sender_thread_id")
                parent_depth = depths.get(parent, 0)
                for thread_id in receivers:
                    children.add(thread_id)
                    depths[thread_id] = parent_depth + 1
                active_agents.update(receivers)
                stats["peak_active"] = max(stats["peak_active"], len(active_agents))
                stats["max_depth"] = max(
                    stats["max_depth"], *(depths[thread_id] for thread_id in receivers)
                )
    stats["unique_children"] = len(children)
    return parsed, commands, spawn_prompts, stats


def concurrency_metadata_valid(metadata: dict, requested_cap: int) -> bool:
    enforcement = metadata.get("concurrency_enforcement")
    host_cap = metadata.get("host_max_active_children")
    effective_cap = metadata.get("effective_max_active_children")
    if (
        not isinstance(effective_cap, int)
        or isinstance(effective_cap, bool)
        or effective_cap <= 0
    ):
        return False
    if enforcement == "host-native":
        return (
            isinstance(host_cap, int)
            and not isinstance(host_cap, bool)
            and host_cap > 0
            and effective_cap == min(requested_cap, host_cap)
        )
    return (
        enforcement == "coordinator"
        and host_cap is None
        and effective_cap == requested_cap
    )


def grade(ws: pathlib.Path, scenario: str) -> list[dict]:
    results = []

    def check(name: str, passed: bool, evidence: str) -> None:
        results.append({"text": name, "passed": bool(passed), "evidence": evidence})

    pointer = load(ws / ".okf-wiki/publication/current.json")
    bundle = ws / ".okf-wiki/publication/generations" / pointer["generation"]
    manifest = load(bundle / ".okf-manifest.json")
    run_dir = ws / ".okf-wiki/runs" / manifest["run_id"]
    state = load(run_dir / "state.json")
    work = run_dir / "work"
    trace_path = ws / "host-run.log"
    trace_text = trace_path.read_text(encoding="utf-8", errors="replace")
    parsed_events, commands, spawn_prompts, trace_agents = trace_data(trace_path)

    check(
        "Run uses the artifact-loop contract without scheduler state",
        state.get("contract") == "artifact-loop-routing-closure"
        and manifest.get("policy") == state.get("policy")
        and manifest.get("skill_bundle_digest") == state.get("skill_bundle_digest")
        and not any(
            key in state
            for key in ("targets", "tasks", "producer_session", "review_rounds")
        ),
        f"contract={state.get('contract')}, policy={state.get('policy')}, "
        f"keys={sorted(state)}",
    )

    plan = frontmatter(work / "plan.md")
    units = plan.get("units", [])
    scope_closed = all(
        all(
            scope.get("role")
            in {"owner", "producer", "contract", "consumer", "feedback"}
            and scope_has_seed(
                scope, unit.get("evidence_seeds", []), state.get("catalogs", [])
            )
            for scope in unit.get("scopes", [])
        )
        and (
            unit.get("kind") != "integration"
            or {scope.get("role") for scope in unit.get("scopes", [])}
            >= {"producer", "consumer"}
        )
        for unit in units
    )
    check(
        "one living Knowledge Plan owns semantic units without page bindings",
        plan.get("kind") == "knowledge-plan"
        and isinstance(units, list)
        and (bool(units) or bool(plan.get("gaps")))
        and all(
            "id" in unit and "path" not in unit and "owner" not in unit
            for unit in units
        )
        and scope_closed,
        f"units={len(units)}",
    )
    plan_review_path = work / "plan-review.json"
    plan_review = load(plan_review_path) if plan_review_path.is_file() else {}
    probed_units = {
        unit_id
        for probe in plan_review.get("merge_probes", [])
        for unit_id in probe.get("unit_ids", [])
    }
    check(
        "independent Plan review approved semantic recall before Composition",
        plan_review.get("verdict") == "approved"
        and not has_open_issues(plan_review)
        and (len(units) < 2 or probed_units == {unit["id"] for unit in units})
        and plan_review.get("subject_digest")
        == plan_subject_digest(work / "plan.md", state),
        f"verdict={plan_review.get('verdict')}",
    )
    if scenario == "killbill":
        unit_records = [
            " ".join(str(unit.get(field, "")) for field in ("id", "kind", "question"))
            for unit in units
        ]
        semantic_records = unit_records + [str(gap) for gap in plan.get("gaps", [])]
        missing_topics = [
            name
            for name, patterns in KILLBILL_INTENTS.items()
            if not any(matches(record, patterns) for record in unit_records)
        ]
        causal_bridge = (
            r"invoice|发票",
            r"payment|支付",
            r"overdue|dunning|逾期|催收",
        )
        if not any(matches(record, causal_bridge) for record in semantic_records):
            missing_topics.append("invoice-payment-overdue")
        check(
            "Kill Bill Plan routes the enterprise domain rubric and preserves its causal bridge",
            not missing_topics,
            f"missing={missing_topics}",
        )
    check(
        "long-run progress is one fixed living file",
        (work / "progress.md").is_file()
        and "repo-wiki-progress:initial"
        not in (work / "progress.md").read_text(encoding="utf-8")
        and not list(run_dir.rglob("*.checkpoint.md"))
        and not (run_dir / "attempts").exists(),
        str(work / "progress.md"),
    )

    composition = frontmatter(work / "composition.md")
    pages = {page["id"]: page for page in composition.get("pages", [])}
    mapped = [unit for page in pages.values() for unit in page.get("units", [])]
    unit_ids = {unit["id"] for unit in units}
    removed_fields = {"owner", "scopes", "evidence_seeds", "parent", "depends_on"}
    check(
        "Composition late-binds every unit exactly once without duplicate graphs",
        composition.get("kind") == "composition-map"
        and set(mapped) == unit_ids
        and len(mapped) == len(set(mapped))
        and all(not (removed_fields & set(page)) for page in pages.values()),
        f"units={len(unit_ids)}, pages={len(pages)}",
    )
    composition_review_path = work / "composition-review.json"
    composition_review = (
        load(composition_review_path) if composition_review_path.is_file() else {}
    )
    probed_pages = {
        page_id
        for probe in composition_review.get("merge_probes", [])
        for page_id in probe.get("page_ids", [])
    }
    check(
        "independent Composition review approves task routing before page fan-out",
        composition_review.get("verdict") == "approved"
        and not has_open_issues(composition_review)
        and (len(pages) < 2 or probed_pages == set(pages))
        and composition_review.get("subject_digest")
        == composition_subject_digest(
            work / "plan.md",
            plan_review_path,
            work / "composition.md",
            state,
        ),
        f"verdict={composition_review.get('verdict')}",
    )

    drafts = {path.stem for path in (work / "drafts").glob("*.md")}
    check(
        "fixed page drafts match stable Composition page IDs",
        drafts == set(pages),
        f"drafts={sorted(drafts)}, pages={sorted(pages)}",
    )
    candidate = run_dir / "candidate"
    check(
        "reviewed Candidate contains deterministic navigation indexes",
        (candidate / "index.md").is_file()
        and all(
            (candidate / path.parent / "index.md").is_file()
            for path in (pathlib.PurePosixPath(page["path"]) for page in pages.values())
        ),
        str(candidate),
    )

    review = load(work / "review.json")
    review_digest = hashlib.sha256((work / "review.json").read_bytes()).hexdigest()
    check(
        "one final Wiki review approved the exact bundle",
        review.get("verdict") == "approved"
        and review.get("subject_digest") == state.get("review_subject_digest")
        and review_digest == state.get("approved_review_digest"),
        f"verdict={review.get('verdict')}",
    )

    manifest_pages = manifest.get("pages", {})
    expected_paths = {page["path"] for page in pages.values()}
    check(
        "Publication paths and page IDs come from Composition",
        set(manifest_pages) == expected_paths
        and {item.get("page_id") for item in manifest_pages.values()} == set(pages)
        and all(
            item.get("review_digest") == review_digest
            for item in manifest_pages.values()
        ),
        f"manifest={len(manifest_pages)}, expected={len(expected_paths)}",
    )

    indexes = sorted((run_dir / "index").glob("*.md"))
    check(
        "each Revision has one bounded compact Source outline",
        len(indexes) == len(state["revisions"])
        and all(path.stat().st_size <= 64 * 1024 for path in indexes),
        f"indexes={len(indexes)}, revisions={len(state['revisions'])}",
    )

    concept_pages = sorted(
        path for path in bundle.rglob("*.md") if path.name not in ("index.md", "log.md")
    )
    ids = [frontmatter(path).get("id") for path in concept_pages]
    check(
        "published pages exactly match stable IDs and paths",
        len(concept_pages) == len(pages)
        and set(ids) == set(pages)
        and len(ids) == len(set(ids)),
        f"ids={ids}",
    )
    if scenario == "killbill":
        units_by_id = {unit["id"]: unit for unit in units}
        route_records = {
            page_id: " ".join(
                " ".join(
                    str(units_by_id.get(unit_id, {}).get(field, ""))
                    for field in ("id", "kind", "question")
                )
                for unit_id in page.get("units", [])
            )
            for page_id, page in pages.items()
        }
        routed_pages = set(pages)
        intent_owners = {
            name: [
                page_id
                for page_id in routed_pages
                if matches(route_records.get(page_id, ""), patterns)
            ]
            for name, patterns in KILLBILL_INTENTS.items()
        }
        missing_routes = [name for name, owners in intent_owners.items() if not owners]
        generic_roots = {
            "domain",
            "flow",
            "integration",
            "lifecycle",
            "procedure",
            "table",
        }
        generic_paths = [
            page["path"]
            for page in pages.values()
            if page.get("type") != "Overview"
            and pathlib.PurePosixPath(page["path"]).parts[0] in generic_roots
        ]
        check(
            "Kill Bill Composition distributes enterprise change intents into task routes",
            bool(pages) and not missing_routes and not generic_paths,
            f"pages={len(pages)}, missing={missing_routes}, "
            f"generic_paths={generic_paths}",
        )

        published_records = {}
        routing_metadata = {}
        for path in concept_pages:
            parsed = parse_file(path)
            page_id = parsed.meta.get("id")
            published_records[page_id] = " ".join(
                (
                    str(parsed.meta.get("title", "")),
                    str(parsed.meta.get("description", "")),
                    " ".join(str(tag) for tag in parsed.meta.get("tags", [])),
                    parsed.body,
                )
            )
            routing_metadata[page_id] = " ".join(
                (
                    str(parsed.meta.get("title", "")),
                    str(parsed.meta.get("description", "")),
                    " ".join(str(tag) for tag in parsed.meta.get("tags", [])),
                    str(pages.get(page_id, {}).get("path", "")),
                )
            )
        missing_page_coverage = [
            name
            for name, patterns in KILLBILL_INTENTS.items()
            if not any(
                matches(published_records.get(page_id, ""), patterns)
                for page_id in intent_owners[name]
            )
        ]
        missing_metadata_routes = [
            name
            for name, patterns in KILLBILL_INTENTS.items()
            if not any(
                matches(routing_metadata.get(page_id, ""), patterns)
                for page_id in intent_owners[name]
            )
        ]
        check(
            "published Kill Bill pages carry each routed intent in metadata and evidence-backed prose",
            not missing_page_coverage and not missing_metadata_routes,
            f"missing_page_coverage={missing_page_coverage}, "
            f"missing_metadata_routes={missing_metadata_routes}",
        )
    if state.get("language") == "zh":
        unlocalized = []
        english_template_headings = {
            section.title
            for template in (SKILL / "assets/templates/en").glob("*.md")
            for section in extract(parse_file(template).body).sections
        }
        for path in concept_pages:
            parsed = parse_file(path)
            meta = parsed.meta
            visible_fields = (
                str(meta.get("title", "")),
                str(meta.get("description", "")),
                parsed.body,
            )
            headings = {section.title for section in extract(parsed.body).sections}
            if (
                any(
                    not re.search(r"[\u3400-\u9fff]", field) for field in visible_fields
                )
                or headings & english_template_headings
            ):
                unlocalized.append(path.name)
        check(
            "published reader-visible metadata and prose match workspace language",
            not unlocalized,
            f"language=zh, unlocalized={unlocalized}",
        )

    runtime_skill = SKILL
    metadata_path = ws / "live-eval.json"
    metadata = {}
    if metadata_path.is_file():
        metadata = load(metadata_path)
        candidate = pathlib.Path(metadata.get("runtime_skill", ""))
        if (candidate / "scripts/okf.py").is_file():
            runtime_skill = candidate
    requested_cap = state["policy"]["agents"]["max_active_children"]
    check(
        "live adapter records concurrency enforcement",
        metadata.get("run_policy") == state["policy"]
        and concurrency_metadata_valid(metadata, requested_cap),
        f"adapter={metadata.get('host_adapter')}, "
        f"enforcement={metadata.get('concurrency_enforcement')}, "
        f"host_cap={metadata.get('host_max_active_children')}, "
        f"effective={metadata.get('effective_max_active_children')}, "
        f"requested={requested_cap}",
    )
    validation = subprocess.run(
        [
            "uv",
            "run",
            str(runtime_skill / "scripts/okf.py"),
            "validate",
            "--published",
            "--json",
        ],
        cwd=ws,
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        validation_data = json.loads(validation.stdout)
        errors = validation_data["errors"]
    except (json.JSONDecodeError, KeyError):
        validation_data = {}
        errors = -1
    check(
        "published validation is complete with zero errors",
        validation.returncode == 0
        and validation_data.get("complete") is True
        and errors == 0,
        f"complete={validation_data.get('complete')}, errors={errors}",
    )

    revisions = {item["name"]: item for item in state["revisions"]}
    workspace = load(ws / "workspace.json")
    source_paths = {
        item["name"]: ws.joinpath(*pathlib.PurePosixPath(item["path"]).parts)
        for item in workspace["sources"]
        if item["kind"] == "git"
    }
    citations = [
        (page, match)
        for page in concept_pages
        for match in CITE.finditer(page.read_text(encoding="utf-8"))
    ]
    random.Random(0).shuffle(citations)
    bad_citations = []
    for page, match in citations[:12]:
        locator, lo, hi = match.groups()
        source_name, _, rel = locator.partition("/")
        revision = revisions.get(source_name)
        source_path = source_paths.get(source_name)
        content = (
            subprocess.run(
                ["git", "-C", str(source_path), "show", f"{revision['commit']}:{rel}"],
                capture_output=True,
                text=True,
                check=False,
            )
            if source_path and revision
            else None
        )
        upper = int(hi or lo or 0)
        if (
            content is None
            or content.returncode
            or (upper and upper > len(content.stdout.splitlines()))
        ):
            bad_citations.append(f"{page.name}: {locator}")
    check(
        "sampled Revision Locators resolve",
        bool(citations) and not bad_citations,
        f"checked={min(12, len(citations))}, bad={bad_citations}",
    )

    bad_commands = [
        item.get("command", "")
        for item in commands
        if "state.json" in item.get("command", "")
        or re.search(r"/scripts/_[A-Za-z0-9_]+\.py\b", item.get("command", ""))
        or re.search(
            r"\.okf-wiki/runs/[^\s'\"]+/index(?:/|\b)",
            item.get("command", ""),
        )
        or re.search(
            r"\btask\s+(?:start|packet|checkpoint|complete)\b", item.get("command", "")
        )
        or "--session" in item.get("command", "")
        or "--producer" in item.get("command", "")
    ]
    source_roots = [
        ws.joinpath(*pathlib.PurePosixPath(item["path"]).parts)
        for item in workspace["sources"]
        if item["kind"] in ("git", "files")
    ]
    direct_source_commands = []
    for item in commands:
        command = item.get("command", "")
        scans_workspace = bool(
            re.search(r"\bfind\s+\.\s", command)
            or (
                re.search(r"\brg\s+--files\b", command)
                and str(runtime_skill / "assets" / "templates") not in command
            )
        )
        reads_source = any(
            str(source) in command
            or re.search(rf"(?<![A-Za-z0-9_.-]){re.escape(source.name)}/", command)
            for source in source_roots
        )
        uses_reader = bool(
            re.search(r"\b(?:cat|find|grep|head|rg|sed|tail|awk)\b", command)
        )
        if scans_workspace or (reads_source and uses_reader):
            direct_source_commands.append(command)
    bad_commands.extend(direct_source_commands)
    plan_review_command = next(
        (
            index
            for index, item in enumerate(commands)
            if re.search(r"\breview\s+plan\b", item.get("command", ""))
        ),
        len(commands),
    )
    late_references = (
        "references/composition.md",
        "references/composition-review.md",
        "references/page.md",
        "references/review.md",
    )
    bad_commands.extend(
        item.get("command", "")
        for item in commands[:plan_review_command]
        if any(reference in item.get("command", "") for reference in late_references)
    )
    composition_review_command = next(
        (
            index
            for index, item in enumerate(commands)
            if re.search(r"\breview\s+composition\b", item.get("command", ""))
        ),
        len(commands),
    )
    bad_commands.extend(
        item.get("command", "")
        for item in commands[:composition_review_command]
        if any(
            reference in item.get("command", "")
            for reference in ("references/page.md", "references/review.md")
        )
    )
    check(
        "host trace uses the artifact loop without execution IDs",
        parsed_events > 0 and not bad_commands,
        f"events={parsed_events}, bad={bad_commands[:3]}",
    )
    if scenario == "killbill":
        role_counts = {
            role: 0 for role in ("evidence", "plan-review", "page", "bundle-review")
        }
        role_prompts = {role: [] for role in role_counts}
        for prompt in spawn_prompts:
            if "plan-review.json" in prompt or "Knowledge Plan Review" in prompt:
                role = "plan-review"
            elif "review.json" in prompt and "candidate" in prompt.lower():
                role = "bundle-review"
            elif "/work/drafts/" in prompt or "page writer" in prompt.lower():
                role = "page"
            elif "/work/evidence/" in prompt or "evidence worker" in prompt.lower():
                role = "evidence"
            else:
                continue
            role_counts[role] += 1
            role_prompts[role].append(prompt)
        expected_roles = {"evidence", "plan-review", "page", "bundle-review"}
        check(
            "trace contains focused workers for each independent role",
            all(role_counts[role] for role in expected_roles),
            f"spawns={len(spawn_prompts)}, roles={role_counts}",
        )
        check(
            "trace obtains Composition approval before page work",
            composition_review_command < len(commands),
            f"review_composition_command={composition_review_command}",
        )
        check(
            "review and page repairs use original agents or bounded follow-up replacements",
            role_counts["plan-review"] <= 2
            and role_counts["bundle-review"] <= 2
            and role_counts["page"] <= 2 * len(pages)
            and all(
                re.search(
                    r"follow-up|repair|replacement|修复|复审", prompt, re.IGNORECASE
                )
                for role in ("plan-review", "bundle-review")
                for prompt in role_prompts[role][1:]
            )
            and all(
                re.search(
                    r"follow-up|repair|replacement|修复|复审", prompt, re.IGNORECASE
                )
                for prompt in role_prompts["page"][len(pages) :]
            ),
            f"roles={role_counts}, pages={len(pages)}",
        )
        status_calls = sum(
            bool(re.search(r"\brun\s+status\b", item.get("command", "")))
            for item in commands
        )
        output_chars = sum(len(item.get("aggregated_output", "")) for item in commands)
        nonzero = sum(item.get("exit_code", 0) != 0 for item in commands)
        help_calls = sum("--help" in item.get("command", "") for item in commands)
        router_errors = trace_text.count("ERROR codex_core::tools::router")
        concurrency_errors = len(
            re.findall(
                r"Concurrency limit exceeded|agent thread limit reached",
                trace_text,
                re.IGNORECASE,
            )
        )
        check(
            "trace stays within navigation and recovery budgets",
            output_chars <= 512 * 1024
            and nonzero + router_errors <= 12
            and help_calls <= 3
            and concurrency_errors == 0,
            f"status={status_calls}, output_chars={output_chars}, nonzero={nonzero}, "
            f"router_errors={router_errors}, help={help_calls}, "
            f"concurrency_errors={concurrency_errors}",
        )
        agent_policy = state["policy"]["agents"]
        check(
            "trace keeps subagent fan-out within the Run policy",
            trace_agents["peak_active"] <= agent_policy["max_active_children"]
            and trace_agents["max_depth"] <= agent_policy["max_spawn_depth"]
            and trace_agents["unique_children"] <= agent_policy["max_children_per_run"]
            and trace_agents["failed_spawns"] == 0,
            f"trace_agents={trace_agents}, policy={agent_policy}",
        )
        if trace_agents["unique_children"] > agent_policy["max_active_children"]:
            check(
                "subagent dispatch refills a rolling window",
                trace_agents["rolling_refill_observed"],
                f"trace_agents={trace_agents}",
            )

    root_index = (bundle / "index.md").read_text(encoding="utf-8")
    log = (bundle / "log.md").read_text(encoding="utf-8")
    trust_missing = [
        path.name
        for path in concept_pages
        if not all(
            token in path.read_text(encoding="utf-8")
            for token in ("generated:", "verified:", "status: stable", "stale_after:")
        )
    ]
    check(
        "reserved files and review trust fields conform",
        root_index.startswith('---\nokf_version: "0.2"\n---\n')
        and re.search(r"^## \d{4}-\d{2}-\d{2}$", log, re.MULTILINE)
        and not trust_missing,
        f"trust_missing={trust_missing}",
    )
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=pathlib.Path)
    parser.add_argument("--scenario", choices=("killbill",), default="killbill")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        results = grade(args.workspace.resolve(), args.scenario)
    except (OSError, TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        results = [
            {
                "text": "run produced a readable Publication",
                "passed": False,
                "evidence": str(exc),
            }
        ]
    passed = all(item["passed"] for item in results)
    if args.json:
        print(
            json.dumps(
                {"passed": passed, "expectations": results},
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in results:
            print(
                f"[{'PASS' if item['passed'] else 'FAIL'}] {item['text']}: {item['evidence']}"
            )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
