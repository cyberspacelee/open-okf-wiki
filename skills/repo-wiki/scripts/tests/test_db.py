import json
import shutil
from types import SimpleNamespace

import _db
import _state
import _validate
import _workspace
import okf
import pytest
from _db import DbError, describe, load_env, resolve_url, tables


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


def test_workspace_rejects_postgres_source_kind(tmp_path):
    _workspace.init(tmp_path)
    path = tmp_path / "workspace.json"
    config = json.loads(path.read_text())
    config["sources"] = [
        {
            "name": "database",
            "kind": "postgres",
            "url_env": "DB_URL",
            "schema": "public",
            "tables": ["orders"],
        }
    ]
    path.write_text(json.dumps(config))
    with pytest.raises(_workspace.WorkspaceError, match="invalid source"):
        _workspace.load(tmp_path)


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
    compact = _db.compact_table(result)
    assert set(compact) == {
        "schema",
        "name",
        "comment",
        "relation_kind",
        "persistence",
        "columns",
        "primary_key",
        "foreign_keys",
    }
    assert "default" not in compact["columns"][2]
    assert set(compact["foreign_keys"][0]) == {
        "name",
        "columns",
        "ref_schema",
        "ref_table",
        "ref_columns",
    }
    constraint_sql = next(sql for sql, _ in conn.sql if "pg_constraint" in sql)
    assert "constraint_name" not in constraint_sql
    assert "con.conrelid = %s" in constraint_sql
    assert "condisable" not in constraint_sql


