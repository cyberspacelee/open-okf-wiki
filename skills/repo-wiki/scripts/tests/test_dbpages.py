import re

from _dbpages import render_database, render_schema, slugs, write_database
from _diagram import check
from _frontmatter import parse_page
from _markdown import extract

AT = "2026-09-25T00:00:00Z"


def _col(name, type_="bigint", nullable=False, default=None, comment=""):
    return {
        "position": 1,
        "name": name,
        "type": type_,
        "nullable": nullable,
        "default": default,
        "comment": comment,
    }


def _pk(name, columns):
    return {
        "name": name,
        "type": "primary_key",
        "columns": columns,
        "definition": f"PRIMARY KEY ({', '.join(columns)})",
        "validated": True,
        "soft": False,
    }


def _fk(name, columns, ref, ref_columns, *, validated=True, soft=False, schema="public"):
    return {
        "name": name,
        "type": "foreign_key",
        "columns": columns,
        "ref_schema": schema,
        "ref_table": ref,
        "ref_columns": ref_columns,
        "on_update": "no_action",
        "on_delete": "cascade",
        "validated": validated,
        "soft": soft,
        "definition": "FOREIGN KEY",
    }


def _table(name, columns, constraints, **extra):
    return {
        "schema": "public",
        "name": name,
        "comment": extra.get("comment", ""),
        "relation_kind": "table",
        "persistence": "permanent",
        "columns": columns,
        "constraints": constraints,
        "primary_key": next(
            (c["columns"] for c in constraints if c["type"] == "primary_key"), []
        ),
        "indexes": extra.get("indexes", []),
        "partitions": extra.get("partitions", []),
    }


def _capture(*tables):
    by_name = {table["name"]: table for table in tables}
    return {
        "server": {"database": "app"},
        "schema": "public",
        "tables": by_name,
        "sha256": {name: f"{index:064x}" for index, name in enumerate(by_name, 1)},
        "catalog_sha256": "a" * 64,
    }


def _shop():
    return _capture(
        _table(
            "orders",
            [_col("id"), _col("tenant_id"), _col("customer_id", nullable=True)],
            [
                _pk("orders_pkey", ["id"]),
                _fk(
                    "orders_customer_fk",
                    ["tenant_id", "customer_id"],
                    "customers",
                    ["tenant_id", "id"],
                ),
                _fk("orders_soft_fk", ["id"], "customers", ["id"], soft=True),
                _fk("orders_unvalidated_fk", ["id"], "audit", ["id"], validated=False),
                _fk("orders_region_fk", ["id"], "regions", ["id"], schema="geo"),
                {
                    "name": "orders_id_check",
                    "type": "check",
                    "columns": ["id"],
                    "definition": "CHECK (id > 0)",
                    "validated": True,
                    "soft": False,
                },
            ],
            partitions=[
                {
                    "name": "orders_2026",
                    "type": "p",
                    "strategy": "r",
                    "boundaries": ["2027-01-01"],
                    "tablespace": None,
                }
            ],
        ),
        _table(
            "customers",
            [_col("tenant_id"), _col("id", comment="customer id")],
            [_pk("customers_pkey", ["tenant_id", "id"])],
            comment="People who order",
        ),
        _table("audit", [_col("id")], [_pk("audit_pkey", ["id"])]),
    )


def _pages(capture=None, lang="en"):
    return render_schema("app", [], capture or _shop(), lang, "reference/app", "public", AT)


def test_paths_and_frontmatter():
    pages = _pages()
    assert sorted(pages) == [
        "reference/app/public.md",
        "reference/app/public/audit.md",
        "reference/app/public/customers.md",
        "reference/app/public/orders.md",
    ]
    schema = parse_page(pages["reference/app/public.md"])
    assert schema.errors == []
    assert schema.meta["type"] == "Schema"
    assert schema.meta["status"] == "stable"
    assert schema.meta["generated"] == {"by": "repo-wiki/okf-db", "at": AT}
    assert schema.meta["catalog_sha256"] == "a" * 64
    assert schema.meta["db"] == {"name": "app", "schema": "public"}
    assert schema.meta["title"] and schema.meta["description"]
    assert isinstance(schema.meta["tags"], list)

    table = parse_page(pages["reference/app/public/customers.md"])
    assert table.meta["type"] == "Table"
    assert table.meta["catalog_sha256"] == _shop()["sha256"]["customers"]
    assert table.meta["db"] == {"name": "app", "schema": "public", "table": "customers"}
    assert "revision" not in table.meta and "scope" not in table.meta


def test_schema_lists_tables_with_bundle_absolute_links():
    body = parse_page(_pages()["reference/app/public.md"]).body
    assert "| [customers](/reference/app/public/customers.md) | People who order |" in body
    assert "[orders](/reference/app/public/orders.md)" in body


def test_er_diagram_has_only_active_fks_within_capture():
    body = parse_page(_pages()["reference/app/public.md"]).body
    structure = extract(body)
    assert check(structure) == []
    [fence] = [f for f in structure.fences if f.language == "mermaid"]
    assert fence.content.lstrip().startswith("erDiagram")
    edges = [line for line in fence.content.splitlines() if " : " in line]
    assert edges == ['    CUSTOMERS o|..o{ ORDERS : "orders_customer_fk"']
    assert "AUDIT" not in fence.content  # only inactive FKs reach audit
    assert "bigint tenant_id PK" in fence.content
    assert "bigint customer_id FK" in fence.content


def test_er_diagram_omitted_without_active_fks():
    capture = _capture(_table("audit", [_col("id")], [_pk("audit_pkey", ["id"])]))
    body = parse_page(_pages(capture)["reference/app/public.md"]).body
    assert "```mermaid" not in body
    assert "No active foreign keys" in body


