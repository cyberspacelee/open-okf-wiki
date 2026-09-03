import hashlib
import pathlib
import re

import _db
from _frontmatter import parse_file
from _markdown import extract
from _models import CompositionMap, DiagramSpec, KnowledgePlan


_MARKER = "<!-- okf-generated:model -->"
_ROLES = (
    "entity",
    "association",
    "history",
    "reference",
    "read-model",
    "working",
    "infrastructure",
    "replica",
    "excluded",
)


def _stable_id(prefix: str, value: str) -> str:
    slug = re.sub(r"[^a-z0-9.-]+", "-", value.lower()).strip("-.") or "item"
    candidate = f"{prefix}-{slug}"
    if len(candidate) <= 64:
        return candidate
    digest = hashlib.sha256(value.encode()).hexdigest()[:10]
    return f"{candidate[:53].rstrip('-.')}-{digest}"


def _table_id(source: str, page_slug: str) -> str:
    return _stable_id("table", f"{source}-{page_slug}")


def _schema_id(source: str) -> str:
    return _stable_id("schema", source)


def _md(value) -> str:
    if value is None or value == "":
        return "-"
    if isinstance(value, (list, tuple)):
        value = ", ".join(str(item) for item in value)
    return str(value).replace("\n", " ").replace("|", "\\|")


def _code(value) -> str:
    return f"`{_md(value).replace('`', '')}`" if value not in (None, "") else "-"


def _page_by_unit(composition: CompositionMap) -> dict[str, object]:
    return {
        unit_id: page
        for page in composition.pages
        for unit_id in page.units
    }


def _catalogs(root: pathlib.Path, state: dict) -> dict[str, dict]:
    return {
        record["name"]: {
            **_db.load_index(root, record["storage_key"]),
            "storage_key": record["storage_key"],
        }
        for record in state.get("catalogs", [])
    }


def _source(source_id: str, resource: str) -> dict:
    return {"id": source_id, "resource": resource}


def _footnote(source_id: str, resource: str) -> str:
    return f"[^{source_id}]: `{resource}`"


def _render_template(language: str, name: str, values: dict[str, str]) -> str:
    path = (
        pathlib.Path(__file__).resolve().parent.parent
        / "assets/templates"
        / language
        / name
    )
    return parse_file(path).body.format(**values).rstrip()


def _source_map(
    catalog_resource: str, evidence: list[str]
) -> tuple[list[dict], dict[str, str]]:
    resources = list(dict.fromkeys([catalog_resource, *evidence]))
    ids = {catalog_resource: "catalog"}
    ids.update(
        {resource: f"evidence-{index}" for index, resource in enumerate(resources[1:], 1)}
    )
    return [_source(ids[resource], resource) for resource in resources], ids


def _refs(resources: list[str], source_ids: dict[str, str]) -> str:
    return "".join(f"[^{source_ids[resource]}]" for resource in dict.fromkeys(resources))


def _table_context(plan: KnowledgePlan, composition: CompositionMap):
    dispositions = {
        (item.source, item.table): item for item in plan.table_dispositions
    }
    domains = {item.id: item for item in plan.domains}
    concepts = {item.id: item for item in plan.concepts}
    pages = _page_by_unit(composition)
    return dispositions, domains, concepts, pages


def _logical_link(label: str, page) -> str:
    return f"[{label}][{page.id}]"


def _mapped_links(ids, records: dict, pages: dict, owner_field: str) -> str:
    links = []
    for item_id in ids:
        item = records.get(item_id)
        page = pages.get(getattr(item, owner_field)) if item is not None else None
        label = item.name if item is not None else item_id
        links.append(_logical_link(label, page) if page is not None else label)
    return ", ".join(links) or "-"


