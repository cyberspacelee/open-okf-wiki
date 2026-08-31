from types import SimpleNamespace

import _db
import _validate
import pytest
from _db import DbError, describe, load_env, resolve_url, tables


@pytest.mark.parametrize(
    "content, expected",
    [
        ("", {}),
        ("KEY=value\n", {"KEY": "value"}),
        ("KEY1=value1\nKEY2=value2\n", {"KEY1": "value1", "KEY2": "value2"}),
        ("# Comment\nKEY=value\n# Another comment\n", {"KEY": "value"}),
        ("KEY1=value1\n\n\nKEY2=value2\n", {"KEY1": "value1", "KEY2": "value2"}),
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


class TestResolveUrl:
    def test_resolve_from_environ(self, tmp_path, monkeypatch):
        monkeypatch.setenv("APP_DATABASE_URL", "postgresql://localhost/testdb")
        url = resolve_url(tmp_path, "APP_DATABASE_URL")
        assert url == "postgresql://localhost/testdb"

    def test_resolve_from_env_file(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("APP_DATABASE_URL=postgresql://localhost/testdb\n")
        url = resolve_url(tmp_path, "APP_DATABASE_URL")
        assert url == "postgresql://localhost/testdb"

    def test_resolve_with_var_syntax(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("APP_DATABASE_URL=postgresql://localhost/testdb\n")
        url = resolve_url(tmp_path, "${APP_DATABASE_URL}")
        assert url == "postgresql://localhost/testdb"

    def test_environ_takes_precedence(self, tmp_path, monkeypatch):
        monkeypatch.setenv("APP_DATABASE_URL", "postgresql://environ/testdb")
        env_file = tmp_path / ".env"
        env_file.write_text("APP_DATABASE_URL=postgresql://file/testdb\n")
        url = resolve_url(tmp_path, "APP_DATABASE_URL")
        assert url == "postgresql://environ/testdb"

    def test_variable_not_found(self, tmp_path):
        with pytest.raises(DbError, match="Variable 'MISSING_VAR' not found"):
            resolve_url(tmp_path, "MISSING_VAR")

    def test_postgres_scheme(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("DB_URL=postgres://localhost/testdb\n")
        url = resolve_url(tmp_path, "DB_URL")
        assert url == "postgres://localhost/testdb"

    def test_postgresql_scheme(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("DB_URL=postgresql://localhost/testdb\n")
        url = resolve_url(tmp_path, "DB_URL")
        assert url == "postgresql://localhost/testdb"

    def test_opengauss_scheme(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("DB_URL=opengauss://localhost/testdb\n")
        url = resolve_url(tmp_path, "DB_URL")
        assert url == "opengauss://localhost/testdb"

    def test_invalid_scheme(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("DB_URL=mysql://localhost/testdb\n")
        with pytest.raises(
            DbError,
            match="URL must start with postgres://, postgresql:// or opengauss://",
        ):
            resolve_url(tmp_path, "DB_URL")


@pytest.mark.parametrize(
    "fn, args",
    [
        (tables, ("postgresql://localhost/testdb",)),
        (describe, ("postgresql://localhost/testdb", "test_table")),
    ],
)
def test_psycopg_import_error(monkeypatch, fn, args):
    import builtins

    real_import = builtins.__import__

    def mock_import(name, *args, **kwargs):
        if name == "psycopg":
            raise ImportError("psycopg not found")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", mock_import)
    with pytest.raises(
        DbError, match="db commands require psycopg; other commands are unaffected"
    ):
        fn(*args)


class FakeCursor:
    def __init__(self, responses):
        self.responses = responses
        self.sql = []
        self._rows = []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        lowered = " ".join(sql.lower().split())
        if "pg_description" in lowered:
            key = "columns"
        elif "primary key" in lowered:
            key = "pk"
        elif "foreign key" in lowered:
            key = "fk"
        elif "obj_description" in lowered and "c.relname," in lowered.replace(" ", ""):
            key = "tables"
        elif "obj_description" in lowered:
            key = "table_comment"
        else:
            key = None
        self._rows = self.responses.get(key, []) if key else []

    def fetchall(self):
        return self._rows

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, responses):
        self.cursor_obj = FakeCursor(responses)

    def cursor(self):
        return self.cursor_obj

    def close(self):
        pass


def test_psycopg_url_rewrites_opengauss_scheme():
    assert _db._psycopg_url("opengauss://host/db") == "postgresql://host/db"
    assert _db._psycopg_url("postgresql://host/db") == "postgresql://host/db"


def test_describe_reads_table_and_column_comments(monkeypatch):
    conn = FakeConn(
        {
            "columns": [
                ("id", "integer", "NO", None, "primary key"),
                ("name", "text", "YES", None, "display name"),
            ],
            "table_comment": [("customer orders",)],
            "pk": [("orders_pkey", "id")],
            "fk": [],
        }
    )
    monkeypatch.setattr(_db, "_connect", lambda url: conn)
    result = describe("postgresql://localhost/app", "orders")
    assert result["comment"] == "customer orders"
    assert result["columns"][0]["comment"] == "primary key"
    assert result["columns"][1]["comment"] == "display name"
    assert result["columns"][0]["nullable"] is False
    assert result["primary_key"] == ["id"]
    assert any("pg_description" in sql for sql in conn.cursor_obj.sql)


def test_tables_returns_table_comments(monkeypatch):
    conn = FakeConn({"tables": [("orders", "customer orders"), ("empty", None)]})
    monkeypatch.setattr(_db, "_connect", lambda url: conn)
    result = tables("postgresql://localhost/app")
    assert result == [
        {"name": "orders", "comment": "customer orders"},
        {"name": "empty", "comment": ""},
    ]


def test_captured_catalog_has_safe_slug_and_credential_free_resource(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DB_URL", "postgresql://secret:token@db.example:5432/app")
    catalog = _db.capture_catalog(
        tmp_path,
        SimpleNamespace(
            name="appdb",
            url_env="DB_URL",
            schema="Public Data",
            tables=("Order Items",),
        ),
        tables=lambda url, schema: [{"name": "Order Items", "comment": "line items"}],
        describe=lambda url, table, schema: {
            "name": table,
            "comment": "line items",
            "columns": [
                {
                    "name": "id",
                    "type": "integer",
                    "nullable": False,
                    "default": None,
                    "comment": "primary key",
                }
            ],
            "primary_key": ["id"],
            "foreign_keys": [],
        },
    )
    table = catalog["tables"][0]
    assert catalog["resource"].startswith("opengauss://")
    assert "secret" not in catalog["resource"] and "token" not in catalog["resource"]
    assert catalog["resource"].endswith("/Public%20Data")
    assert table["page_slug"].startswith("order-items-")
    assert table["resource"].endswith("/Order%20Items")
    assert "columns" not in table
    assert "comment" not in table
    assert catalog["storage_key"].startswith("appdb-")
    assert len(catalog["storage_key"]) < len(catalog["content_hash"])
    payload = _db.load_catalog(tmp_path, catalog["storage_key"])
    assert payload["tables"][0]["comment"] == "line items"
    assert payload["tables"][0]["columns"][0]["comment"] == "primary key"
    index = _db.load_index(tmp_path, catalog["storage_key"])
    assert index["tables"][0]["comment"] == "line items"
    assert "columns" not in index["tables"][0]
    shard = _db.load_table(tmp_path, catalog["storage_key"], table["page_slug"])
    assert shard["columns"][0]["comment"] == "primary key"
    assert _db.show_captured(tmp_path, [catalog]) == [index]
    assert (
        _db.describe_captured(tmp_path, [catalog], "Order Items")["comment"]
        == "line items"
    )
    assert _validate._catalog_record_valid(tmp_path, catalog)
    assert not _validate._catalog_record_valid(tmp_path, payload)


def test_capture_fills_table_comment_when_describe_omits_it(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_URL", "postgresql://localhost/app")
    catalog = _db.capture_catalog(
        tmp_path,
        SimpleNamespace(
            name="appdb",
            url_env="DB_URL",
            schema="public",
            tables=("orders",),
        ),
        tables=lambda url, schema: [{"name": "orders", "comment": "from tables()"}],
        describe=lambda url, table, schema: {
            "name": table,
            "columns": [],
            "primary_key": [],
            "foreign_keys": [],
        },
    )
    payload = _db.load_catalog(tmp_path, catalog["storage_key"])
    assert payload["tables"][0]["comment"] == "from tables()"