def _described_table(comment="line items"):
    return {
        "schema": "Public Data",
        "name": "Order Items",
        "comment": comment,
        "relation_kind": "table",
        "persistence": "permanent",
        "columns": [
            {
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


def _capture(tmp_path, monkeypatch, comment="line items"):
    monkeypatch.setenv(
        "DB_URL", "opengauss://secret:token@db.example:5432/app?sslmode=require"
    )
    return _db.capture_catalog(
        tmp_path,
        SimpleNamespace(
            name="appdb",
            url_env="DB_URL",
            schema="Public Data",
            tables=("Order Items",),
        ),
        inspect=lambda _url, _schema, _selected: (
            {
                "opengauss_version": "7.0.0",
                "working_version_num": 70000,
                "deployment": "OpenSourceCentralized",
                "server_version": "openGauss 7.0.0 build abc",
                "database": "app",
            },
            [_described_table(comment)],
        ),
    )


def test_capture_uses_one_connection_and_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_URL", "opengauss://localhost/app")
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
    _db.capture_catalog(
        tmp_path,
        SimpleNamespace(
            name="appdb",
            url_env="DB_URL",
            schema="public",
            tables=("orders", "customers"),
        ),
    )

    assert connections == [conn]
    assert sum(sql.startswith("begin transaction") for sql, _ in conn.sql) == 1
    assert sum("opengauss_version()" in sql for sql, _ in conn.sql) == 1


def test_catalog_is_manifest_plus_hash_checked_table_shards(tmp_path, monkeypatch):
    catalog = _capture(tmp_path, monkeypatch)
    directory = _db.catalog_dir(tmp_path, catalog["storage_key"])
    manifest = json.loads((directory / "catalog.json").read_text())
    table = manifest["tables"][0]

    assert set(catalog) == {"name", "content_hash", "storage_key"}
    assert not (directory / "index.json").exists()
    assert "columns" not in manifest["tables"][0]
    assert manifest["tables"][0]["path"].startswith("tables/")
    assert manifest["tables"][0]["content_hash"] == table["content_hash"]
    assert table["column_count"] == 1
    assert table["foreign_key_count"] == 0
    assert table["index_count"] == 0
    assert "secret" not in json.dumps(manifest)
    assert "token" not in json.dumps(manifest)
    assert manifest["resource"] == "appdb/."
    assert table["resource"] == "appdb/Order%20Items"
    assert "db.example" not in json.dumps(manifest)
    assert table["page_slug"].startswith("order-items-")

    payload = _db.load_catalog(tmp_path, catalog["storage_key"])
    assert payload["tables"][0]["columns"][0]["type"] == "bigint"
    assert _db.load_index(tmp_path, catalog["storage_key"]) == manifest
    expected_tables = [
        {
            "source": "appdb",
            "schema": "Public Data",
            "count": 1,
            "tables": ["Order Items"],
        }
    ]
    assert _db.tables_captured(tmp_path, [catalog]) == expected_tables
    summary = _db.tables_captured(tmp_path, [catalog], summary=True)[0]["tables"][0]
    assert summary == {
        "name": "Order Items",
        "comment": "line items",
        "column_count": 1,
        "foreign_key_count": 0,
        "index_count": 0,
    }
    assert (
        _db.describe_captured(tmp_path, [catalog], "Order Items")["comment"]
        == "line items"
    )
    assert "indexes" not in _db.describe_captured(tmp_path, [catalog], "Order Items")
    assert "indexes" in _db.describe_captured(
        tmp_path, [catalog], "Order Items", full=True
    )
    with pytest.raises(DbError, match="Captured catalog 'missing' not found"):
        _db.tables_captured(tmp_path, [catalog], "missing")

    shard = directory / manifest["tables"][0]["path"]
    changed = json.loads(shard.read_text())
    changed["comment"] = "tampered"
    shard.write_text(json.dumps(changed))
    with pytest.raises(DbError, match="integrity check"):
        _db.load_table(tmp_path, catalog["storage_key"], table["page_slug"])


def test_table_commands_emit_names_or_compact_json(tmp_path, monkeypatch, capsys):
    summary = {
        "database": "app",
        "schema": "public",
        "count": 2,
        "tables": ["customers", "orders"],
    }
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(_db, "resolve_url", lambda _root, _env: "opengauss://db/app")
    monkeypatch.setattr(_db, "tables", lambda _url, _schema: summary)

    assert okf.cmd_db(okf.build_parser().parse_args(["db", "tables"])) == 0
    assert capsys.readouterr().out == "customers\norders\n"

    assert okf.cmd_db(okf.build_parser().parse_args(["db", "tables", "--json"])) == 0
    assert json.loads(capsys.readouterr().out) == summary

    monkeypatch.setattr(
        _db, "describe", lambda _url, table, _schema: {"name": table, "columns": []}
    )
    args = okf.build_parser().parse_args(["db", "describe", "orders"])
    assert okf.cmd_db(args) == 0
    assert capsys.readouterr().out == "name: orders\ncolumns: []\n"


def test_catalog_tables_keeps_list_shape_and_emits_names(tmp_path, monkeypatch, capsys):
    catalog = _capture(tmp_path, monkeypatch)
    monkeypatch.setattr(okf, "workspace_root", lambda: tmp_path)
    monkeypatch.setattr(_state, "read", lambda _root: {"catalogs": [catalog]})

    args = okf.build_parser().parse_args(["catalog", "tables", "--source", "appdb"])
    assert okf.cmd_catalog(args) == 0
    assert capsys.readouterr().out == "Order Items\n"

    args = okf.build_parser().parse_args(
        ["catalog", "tables", "--source", "appdb", "--json"]
    )
    assert okf.cmd_catalog(args) == 0
    assert json.loads(capsys.readouterr().out) == [
        {
            "source": "appdb",
            "schema": "Public Data",
            "count": 1,
            "tables": ["Order Items"],
        }
    ]


def test_catalog_hash_aggregates_table_hashes(tmp_path, monkeypatch):
    first = _capture(tmp_path, monkeypatch, "first")
    second = _capture(tmp_path, monkeypatch, "second")
    first_table = _db.load_index(tmp_path, first["storage_key"])["tables"][0]
    second_table = _db.load_index(tmp_path, second["storage_key"])["tables"][0]
    assert first_table["content_hash"] != second_table["content_hash"]
    assert first["content_hash"] != second["content_hash"]
    assert first["storage_key"] != second["storage_key"]


def test_catalog_state_record_size_does_not_grow_with_table_count():
    payload = {
        "name": "database",
        "tables": [{"name": f"table_{index:03d}"} for index in range(195)],
    }
    content_hash = "a" * 64
    record = _db.catalog_record(
        payload,
        content_hash,
        _db.catalog_storage_key(payload["name"], content_hash),
    )

    assert set(record) == {"name", "content_hash", "storage_key"}
    assert len(json.dumps(record).encode()) < 256


def test_catalog_record_hash_must_match_the_stored_manifest(tmp_path, monkeypatch):
    catalog = _capture(tmp_path, monkeypatch)
    changed_hash = "f" * 64
    changed_key = _db.catalog_storage_key(catalog["name"], changed_hash)
    shutil.copytree(
        _db.catalog_dir(tmp_path, catalog["storage_key"]),
        _db.catalog_dir(tmp_path, changed_key),
    )
    record = {**catalog, "content_hash": changed_hash, "storage_key": changed_key}

    assert not _validate._catalog_record_valid(tmp_path, record)


def test_psycopg_url_only_translates_opengauss():
    assert _db._psycopg_url("opengauss://host/db") == "postgresql://host/db"
    with pytest.raises(DbError, match="opengauss://"):
        _db._psycopg_url("postgresql://host/db")