def _table_body(
    language: str,
    table: dict,
    disposition,
    domains: dict,
    concepts: dict,
    pages: dict,
    table_pages: dict,
    catalog_resource: str,
) -> tuple[str, list[dict]]:
    zh = language == "zh"
    sources, source_ids = _source_map(catalog_resource, disposition.evidence)
    citation = f"[^{source_ids[catalog_resource]}]"
    comment = table.get("comment") or ("无表注释。" if zh else "No table comment.")
    columns = [
        (
            "| 序号 | 字段 | 类型 | 可空 | 默认值 | 注释 |"
            if zh
            else "| # | Column | Type | Nullable | Default | Comment |"
        ),
        "|---:|---|---|:---:|---|---|",
    ]
    for column in table.get("columns", []):
        nullable = (
            "是"
            if zh and column.get("nullable")
            else "否"
            if zh
            else "yes"
            if column.get("nullable")
            else "no"
        )
        columns.append(
            "| {position} | {name} | {type} | {nullable} | {default} | {comment} |".format(
                position=column.get("position", "-"),
                name=_code(column.get("name")),
                type=_code(column.get("type")),
                nullable=nullable,
                default=_code(column.get("default")),
                comment=_md(column.get("comment")),
            )
        )

    constraints = table.get("constraints", [])
    if constraints:
        constraint_lines = [
            (
                "| 名称 | 类型 | 字段 | 引用 | 状态 | 定义 |"
                if zh
                else "| Name | Type | Columns | Reference | Status | Definition |"
            ),
            "|---|---|---|---|---|---|",
        ]
        for constraint in constraints:
            reference = "-"
            if constraint.get("type") == "foreign_key":
                reference = (
                    f"{constraint.get('ref_schema')}.{constraint.get('ref_table')}"
                    f" ({', '.join(constraint.get('ref_columns') or [])}); "
                    f"update={constraint.get('on_update')}, delete={constraint.get('on_delete')}"
                )
            status = ", ".join(
                [
                    f"validated={str(bool(constraint.get('validated'))).lower()}",
                    f"soft={str(bool(constraint.get('soft'))).lower()}",
                    f"optimized={str(bool(constraint.get('optimized'))).lower()}",
                ]
            )
            constraint_lines.append(
                f"| {_code(constraint.get('name'))} | {constraint.get('type')} | "
                f"{_code(constraint.get('columns') or [])} | {_md(reference)} | "
                f"{status} | {_code(constraint.get('definition'))} |"
            )
    else:
        constraint_lines = ["无数据库约束。" if zh else "No database constraints."]

    indexes = table.get("indexes", [])
    if indexes:
        storage = [
            (
                "| 索引 | 方法 | 键 | INCLUDE | 属性 | 条件 |"
                if zh
                else "| Index | Method | Keys | Include | Flags | Predicate |"
            ),
            "|---|---|---|---|---|---|",
        ]
        for index in indexes:
            flags = ", ".join(
                name
                for name in ("unique", "primary", "valid", "usable", "ready")
                if index.get(name)
            ) or "-"
            storage.append(
                f"| {_code(index.get('name'))} | {_code(index.get('method'))} | "
                f"{_code(index.get('keys') or [])} | {_code(index.get('include') or [])} | "
                f"{flags} | {_code(index.get('predicate'))} |"
            )
    else:
        storage = ["无索引。" if zh else "No indexes."]

    partitions = table.get("partitions", [])
    if partitions:
        storage.extend(
            [
                "",
                (
                    "| 分区 | 类型 | 策略 | 边界 | 表空间 |"
                    if zh
                    else "| Partition | Type | Strategy | Boundaries | Tablespace |"
                ),
                "|---|---|---|---|---|",
            ]
        )
        for partition in partitions:
            storage.append(
                f"| {_code(partition.get('name'))} | {_code(partition.get('type'))} | "
                f"{_code(partition.get('strategy'))} | {_code(partition.get('boundaries'))} | "
                f"{_code(partition.get('tablespace'))} |"
            )

    domain_ids = [disposition.domain_id] if disposition.domain_id else []
    ownership_refs = _refs(disposition.evidence, source_ids)
    ownership = [
        ("- 角色：" if zh else "- Role: ")
        + f"`{disposition.role}`{ownership_refs}",
        ("- Domain：" if zh else "- Domain: ")
        + _mapped_links(domain_ids, domains, pages, "owner_unit_id"),
        ("- Concept：" if zh else "- Concepts: ")
        + _mapped_links(disposition.concept_ids, concepts, pages, "owner_unit_id"),
    ]
    if disposition.replica_of is not None:
        target = (disposition.replica_of.source, disposition.replica_of.table)
        ownership.append(
            ("- 副本来源：" if zh else "- Replica of: ")
            + f"[{target[0]}.{target[1]}][{table_pages[target]}]"
        )

    model_pages = []
    for concept_id in disposition.concept_ids:
        concept = concepts.get(concept_id)
        page = pages.get(concept.model_unit_id) if concept is not None else None
        if page is not None and page.id not in {item.id for item in model_pages}:
            model_pages.append(page)
    if model_pages:
        usage = [f"- {_logical_link(page.title, page)}" for page in model_pages]
    else:
        usage = ["没有映射的数据模型页。" if zh else "No mapped data-model page."]

    body = _render_template(
        language,
        "table.md",
        {
            "table_comment": f"{comment}{citation}",
            "columns": "\n".join(columns),
            "constraints": "\n".join(constraint_lines),
            "storage": "\n".join(storage),
            "domain_links": "\n".join(ownership),
            "usage_links": "\n".join(usage),
        },
    )
    footnotes = [_footnote(item["id"], item["resource"]) for item in sources]
    return body + "\n\n" + "\n".join(footnotes) + "\n", sources