def test_table_page_fk_links_composite_keys_and_statuses():
    body = parse_page(_pages()["reference/app/public/orders.md"]).body
    assert "\n# Schema\n" in body
    assert "[app.public](/reference/app/public.md)" in body
    fk_rows = {
        line.split(" | ")[0].strip("| `"): line
        for line in body.splitlines()
        if line.startswith("| `orders_") and "_fk" in line.split(" | ")[0]
    }
    composite = fk_rows["orders_customer_fk"]
    assert "`tenant_id, customer_id`" in composite
    assert "[public.customers](/reference/app/public/customers.md) (`tenant_id`, `id`)" in composite
    assert composite.endswith("| active |")
    assert fk_rows["orders_soft_fk"].endswith("| soft |")
    assert "[public.audit](/reference/app/public/audit.md)" in fk_rows["orders_unvalidated_fk"]
    assert fk_rows["orders_unvalidated_fk"].endswith("| not validated |")
    region = fk_rows["orders_region_fk"]
    assert "geo.regions" in region and "](" not in region
    assert "| `orders_id_check` | check | `id` | `CHECK (id > 0)` |" in body
    assert "## Partitions" in body and "`orders_2026`" in body
    assert "| `customer_id` | `bigint` | yes | - | - |" in body

    customers = parse_page(_pages()["reference/app/public/customers.md"]).body
    assert "`tenant_id`, `id` (`customers_pkey`)" in customers
    assert "## Partitions" not in customers
    assert "No foreign keys." in customers


def test_zh_headers():
    pages = _pages(lang="zh")
    body = parse_page(pages["reference/app/public/orders.md"]).body
    assert "| 列 | 类型 | 可空 | 默认值 | 注释 |" in body
    assert "\n# Schema\n" in body
    assert "| `customer_id` | `bigint` | 是 | - | - |" in body
    assert "## 外键" in body
    schema = parse_page(pages["reference/app/public.md"])
    assert "| 表 | 注释 |" in schema.body
    assert re.search(r"[一-鿿]", schema.meta["description"])


def test_slug_collision_gets_sha1_suffix():
    result = slugs(["Order Items", "order-items", "orders"])
    assert result["orders"] == "orders"
    assert result["Order Items"] != result["order-items"]
    for name in ("Order Items", "order-items"):
        assert re.fullmatch(r"order-items-[0-9a-f]{6}", result[name])
    assert all(re.fullmatch(r"[a-z0-9_-]+(-[0-9a-f]{6})?", s) for s in result.values())
    assert slugs(["订单"]) == {"订单": "table"}

    capture = _capture(
        _table("Order Items", [_col("id")], []),
        _table("order-items", [_col("id")], []),
    )
    pages = _pages(capture)
    assert len(pages) == 3
    schema = parse_page(pages["reference/app/public.md"]).body
    for name in ("Order Items", "order-items"):
        assert f"[{name}](/reference/app/public/{result[name]}.md)" in schema


def test_output_is_deterministic():
    first = _pages()
    shuffled = _shop()
    shuffled["tables"] = dict(reversed(shuffled["tables"].items()))
    assert _pages(shuffled) == first
    assert _pages() == first


def _database(repos=()):
    public, tenant = _shop(), _shop()
    tenant["schema"] = "tenant_a"
    capture = {"server": {}, "schemas": {"public": public, "tenant_a": tenant}, "unmatched_schema_rules": []}
    return render_database("order_db", list(repos), capture, "zh", AT)


def test_database_layout_keeps_same_named_tables_of_each_schema_apart():
    pages = _database(["order-api", "order-worker"])
    assert sorted(pages) == [
        "databases/order_db/public.md",
        "databases/order_db/public/audit.md",
        "databases/order_db/public/customers.md",
        "databases/order_db/public/orders.md",
        "databases/order_db/tenant_a.md",
        "databases/order_db/tenant_a/audit.md",
        "databases/order_db/tenant_a/customers.md",
        "databases/order_db/tenant_a/orders.md",
    ]
    table = parse_page(pages["databases/order_db/tenant_a/orders.md"]).meta
    assert table["title"] == "order_db.tenant_a.orders"
    assert table["db"] == {"name": "order_db", "schema": "tenant_a", "table": "orders",
                           "repos": ["order-api", "order-worker"]}
    assert table["description"].endswith("使用方：order-api、order-worker。")
    body = parse_page(pages["databases/order_db/tenant_a.md"]).body
    assert "[orders](/databases/order_db/tenant_a/orders.md)" in body
    # A single repository records no binding.
    single = parse_page(_database()["databases/order_db/public.md"]).meta
    assert "repos" not in single["db"] and "使用方" not in single["description"]


def test_write_database_rewrites_changed_pages_and_removes_dropped_ones(tmp_path):
    pages = _database()
    first = write_database(tmp_path, "order_db", pages)
    assert first["written"] == sorted(pages) and first["removed"] == []
    assert write_database(tmp_path, "order_db", pages) == {"written": [], "removed": []}
    note = tmp_path / "databases/order_db/notes.md"
    note.write_text("---\ntype: Module\ntitle: n\ndescription: d\n---\n\nhand-written\n", encoding="utf-8")
    other_db = _database()
    other = {k.replace("order_db", "pay_db"): v for k, v in other_db.items()}
    write_database(tmp_path, "pay_db", other)
    kept = {k: v for k, v in pages.items() if "tenant_a" not in k}
    result = write_database(tmp_path, "order_db", kept)
    assert result == {"written": [], "removed": sorted(k for k in pages if "tenant_a" in k)}
    # Hand-written pages and other databases' pages are never removed.
    assert note.is_file() and (tmp_path / "databases/pay_db/tenant_a.md").is_file()
