import pytest

import _db
from _config import SchemaRule
from _db import DbError, capture, describe, load_env, resolve_url, select


@pytest.mark.parametrize(
    "content, expected",
    [
        ("", {}),
        ("KEY=value\n", {"KEY": "value"}),
        ("KEY1=value1\nKEY2=value2\n", {"KEY1": "value1", "KEY2": "value2"}),
        ("# Comment\nKEY=value\n", {"KEY": "value"}),
        ('KEY="quoted value"\n', {"KEY": "quoted value"}),
        ("KEY='quoted value'\n", {"KEY": "quoted value"}),
        ("  KEY  =  value  \n", {"KEY": "value"}),
        (None, {}),
    ],
)
def test_load_env(tmp_path, content, expected):
    if content is not None:
        (tmp_path / ".env").write_text(content)
    assert load_env(tmp_path) == expected


def test_resolve_url_uses_environment_before_dotenv(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DATABASE_URL", "opengauss://environment/app")
    (tmp_path / ".env").write_text("APP_DATABASE_URL=opengauss://file/app\n")
    assert resolve_url(tmp_path, "${APP_DATABASE_URL}") == "opengauss://environment/app"


@pytest.mark.parametrize(
    "url",
    (
        "postgres://localhost/app",
        "postgresql://localhost/app",
        "mysql://localhost/app",
        "opengauss:///app",
        "opengauss://localhost",
    ),
)
def test_resolve_url_only_accepts_complete_opengauss_urls(tmp_path, url):
    (tmp_path / ".env").write_text(f"DB_URL={url}\n")
    with pytest.raises(DbError, match="opengauss:// URL with host and database"):
        resolve_url(tmp_path, "DB_URL")


def test_resolve_url_rejects_missing_variable(tmp_path):
    with pytest.raises(DbError, match="Variable 'MISSING' not found"):
        resolve_url(tmp_path, "MISSING")


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []

    def execute(self, sql, params=None):
        normalized = " ".join(sql.lower().split())
        self.connection.sql.append((normalized, params))
        if normalized.startswith("begin transaction"):
            self.rows = []
        elif "opengauss_version()" in normalized:
            self.rows = self.connection.responses.get(
                "handshake",
                [
                    (
                        "7.0.0",
                        70000,
                        "OpenSourceCentralized",
                        "openGauss 7.0.0 build abc",
                        "app",
                    )
                ],
            )
        elif "from pg_catalog.pg_namespace n order by" in normalized:
            self.rows = self.connection.responses.get("schemas", [("public",)])
        elif "from pg_catalog.pg_class c" in normalized:
            responses = self.connection.responses
            self.rows = responses.get(("tables", params[0]), responses.get("tables", []))
        elif "left join pg_catalog.pg_attrdef" in normalized:
            self.rows = self.connection.responses.get(("columns", params[0]), [])
        elif "from pg_catalog.pg_constraint" in normalized:
            self.rows = self.connection.responses.get(("constraints", params[0]), [])
        elif "a.attrelid = any" in normalized:
            self.rows = self.connection.responses.get("referenced_columns", [])
        elif "from pg_catalog.pg_index" in normalized:
            self.rows = self.connection.responses.get(("indexes", params[0]), [])
        elif "from pg_catalog.pg_partition" in normalized:
            self.rows = self.connection.responses.get(("partitions", params[0]), [])
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class FakeConn:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.sql = []
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.closed = True


def test_select_handshakes_and_uses_one_read_only_repeatable_read_snapshot(monkeypatch):
    conn = FakeConn(
        {
            "tables": [
                (10, "orders", "customer orders", "r", "p"),
                (11, "staging", None, "r", "g"),
            ]
        }
    )
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)

    assert select("opengauss://localhost/app", [SchemaRule("public")]) == {
        "database": "app",
        "schemas": [{"schema": "public", "tables": ["orders", "staging"], "excluded": [], "skipped": 0}],
        "unmatched_schema_rules": [],
        "code_not_taken": [],
        "code_not_found": [],
    }
    statements = [sql for sql, _params in conn.sql]
    assert (
        statements[0] == "begin transaction isolation level repeatable read read only"
    )
    assert "opengauss_version()" in statements[1]
    assert conn.closed


def _catalog():
    return FakeConn(
        {
            "schemas": [("audit",), ("information_schema",), ("pg_toast",), ("public",),
                        ("tenant_a",), ("tenant_b",)],
            ("tables", "public"): [
                (10, "t_order", "", "r", "p"),
                (11, "t_order_item", "", "r", "p"),
                (12, "t_order_bak", "", "r", "p"),
                (13, "sys_config", "", "r", "p"),
                (14, "user_log", "", "r", "p"),
                (15, "customer", "", "r", "p"),
            ],
            ("tables", "tenant_a"): [(20, "t_order", "", "r", "p")],
            ("tables", "tenant_b"): [(30, "t_order", "", "r", "p"), (31, "scratch", "", "r", "p")],
        }
    )