def _schema_body(
    language: str,
    source: str,
    tables: list[dict],
    dispositions: dict,
    domains: dict,
    concepts: dict,
    pages: dict,
    table_pages: dict,
    catalog_resource: str,
) -> tuple[str, list[dict]]:
    zh = language == "zh"
    grouped = {role: [] for role in _ROLES}
    domain_groups = {}
    evidence = []
    for table in tables:
        disposition = dispositions[(source, table["name"])]
        role = disposition.role
        grouped[role].append((table, disposition))
        domain_groups.setdefault(disposition.domain_id, {}).setdefault(role, []).append(
            (table, disposition)
        )
        evidence.extend(disposition.evidence)
    sources, source_ids = _source_map(catalog_resource, evidence)

    capture = [
        (
            "| Source | Schema | 已选表 | 已生成参考页 |"
            if zh
            else "| Source | Schema | Selected tables | Generated references |"
        ),
        "|---|---|---:|---:|",
        f"| `{source}` | `{tables[0]['schema'] if tables else '-'}` | {len(tables)} | {len(tables) + 1} |",
    ]
    role_summary = [
        ("| 角色 | 表数量 |" if zh else "| Role | Tables |"),
        "|---|---:|",
    ]
    for role in _ROLES:
        if grouped[role]:
            role_summary.append(f"| `{role}` | {len(grouped[role])} |")

    constraints = [item for table in tables for item in table.get("constraints", [])]
    constraint_counts = {
        kind: sum(item.get("type") == kind for item in constraints)
        for kind in ("primary_key", "unique", "foreign_key", "check")
    }
    persistence = ", ".join(
        f"{kind}={sum(table.get('persistence') == kind for table in tables)}"
        for kind in sorted({table.get("persistence") or "unknown" for table in tables})
    ) or "-"
    constraint_summary = [
        (
            "| 主键 | 唯一约束 | 外键 | 检查约束 | 索引 | 分区 | 持久性 |"
            if zh
            else "| Primary keys | Unique | Foreign keys | Checks | Indexes | Partitions | Persistence |"
        ),
        "|---:|---:|---:|---:|---:|---:|---|",
        f"| {constraint_counts['primary_key']} | {constraint_counts['unique']} | "
        f"{constraint_counts['foreign_key']} | {constraint_counts['check']} | "
        f"{sum(len(table.get('indexes', [])) for table in tables)} | "
        f"{sum(len(table.get('partitions', [])) for table in tables)} | {persistence} |",
    ]
    table_links = []
    ordered_groups = sorted(
        domain_groups,
        key=lambda domain_id: (domain_id is None, domain_id or ""),
    )
    for domain_id in ordered_groups:
        domain_label = (
            _mapped_links([domain_id], domains, pages, "owner_unit_id")
            if domain_id is not None
            else ("无 Domain 归属" if zh else "No Domain ownership")
        )
        table_links.extend([f"### {domain_label}", ""])
        for role in _ROLES:
            entries = domain_groups[domain_id].get(role, [])
            if not entries:
                continue
            table_links.extend(
                [
                    f"#### {role}",
                    "",
                    (
                        "| 数据表 | Domain | Concept | 来源 | 注释 |"
                        if zh
                        else "| Table | Domain | Concepts | Origin | Comment |"
                    ),
                    "|---|---|---|---|---|",
                ]
            )
            for table, disposition in entries:
                domain_ids = [disposition.domain_id] if disposition.domain_id else []
                domain = _mapped_links(domain_ids, domains, pages, "owner_unit_id")
                concept_links = _mapped_links(
                    disposition.concept_ids,
                    concepts,
                    pages,
                    "owner_unit_id",
                )
                origin = "-"
                if disposition.replica_of is not None:
                    target = (disposition.replica_of.source, disposition.replica_of.table)
                    origin = f"[{target[0]}.{target[1]}][{table_pages[target]}]"
                table_links.append(
                    f"| [{table['name']}][{_table_id(source, table['page_slug'])}]"
                    f" | {domain} | {concept_links} | {origin} | "
                    f"{_md(table.get('comment'))}{_refs(disposition.evidence, source_ids)} |"
                )
            table_links.append("")

    body = _render_template(
        language,
        "schema.md",
        {
            "schema_comment": (
                f"该 Schema 捕获了 {len(tables)} 张已选择的数据表。[^catalog]"
                if zh
                else f"This schema captures {len(tables)} selected tables.[^catalog]"
            ),
            "capture_summary": "\n".join(capture),
            "table_role_summary": "\n".join(role_summary),
            "constraint_summary": "\n".join(constraint_summary),
            "table_links": "\n".join(table_links).rstrip(),
            "coverage_gaps": (
                "所有已选择数据表均已分类并生成参考页。"
                if zh
                else "Every selected table is classified and has a generated reference page."
            ),
        },
    )
    footnotes = [_footnote(item["id"], item["resource"]) for item in sources]
    return body + "\n\n" + "\n".join(footnotes) + "\n", sources


