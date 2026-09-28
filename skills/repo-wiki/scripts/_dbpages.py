"""Render an OpenGauss capture (see `_db.capture`) as OKF Schema/Table pages."""

import hashlib
import re

import _files
from _frontmatter import parse_page, render

GENERATOR = "repo-wiki/okf-db"

_TEXT = {
    "en": {
        "schema_description": (
            "Read to find which tables exist in {db}.{schema}, what they hold and "
            "how foreign keys connect them."
        ),
        "table_description": (
            "Read before changing code that reads or writes {schema}.{table}: "
            "columns, keys, constraints and indexes as declared in the database."
        ),
        "schema_intro": "{count} captured tables in schema `{schema}` of database `{db}`.",
        "tables": "Tables",
        "table_header": "| Table | Comment |",
        "relationships": "Relationships",
        "er_title": "Physical schema of {db}.{schema}",
        "er_descr": "Captured tables and their active foreign keys.",
        "no_relationships": "No active foreign keys between captured tables.",
        "no_comment": "No table comment.",
        "part_of": "Part of [{db}.{schema}]({link}). Kind: `{kind}`, persistence: `{persistence}`.",
        "columns": "Columns",
        "column_header": "| Column | Type | Nullable | Default | Comment |",
        "yes": "yes",
        "no": "no",
        "primary_key": "Primary key",
        "no_primary_key": "No primary key.",
        "foreign_keys": "Foreign keys",
        "fk_header": "| Name | Columns | References | On update | On delete | Status |",
        "no_foreign_keys": "No foreign keys.",
        "active": "active",
        "not_validated": "not validated",
        "soft": "soft",
        "constraints": "Unique and check constraints",
        "constraint_header": "| Name | Type | Columns | Definition |",
        "indexes": "Indexes",
        "index_header": "| Index | Method | Keys | Include | Flags | Predicate |",
        "no_indexes": "No indexes.",
        "partitions": "Partitions",
        "partition_header": "| Partition | Type | Strategy | Boundaries | Tablespace |",
        "used_by": " Used by: {repos}.",
        "sep": ", ",
    },
    "zh": {
        "schema_description": (
            "需要了解 {db}.{schema} 有哪些表、各存什么数据、外键如何关联时阅读。"
        ),
        "table_description": (
            "修改读写 {schema}.{table} 的代码前阅读：数据库声明的列、键、约束和索引。"
        ),
        "schema_intro": "数据库 `{db}` 的 `{schema}` 模式中已捕获 {count} 张表。",
        "tables": "数据表",
        "table_header": "| 表 | 注释 |",
        "relationships": "关系",
        "er_title": "{db}.{schema} 的物理结构",
        "er_descr": "已捕获的数据表及其生效的外键。",
        "no_relationships": "已捕获的表之间没有生效的外键。",
        "no_comment": "无表注释。",
        "part_of": "属于 [{db}.{schema}]({link})。类型：`{kind}`，持久性：`{persistence}`。",
        "columns": "列",
        "column_header": "| 列 | 类型 | 可空 | 默认值 | 注释 |",
        "yes": "是",
        "no": "否",
        "primary_key": "主键",
        "no_primary_key": "无主键。",
        "foreign_keys": "外键",
        "fk_header": "| 名称 | 列 | 引用 | 更新时 | 删除时 | 状态 |",
        "no_foreign_keys": "无外键。",
        "active": "生效",
        "not_validated": "未验证",
        "soft": "软约束",
        "constraints": "唯一约束与检查约束",
        "constraint_header": "| 名称 | 类型 | 列 | 定义 |",
        "indexes": "索引",
        "index_header": "| 索引 | 方法 | 键 | INCLUDE | 属性 | 条件 |",
        "no_indexes": "无索引。",
        "partitions": "分区",
        "partition_header": "| 分区 | 类型 | 策略 | 边界 | 表空间 |",
        "used_by": "使用方：{repos}。",
        "sep": "、",
    },
}