def test_select_applies_prefix_suffix_rules_schema_globs_and_reports_code_gaps(monkeypatch):
    conn = _catalog()
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)
    rules = [
        SchemaRule("public", include=("t_order*", "*_config"), exclude=("*_bak",)),
        SchemaRule("tenant_*", include=("t_*",)),
        SchemaRule("missing_schema"),
    ]
    code = {"customer": "src/Customer.java#L3", "t_order": "src/Order.java#L2",
            "t_order_bak": "src/Backup.java#L9", "invoice": "src/Invoice.java#L1"}
    result = select("opengauss://localhost/app", rules, code)
    assert result["schemas"] == [
        {"schema": "public", "tables": ["t_order", "t_order_item", "sys_config"],
         "excluded": ["t_order_bak"], "skipped": 2},
        {"schema": "tenant_a", "tables": ["t_order"], "excluded": [], "skipped": 0},
        {"schema": "tenant_b", "tables": ["t_order"], "excluded": [], "skipped": 1},
    ]
    assert result["unmatched_schema_rules"] == ["missing_schema"]
    # The code uses customer and t_order_bak, which the rules leave out; invoice is
    # in no matched schema at all.
    assert result["code_not_taken"] == [
        {"table": "customer", "schema": "public", "reason": "not included", "locator": "src/Customer.java#L3"},
        {"table": "t_order_bak", "schema": "public", "reason": "excluded", "locator": "src/Backup.java#L9"},
    ]
    assert result["code_not_found"] == [{"table": "invoice", "locator": "src/Invoice.java#L1"}]
    # System schemas never match, even a catch-all rule.
    conn = _catalog()
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)
    everything = select("u", [SchemaRule("*")])
    assert [s["schema"] for s in everything["schemas"]] == ["audit", "public", "tenant_a", "tenant_b"]


def test_handshake_failure_is_redacted(monkeypatch):
    conn = FakeConn({"handshake": []})
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)
    with pytest.raises(DbError, match="did not identify itself as OpenGauss") as error:
        select("opengauss://secret:token@localhost/app", [SchemaRule("public")])
    assert "secret" not in str(error.value)
    assert "token" not in str(error.value)


def test_describe_preserves_composite_constraints_indexes_and_partitions(monkeypatch):
    conn = FakeConn(
        {
            "tables": [(10, "orders", "orders", "p", "p")],
            ("columns", 10): [
                (1, "tenant_id", "numeric(20,0)", False, None, "tenant"),
                (2, "customer_id", "bigint", False, None, "customer"),
                (3, "amount", "numeric(18,2)", True, "0", "amount"),
            ],
            ("constraints", 10): [
                (
                    "orders_amount_check",
                    "c",
                    [3],
                    None,
                    None,
                    0,
                    None,
                    "s",
                    "a",
                    "a",
                    False,
                    False,
                    True,
                    False,
                    False,
                    "CHECK (amount >= 0)",
                ),
                (
                    "orders_customer_fk",
                    "f",
                    [1, 2],
                    "crm",
                    "customers",
                    20,
                    [1, 2],
                    "f",
                    "c",
                    "r",
                    True,
                    True,
                    True,
                    False,
                    False,
                    "FOREIGN KEY (tenant_id, customer_id) REFERENCES crm.customers",
                ),
                (
                    "orders_pkey",
                    "p",
                    [1, 2],
                    None,
                    None,
                    0,
                    None,
                    "s",
                    "a",
                    "a",
                    False,
                    False,
                    True,
                    False,
                    False,
                    "PRIMARY KEY (tenant_id, customer_id)",
                ),
            ],
            "referenced_columns": [
                (20, 1, "tenant_id"),
                (20, 2, "id"),
            ],
            ("indexes", 10): [
                (
                    "orders_amount_idx",
                    False,
                    False,
                    True,
                    True,
                    True,
                    "btree",
                    ["amount DESC"],
                    [],
                    "amount > 0",
                    None,
                    "CREATE INDEX orders_amount_idx ON orders USING btree (amount DESC)",
                )
            ],
            ("partitions", 10): [("orders_2026", "p", "r", ["2027-01-01"], None)],
        }
    )
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)

    result = describe("opengauss://localhost/app", "orders")

    assert result["relation_kind"] == "partitioned_table"
    assert result["columns"][0]["type"] == "numeric(20,0)"
    assert result["primary_key"] == ["tenant_id", "customer_id"]
    assert result["foreign_keys"] == [
        {
            "name": "orders_customer_fk",
            "columns": ["tenant_id", "customer_id"],
            "ref_schema": "crm",
            "ref_table": "customers",
            "ref_columns": ["tenant_id", "id"],
            "match": "full",
            "on_update": "cascade",
            "on_delete": "restrict",
            "deferrable": True,
            "initially_deferred": True,
            "validated": True,
            "soft": False,
            "optimized": False,
        }
    ]
    assert result["constraints"][0]["definition"] == "CHECK (amount >= 0)"
    assert result["indexes"][0]["keys"] == ["amount DESC"]
    assert result["partitions"][0]["boundaries"] == ["2027-01-01"]
    constraint_sql = next(sql for sql, _ in conn.sql if "pg_constraint" in sql)
    assert "constraint_name" not in constraint_sql
    assert "con.conrelid = %s" in constraint_sql
    assert "condisable" not in constraint_sql