def derive_pages(
    root: pathlib.Path,
    state: dict,
    plan: KnowledgePlan,
    composition: CompositionMap,
) -> list[dict]:
    language = state["language"]
    zh = language == "zh"
    catalogs = _catalogs(root, state)
    dispositions, domains, concepts, pages = _table_context(plan, composition)
    table_pages = {
        (catalog["name"], table["name"]): _table_id(
            catalog["name"], table["page_slug"]
        )
        for catalog in catalogs.values()
        for table in catalog["tables"]
    }
    generated = []
    for reference_root in sorted(composition.reference_roots, key=lambda item: item.source):
        catalog_record = catalogs.get(reference_root.source)
        if catalog_record is None:
            raise _db.DbError(f"Captured catalog '{reference_root.source}' not found")
        catalog = _db.load_catalog(root, catalog_record["storage_key"])
        tables = sorted(catalog["tables"], key=lambda item: item["name"])
        schema_body, schema_sources = _schema_body(
            language,
            reference_root.source,
            tables,
            dispositions,
            domains,
            concepts,
            pages,
            table_pages,
            catalog["resource"],
        )
        generated.append(
            {
                "id": _schema_id(reference_root.source),
                "path": f"{reference_root.path}/schema.md",
                "type": "Schema",
                "title": (
                    f"{reference_root.source} 数据库 Schema"
                    if zh
                    else f"{reference_root.source} OpenGauss schema"
                ),
                "description": (
                    "查看已选择数据表的分组、归属与参考入口。"
                    if zh
                    else "Open before navigating selected tables and their ownership."
                ),
                "tags": ["opengauss", "schema", reference_root.source],
                "diagrams": [],
                "sources": schema_sources,
                "body": schema_body,
                "units": [],
                "source": reference_root.source,
                "table": None,
            }
        )
        for table in tables:
            disposition = dispositions[(reference_root.source, table["name"])]
            body, table_sources = _table_body(
                language,
                table,
                disposition,
                domains,
                concepts,
                pages,
                table_pages,
                table["resource"],
            )
            generated.append(
                {
                    "id": _table_id(reference_root.source, table["page_slug"]),
                    "path": (
                        f"{reference_root.path}/{disposition.domain_id}/tables/{table['page_slug']}.md"
                        if disposition.domain_id
                        else f"{reference_root.path}/roles/{disposition.role}/tables/{table['page_slug']}.md"
                    ),
                    "type": "Table",
                    "title": f"{table['name']} 数据表" if zh else table["name"],
                    "description": (
                        "查看字段、约束、索引、分区与 Domain 归属。"
                        if zh
                        else "Open before changing columns, constraints, indexes, partitions, or ownership."
                    ),
                    "tags": ["opengauss", "table", reference_root.source],
                    "diagrams": [],
                    "sources": table_sources,
                    "body": body,
                    "units": [],
                    "source": reference_root.source,
                    "table": table["name"],
                }
            )
    return generated


def _ensure_source(meta: dict, resource: str, suggested: str) -> str:
    sources = list(meta.get("sources") or [])
    for source in sources:
        if source.get("resource") == resource:
            return source["id"]
    used = {source["id"] for source in sources}
    source_id = suggested
    if source_id in used:
        source_id = _stable_id(suggested, resource)
    sources.append(_source(source_id, resource))
    meta["sources"] = sources
    return source_id