def _md(value) -> str:
    if value is None or value == "":
        return "-"
    if isinstance(value, (list, tuple)):
        value = ", ".join(str(item) for item in value)
    return str(value).replace("\n", " ").replace("|", "\\|")


def _code(value) -> str:
    if value in (None, "", [], ()):
        return "-"
    return f"`{_md(value).replace('`', '')}`"


def _separator(header: str) -> str:
    return "|" + "---|" * (header.count("|") - 1)


def _unique(names, base) -> dict[str, str]:
    """Map each name to base(name); names sharing a result get a sha1 suffix."""
    bases = {name: base(name) for name in names}
    counts: dict[str, int] = {}
    for value in bases.values():
        counts[value] = counts.get(value, 0) + 1
    return {
        name: value
        if counts[value] == 1
        else f"{value}-{hashlib.sha1(name.encode()).hexdigest()[:6]}"
        for name, value in bases.items()
    }


def slugs(names) -> dict[str, str]:
    return _unique(
        sorted(names),
        lambda name: re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-") or "table",
    )


def _token(value: str, prefix: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or prefix
    return token if token[0].isalpha() else f"{prefix}_{token}"


def _active(constraint: dict) -> bool:
    return constraint.get("validated") is True and constraint.get("soft") is False


def _active_fk(constraint: dict) -> bool:
    return constraint.get("type") == "foreign_key" and _active(constraint)


def _active_unique_sets(table: dict) -> set[frozenset[str]]:
    result = {
        frozenset(constraint.get("columns") or [])
        for constraint in table.get("constraints", [])
        if constraint.get("type") in {"primary_key", "unique"} and _active(constraint)
    }
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


def _ref_key(schema: str, constraint: dict) -> str | None:
    """Captured table name an FK points to, or None when outside the capture."""
    if constraint.get("ref_schema") not in (None, schema):
        return None
    return constraint.get("ref_table")


def _physical_er(t: dict, db: str, schema: str, tables: dict) -> str:
    edges = [
        (name, target, constraint)
        for name, table in tables.items()
        for constraint in table.get("constraints", [])
        if _active_fk(constraint)
        and (target := _ref_key(schema, constraint)) in tables
    ]
    if not edges:
        return t["no_relationships"]
    involved = sorted({name for edge in edges for name in edge[:2]})
    ids = _unique(involved, lambda name: _token(name, "T").upper())
    ids = {name: value.replace("-", "_") for name, value in ids.items()}
    lines = [
        "```mermaid",
        "erDiagram",
        f"    accTitle: {t['er_title'].format(db=db, schema=schema)}",
        f"    accDescr: {t['er_descr']}",
    ]
    for name in involved:
        table = tables[name]
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
        lines.append(f"    {ids[name]} {{")
        for column in table.get("columns", []):
            markers = [
                marker
                for marker, present in (
                    ("PK", column["name"] in primary),
                    ("FK", column["name"] in foreign),
                    ("UK", column["name"] in unique and column["name"] not in primary),
                )
                if present
            ]
            marker = f" {', '.join(markers)}" if markers else ""
            lines.append(
                f"        {_token(column['type'], 'type')} "
                f"{_token(column['name'], 'column')}{marker}"
            )
        lines.append("    }")
    for name, target, constraint in edges:
        table = tables[name]
        nullable = {c["name"]: c.get("nullable", True) for c in table.get("columns", [])}
        columns = constraint.get("columns") or []
        parent = "o|" if any(nullable.get(column, True) for column in columns) else "||"
        child = "o|" if frozenset(columns) in _active_unique_sets(table) else "o{"
        line = "--" if columns and set(columns) <= set(table.get("primary_key") or []) else ".."
        label = str(constraint.get("name") or "references").replace('"', "'")
        lines.append(f'    {ids[target]} {parent}{line}{child} {ids[name]} : "{label}"')
    lines.append("```")
    return "\n".join(lines)


def _schema_body(t, db, schema, tables, table_link) -> str:
    rows = [t["table_header"], _separator(t["table_header"])]
    rows += [
        f"| [{name}]({table_link(name)}) | {_md(table.get('comment'))} |"
        for name, table in tables.items()
    ]
    return "\n\n".join(
        [
            t["schema_intro"].format(count=len(tables), schema=schema, db=db),
            f"## {t['tables']}",
            "\n".join(rows),
            f"## {t['relationships']}",
            _physical_er(t, db, schema, tables),
        ]
    )


def _table_body(t, db, schema, table, schema_link, table_link, tables) -> str:
    parts = [
        _md(table.get("comment")) if table.get("comment") else t["no_comment"],
        t["part_of"].format(
            db=db,
            schema=schema,
            link=schema_link,
            kind=table.get("relation_kind") or "table",
            persistence=table.get("persistence") or "-",
        ),
        "# Schema",
        f"## {t['columns']}",
    ]
    rows = [t["column_header"], _separator(t["column_header"])]
    for column in table.get("columns", []):
        rows.append(
            f"| {_code(column.get('name'))} | {_code(column.get('type'))} | "
            f"{t['yes'] if column.get('nullable') else t['no']} | "
            f"{_code(column.get('default'))} | {_md(column.get('comment'))} |"
        )
    parts.append("\n".join(rows))

    parts.append(f"## {t['primary_key']}")
    primary = next(
        (c for c in table.get("constraints", []) if c.get("type") == "primary_key"),
        None,
    )
    if table.get("primary_key"):
        text = ", ".join(_code(column) for column in table["primary_key"])
        parts.append(f"{text} ({_code(primary['name'])})" if primary else text)
    else:
        parts.append(t["no_primary_key"])

    parts.append(f"## {t['foreign_keys']}")
    foreign = [c for c in table.get("constraints", []) if c.get("type") == "foreign_key"]
    if foreign:
        rows = [t["fk_header"], _separator(t["fk_header"])]
        for constraint in foreign:
            target = _ref_key(schema, constraint)
            label = f"{constraint.get('ref_schema') or schema}.{constraint.get('ref_table')}"
            reference = (
                f"[{label}]({table_link(target)})" if target in tables else _md(label)
            )
            ref_columns = constraint.get("ref_columns") or []
            if ref_columns:
                reference += " (" + ", ".join(_code(c) for c in ref_columns) + ")"
            status = [t["active"]] if _active_fk(constraint) else [
                t[flag]
                for flag, present in (
                    ("not_validated", constraint.get("validated") is not True),
                    ("soft", constraint.get("soft") is not False),
                )
                if present
            ]
            rows.append(
                f"| {_code(constraint.get('name'))} | {_code(constraint.get('columns'))} | "
                f"{reference} | {_code(constraint.get('on_update'))} | "
                f"{_code(constraint.get('on_delete'))} | {', '.join(status)} |"
            )
        parts.append("\n".join(rows))
    else:
        parts.append(t["no_foreign_keys"])

    other = [
        c for c in table.get("constraints", []) if c.get("type") in {"unique", "check"}
    ]
    if other:
        rows = [t["constraint_header"], _separator(t["constraint_header"])]
        rows += [
            f"| {_code(c.get('name'))} | {c.get('type')} | {_code(c.get('columns'))} | "
            f"{_code(c.get('definition'))} |"
            for c in other
        ]
        parts += [f"## {t['constraints']}", "\n".join(rows)]

    parts.append(f"## {t['indexes']}")
    if table.get("indexes"):
        rows = [t["index_header"], _separator(t["index_header"])]
        for index in table["indexes"]:
            flags = ", ".join(
                flag
                for flag in ("unique", "primary", "valid", "usable", "ready")
                if index.get(flag)
            )
            rows.append(
                f"| {_code(index.get('name'))} | {_code(index.get('method'))} | "
                f"{_code(index.get('keys'))} | {_code(index.get('include'))} | "
                f"{flags or '-'} | {_code(index.get('predicate'))} |"
            )
        parts.append("\n".join(rows))
    else:
        parts.append(t["no_indexes"])

    if table.get("partitions"):
        rows = [t["partition_header"], _separator(t["partition_header"])]
        rows += [
            f"| {_code(p.get('name'))} | {_code(p.get('type'))} | "
            f"{_code(p.get('strategy'))} | {_code(p.get('boundaries'))} | "
            f"{_code(p.get('tablespace'))} |"
            for p in table["partitions"]
        ]
        parts += [f"## {t['partitions']}", "\n".join(rows)]
    return "\n\n".join(parts)


DATABASES_DIR = "databases"


def database_dir(db_name: str) -> str:
    """Wiki directory holding every generated page of one configured database."""
    return f"{DATABASES_DIR}/{db_name}"


def render_database(db_name: str, repos, capture: dict, lang: str, at: str) -> dict[str, str]:
    """Return {wiki-relative path: page text} for a whole-database capture (see
    ``_db.capture``): per schema one Schema page ``databases/<db>/<schema>.md`` and
    one Table page per table under ``databases/<db>/<schema>/``. ``repos`` are the
    hub sources bound to the database; empty in a single repository."""
    schema_slug = slugs(capture["schemas"])
    pages: dict[str, str] = {}
    for schema, part in capture["schemas"].items():
        pages |= render_schema(db_name, list(repos), part, lang, database_dir(db_name), schema_slug[schema], at)
    return pages


def render_schema(db_name: str, repos: list[str], capture: dict, lang: str, root_dir: str,
                  schema_slug: str, at: str) -> dict[str, str]:
    """One Schema page and its Table pages for one schema of a capture."""
    t = _TEXT[lang]
    root = root_dir.strip("/")
    schema = capture["schema"]
    tables = dict(sorted(capture["tables"].items()))
    slug = slugs(tables)
    schema_path = f"{root}/{schema_slug}.md"
    used_by = t["used_by"].format(repos=t["sep"].join(repos)) if repos else ""

    def table_link(name: str) -> str:
        return f"/{root}/{schema_slug}/{slug[name]}.md"

    def meta(kind: str, title: str, description: str, sha: str, **db) -> dict:
        binding = {"repos": repos} if repos else {}
        return {
            "type": kind,
            "title": title,
            "description": description + used_by,
            "tags": ["database", kind.lower()],
            "status": "stable",
            "generated": {"by": GENERATOR, "at": at},
            "catalog_sha256": sha,
            "db": {"name": db_name, "schema": schema, **db, **binding},
        }

    pages = {
        schema_path: render(
            meta(
                "Schema",
                f"{db_name}.{schema}",
                t["schema_description"].format(db=db_name, schema=schema),
                capture["catalog_sha256"],
            ),
            _schema_body(t, db_name, schema, tables, table_link) + "\n",
        )
    }
    for name, table in tables.items():
        pages[f"{root}/{schema_slug}/{slug[name]}.md"] = render(
            meta(
                "Table",
                f"{db_name}.{schema}.{name}",
                t["table_description"].format(schema=schema, table=name),
                capture["sha256"][name],
                table=name,
            ),
            _table_body(t, db_name, schema, table, f"/{schema_path}", table_link, tables)
            + "\n",
        )
    return pages


def write_database(wiki, db_name: str, rendered: dict[str, str]) -> dict[str, list[str]]:
    """Write the rendered pages of one database under ``wiki`` and remove the
    generated pages of that database the capture no longer produces (a table
    dropped or no longer taken by the rules). Paths are wiki-relative."""
    written, removed = [], []
    for rel, text in sorted(rendered.items()):
        file = wiki / rel
        if not file.is_file() or file.read_text(encoding="utf-8") != text:
            _files.atomic_text(file, text)
            written.append(rel)
    base = wiki / database_dir(db_name)
    existing = sorted(f.relative_to(wiki).as_posix() for f in base.rglob("*.md")) if base.is_dir() else []
    for rel in existing:
        file = wiki / rel
        if rel in rendered:
            continue
        meta = parse_page(file.read_text(encoding="utf-8")).meta
        if meta.get("generated", {}).get("by") == GENERATOR and (meta.get("db") or {}).get("name") == db_name:
            file.unlink()
            removed.append(rel)
    return {"written": written, "removed": removed}
