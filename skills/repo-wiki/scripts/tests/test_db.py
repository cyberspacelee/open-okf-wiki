import pytest

import _db
from _db import DbError, capture, describe, load_env, resolve_url, tables


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
        elif "from pg_catalog.pg_class c" in normalized:
            self.rows = self.connection.responses.get("tables", [])
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


def test_tables_handshakes_and_uses_one_read_only_repeatable_read_snapshot(monkeypatch):
    conn = FakeConn(
        {
            "tables": [
                (10, "orders", "customer orders", "r", "p"),
                (11, "staging", None, "r", "g"),
            ]
        }
    )
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)

    assert tables("opengauss://localhost/app") == {
        "database": "app",
        "schema": "public",
        "count": 2,
        "tables": ["orders", "staging"],
    }
    statements = [sql for sql, _params in conn.sql]
    assert (
        statements[0] == "begin transaction isolation level repeatable read read only"
    )
    assert "opengauss_version()" in statements[1]
    assert conn.closed


def test_handshake_failure_is_redacted(monkeypatch):
    conn = FakeConn({"handshake": []})
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)
    with pytest.raises(DbError, match="did not identify itself as OpenGauss") as error:
        tables("opengauss://secret:token@localhost/app")
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


def _inspect(*described):
    calls = []

    def inspect(url, schema, selected):
        calls.append((url, schema, list(selected)))
        by_name = {item["name"]: item for item in described}
        return _SERVER, [by_name[name] for name in selected if name in by_name]

    inspect.calls = calls
    return inspect


def test_capture_returns_tables_hashes_and_server_fingerprint():
    inspect = _inspect(_described_table("b"), _described_table("a"))
    result = capture("opengauss://db/app", "Public Data", ["b", "a"], inspect=inspect)

    assert inspect.calls == [("opengauss://db/app", "Public Data", ["a", "b"])]
    assert set(result) == {"server", "schema", "tables", "sha256", "catalog_sha256"}
    assert result["server"] == _SERVER
    assert result["schema"] == "Public Data"
    assert list(result["tables"]) == ["a", "b"]
    assert result["tables"]["a"]["columns"][0]["type"] == "bigint"
    assert result["sha256"]["a"] == _db._hash_json(result["tables"]["a"])
    assert len(result["catalog_sha256"]) == 64


def test_capture_hashes_change_only_for_changed_tables():
    first = capture("u", "s", ["a", "b"], inspect=_inspect(
        _described_table("a", "first"), _described_table("b")
    ))
    second = capture("u", "s", ["a", "b"], inspect=_inspect(
        _described_table("a", "second"), _described_table("b")
    ))
    same = capture("u", "s", ["b", "a"], inspect=_inspect(
        _described_table("a", "first"), _described_table("b")
    ))

    assert first["sha256"]["a"] != second["sha256"]["a"]
    assert first["sha256"]["b"] == second["sha256"]["b"]
    assert first["catalog_sha256"] != second["catalog_sha256"]
    assert same == first


def test_capture_names_missing_tables():
    with pytest.raises(DbError, match="ghost"):
        capture("u", "s", ["a", "ghost"], inspect=_inspect(_described_table("a")))


def test_capture_uses_one_connection_and_snapshot(monkeypatch):
    conn = FakeConn(
        {
            "tables": [
                (10, "orders", "orders", "r", "p"),
                (11, "customers", "customers", "r", "p"),
            ],
            ("columns", 10): [(1, "id", "bigint", False, None, "")],
            ("columns", 11): [(1, "id", "bigint", False, None, "")],
        }
    )
    connections = []

    def connect(_url):
        connections.append(conn)
        return conn

    monkeypatch.setattr(_db, "_connect", connect)
    result = capture("opengauss://localhost/app", "public", ["orders", "customers"])

    assert connections == [conn]
    assert conn.closed
    assert sum(sql.startswith("begin transaction") for sql, _ in conn.sql) == 1
    assert sum("opengauss_version()" in sql for sql, _ in conn.sql) == 1
    assert list(result["tables"]) == ["customers", "orders"]
    assert result["server"]["database"] == "app"


def test_capture_live_missing_table_is_named(monkeypatch):
    conn = FakeConn({"tables": [(10, "orders", "orders", "r", "p")]})
    monkeypatch.setattr(_db, "_connect", lambda _url: conn)
    with pytest.raises(DbError, match="ghost"):
        capture("opengauss://localhost/app", "public", ["orders", "ghost"])
    assert conn.closed


def test_psycopg_url_only_translates_opengauss():
    assert _db._psycopg_url("opengauss://host/db") == "postgresql://host/db"
    with pytest.raises(DbError, match="opengauss://"):
        _db._psycopg_url("postgresql://host/db")