def _active_fk(constraint: dict) -> bool:
    return (
        constraint.get("type") == "foreign_key"
        and constraint.get("validated") is True
        and constraint.get("soft") is False
    )


def _active_unique_sets(table: dict) -> set[frozenset[str]]:
    result = set()
    for constraint in table.get("constraints", []):
        if (
            constraint.get("type") in {"primary_key", "unique"}
            and constraint.get("validated") is True
            and constraint.get("soft") is False
        ):
            result.add(frozenset(constraint.get("columns") or []))
    columns = {column["name"] for column in table.get("columns", [])}
    for index in table.get("indexes", []):
        keys = index.get("keys") or []
        if (
            index.get("unique") is True
            and index.get("valid") is True
            and index.get("usable") is True
            and not index.get("predicate")
            and keys
            and set(keys) <= columns
        ):
            result.add(frozenset(keys))
    return result


def _mermaid_id(source: str, schema: str, table: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", table).strip("_") or "TABLE"
    if not slug[0].isalpha():
        slug = "T_" + slug
    digest = hashlib.sha256(f"{source}/{schema}/{table}".encode()).hexdigest()[:6]
    return f"{slug.upper()}_{digest}"


def _mermaid_token(value: str, prefix: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or prefix
    return token if token[0].isalpha() else f"{prefix}_{token}"


def _database_id(table: dict) -> str:
    return table["resource"].partition("/")[0]


def _physical_er(
    page, tables: list[tuple[str, dict]], language: str
) -> tuple[str, dict]:
    zh = language == "zh"
    aliases = {
        (source, table["schema"], table["name"]): _mermaid_id(
            source, table["schema"], table["name"]
        )
        for source, table in tables
    }
    targets = {
        (_database_id(table), table["schema"], table["name"]): (
            source,
            table["schema"],
            table["name"],
        )
        for source, table in tables
    }
    lines = [
        "```mermaid",
        "%% okf-id: physical-schema",
        "erDiagram",
        (
            f"    accTitle: {page.title} 的物理结构"
            if zh
            else f"    accTitle: Physical schema for {page.title}"
        ),
        (
            "    accDescr: OpenGauss 声明的数据表和有效外键关系。"
            if zh
            else "    accDescr: OpenGauss-declared tables and active foreign-key relationships."
        ),
    ]
    for source, table in tables:
        alias = aliases[(source, table["schema"], table["name"])]
        primary = set(table.get("primary_key") or [])
        foreign = {
            column
            for constraint in table.get("constraints", [])
            if _active_fk(constraint)
            for column in constraint.get("columns") or []
        }
        unique = {
            next(iter(columns))
            for columns in _active_unique_sets(table)
            if len(columns) == 1
        }
        lines.append(f"    {alias} {{")
        for column in table.get("columns", []):
            markers = []
            if column["name"] in primary:
                markers.append("PK")
            if column["name"] in foreign:
                markers.append("FK")
            if column["name"] in unique and column["name"] not in primary:
                markers.append("UK")
            marker = f" {', '.join(markers)}" if markers else ""
            lines.append(
                f"        {_mermaid_token(column['type'], 'type')} "
                f"{_mermaid_token(column['name'], 'column')}{marker}"
            )
        lines.append("    }")

    for source, table in tables:
        child_key = (source, table["schema"], table["name"])
        child = aliases[child_key]
        column_nullable = {
            column["name"]: column.get("nullable", True)
            for column in table.get("columns", [])
        }
        primary = set(table.get("primary_key") or [])
        unique_sets = _active_unique_sets(table)
        for constraint in table.get("constraints", []):
            if not _active_fk(constraint):
                continue
            target_key = targets.get(
                (
                    _database_id(table),
                    constraint.get("ref_schema"),
                    constraint.get("ref_table"),
                )
            )
            if target_key is None:
                continue
            columns = constraint.get("columns") or []
            parent = aliases[target_key]
            parent_cardinality = "o|" if any(column_nullable.get(name, True) for name in columns) else "||"
            child_cardinality = "o|" if frozenset(columns) in unique_sets else "o{"
            line = "--" if columns and set(columns) <= primary else ".."
            label = str(constraint.get("name") or "references").replace('"', "'")
            lines.append(
                f'    {parent} {parent_cardinality}{line}{child_cardinality} {child} : "{label}"'
            )
    lines.append("```")
    source_names = list(dict.fromkeys(source for source, _table in tables))
    diagram = DiagramSpec(
        id="physical-schema",
        kind="er",
        question=(
            "OpenGauss 声明了哪些物理关系？"
            if zh
            else "What physical relationships does OpenGauss declare?"
        ),
        sources=source_names,
    ).model_dump(mode="json")
    return "\n".join(lines), diagram


def enrich_data_model(
    root: pathlib.Path,
    state: dict,
    plan: KnowledgePlan,
    page,
    meta: dict,
    body: str,
) -> tuple[dict, str]:
    if body.count(_MARKER) != 1:
        raise ValueError("DataModel page must contain exactly one generated model marker")
    meta = dict(meta)
    meta["sources"] = list(meta.get("sources") or [])
    meta["diagrams"] = list(meta.get("diagrams") or [])
    unit_ids = set(page.units)
    concepts = [
        concept for concept in plan.concepts if concept.model_unit_id in unit_ids
    ]
    catalogs = _catalogs(root, state)
    table_records = []
    source_ids = {}
    seen_tables = set()
    for concept in concepts:
        for reference in concept.model_basis.catalog_tables:
            key = (reference.source, reference.table)
            if key in seen_tables:
                continue
            seen_tables.add(key)
            catalog = catalogs.get(reference.source)
            if catalog is None:
                raise _db.DbError(f"Captured catalog '{reference.source}' not found")
            entry = next(
                (item for item in catalog["tables"] if item["name"] == reference.table),
                None,
            )
            if entry is None:
                raise _db.DbError(
                    f"Table '{reference.table}' not found in captured catalog"
                )
            table = _db.load_table(root, catalog["storage_key"], entry["page_slug"])
            table_records.append((reference.source, table))
            source_ids[table["resource"]] = _ensure_source(
                meta,
                table["resource"],
                _stable_id("catalog", f"{reference.source}-{entry['page_slug']}"),
            )

    zh = state["language"] == "zh"
    lines = [
        "### 生成的模型依据" if zh else "### Generated model basis",
        "",
        (
            "| Concept | 依据 | 覆盖 | 结构证据 |"
            if zh
            else "| Concept | Basis | Coverage | Structure evidence |"
        ),
        "|---|---|---|---|",
    ]
    table_entries = {
        (catalog["name"], item["name"]): item
        for catalog in catalogs.values()
        for item in catalog["tables"]
    }
    for concept in concepts:
        basis = concept.model_basis
        if basis.basis == "opengauss":
            references = []
            for reference in basis.catalog_tables:
                entry = table_entries[(reference.source, reference.table)]
                resource = next(
                    table["resource"]
                    for source, table in table_records
                    if source == reference.source and table["name"] == reference.table
                )
                references.append(
                    f"[{reference.table}][{_table_id(reference.source, entry['page_slug'])}]"
                    f"[^{source_ids[resource]}]"
                )
            evidence = ", ".join(references)
        elif basis.basis == "code":
            references = []
            for resource in basis.structure_evidence:
                source_id = _ensure_source(
                    meta, resource, _stable_id("code-model", resource)
                )
                source_ids[resource] = source_id
                references.append(f"{_code(resource)}[^{source_id}]")
            evidence = ", ".join(references) or (
                "无结构证据" if zh else "No structure evidence"
            )
        else:
            evidence = "非持久化" if zh else "Not persistent"
        lines.append(
            f"| {_md(concept.name)} | `{basis.basis}` | `{basis.coverage}` | {evidence} |"
        )

    if table_records:
        diagram_text, diagram = _physical_er(page, table_records, state["language"])
        existing_ids = {item["id"] for item in meta["diagrams"]}
        if diagram["id"] in existing_ids:
            raise ValueError("generated physical diagram id conflicts with an authored diagram")
        meta["diagrams"].append(diagram)
        lines.extend(["", diagram_text, ""])
        citations = "".join(
            f"[^{source_ids[table['resource']]}]" for _source, table in table_records
        )
        lines.append(
            (
                f"该图仅包含 OpenGauss 中有效、启用且非软约束的外键。{citations}"
                if zh
                else "The diagram contains only validated, enabled, non-soft OpenGauss foreign keys."
                f"{citations}"
            )
        )
    existing_defs = set(extract(body).footnote_defs)
    for resource, source_id in source_ids.items():
        if source_id in existing_defs:
            continue
        lines.append("")
        lines.append(_footnote(source_id, resource))
    return meta, body.replace(_MARKER, "\n".join(lines))