_SERVER = {
    "opengauss_version": "7.0.0",
    "working_version_num": 70000,
    "deployment": "OpenSourceCentralized",
    "server_version": "openGauss 7.0.0 build abc",
    "database": "app",
}


def _described_table(name="Order Items", comment="line items"):
    return {
        "schema": "Public Data",
        "name": name,
        "comment": comment,
        "relation_kind": "table",
        "persistence": "permanent",
        "columns": [
            {
                "position": 1,
                "name": "id",
                "type": "bigint",
                "nullable": False,
                "default": None,
                "comment": "primary key",
            }
        ],
        "constraints": [],
        "primary_key": [],
        "foreign_keys": [],
        "indexes": [],
        "partitions": [],
    }


def _inspect(*described, unmatched=()):
    calls = []

    def inspect(url, rules):
        calls.append((url, list(rules)))
        by_schema = {}
        for item in described:
            by_schema.setdefault(item["schema"], []).append(item)
        return _SERVER, by_schema, list(unmatched)

    inspect.calls = calls
    return inspect


def test_capture_returns_per_schema_tables_hashes_and_server_fingerprint():
    other = dict(_described_table("c"), schema="audit")
    inspect = _inspect(_described_table("b"), _described_table("a"), other, unmatched=["gone"])
    rules = [SchemaRule("Public Data"), SchemaRule("audit"), SchemaRule("gone")]
    result = capture("opengauss://db/app", rules, inspect=inspect)

    assert inspect.calls == [("opengauss://db/app", rules)]
    assert set(result) == {"server", "schemas", "unmatched_schema_rules"}
    assert result["server"] == _SERVER and result["unmatched_schema_rules"] == ["gone"]
    assert list(result["schemas"]) == ["Public Data", "audit"]
    part = result["schemas"]["Public Data"]
    assert set(part) == {"schema", "tables", "sha256", "catalog_sha256"}
    assert list(part["tables"]) == ["a", "b"]
    assert part["tables"]["a"]["columns"][0]["type"] == "bigint"
    assert part["sha256"]["a"] == _db._hash_json(part["tables"]["a"])
    assert len(part["catalog_sha256"]) == 64


def test_capture_hashes_change_only_for_changed_tables():
    rules = [SchemaRule("Public Data")]
    first = capture("u", rules, inspect=_inspect(_described_table("a", "first"), _described_table("b")))
    second = capture("u", rules, inspect=_inspect(_described_table("a", "second"), _described_table("b")))
    same = capture("u", rules, inspect=_inspect(_described_table("b"), _described_table("a", "first")))
    one, two = first["schemas"]["Public Data"], second["schemas"]["Public Data"]
    assert one["sha256"]["a"] != two["sha256"]["a"]
    assert one["sha256"]["b"] == two["sha256"]["b"]
    assert one["catalog_sha256"] != two["catalog_sha256"]
    assert same == first


def test_capture_refuses_rules_that_take_no_table():
    with pytest.raises(DbError, match="matched no table.*okf db tables"):
        capture("u", [SchemaRule("public", include=("nothing_*",))], inspect=_inspect())


def test_capture_uses_one_connection_and_snapshot_for_every_schema(monkeypatch):
    conn = _catalog()
    connections = []

    def connect(_url):
        connections.append(conn)
        return conn

    monkeypatch.setattr(_db, "_connect", connect)
    rules = [SchemaRule("public", include=("t_order*",), exclude=("*_bak",)), SchemaRule("tenant_*")]
    result = capture("opengauss://localhost/app", rules)

    assert connections == [conn]
    assert conn.closed
    assert sum(sql.startswith("begin transaction") for sql, _ in conn.sql) == 1
    assert sum("opengauss_version()" in sql for sql, _ in conn.sql) == 1
    assert {s: list(p["tables"]) for s, p in result["schemas"].items()} == {
        "public": ["t_order", "t_order_item"],
        "tenant_a": ["t_order"],
        "tenant_b": ["scratch", "t_order"],
    }
    assert result["server"]["database"] == "app"


def test_psycopg_url_only_translates_opengauss():
    assert _db._psycopg_url("opengauss://host/db") == "postgresql://host/db"
    with pytest.raises(DbError, match="opengauss://"):
        _db._psycopg_url("postgresql://host/db")
