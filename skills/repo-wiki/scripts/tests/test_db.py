from types import SimpleNamespace

import _db
import pytest
from _db import DbError, describe, load_env, resolve_url, tables


class TestLoadEnv:
    def test_empty_env_file(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("")
        result = load_env(tmp_path)
        assert result == {}

    def test_simple_key_value(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("KEY=value\n")
        result = load_env(tmp_path)
        assert result == {"KEY": "value"}

    def test_multiple_entries(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("KEY1=value1\nKEY2=value2\n")
        result = load_env(tmp_path)
        assert result == {"KEY1": "value1", "KEY2": "value2"}

    def test_comments_ignored(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("# Comment\nKEY=value\n# Another comment\n")
        result = load_env(tmp_path)
        assert result == {"KEY": "value"}

    def test_empty_lines_ignored(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("KEY1=value1\n\n\nKEY2=value2\n")
        result = load_env(tmp_path)
        assert result == {"KEY1": "value1", "KEY2": "value2"}

    def test_double_quotes(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text('KEY="quoted value"\n')
        result = load_env(tmp_path)
        assert result == {"KEY": "quoted value"}

    def test_single_quotes(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("KEY='quoted value'\n")
        result = load_env(tmp_path)
        assert result == {"KEY": "quoted value"}

    def test_whitespace_handling(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("  KEY  =  value  \n")
        result = load_env(tmp_path)
        assert result == {"KEY": "value"}

    def test_no_env_file(self, tmp_path):
        result = load_env(tmp_path)
        assert result == {}


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

    def test_invalid_scheme(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("DB_URL=mysql://localhost/testdb\n")
        with pytest.raises(
            DbError, match="URL must start with postgres:// or postgresql://"
        ):
            resolve_url(tmp_path, "DB_URL")


class TestTablesImportError:
    def test_psycopg_import_error(self, tmp_path, monkeypatch):
        def mock_import(name, *args, **kwargs):
            if name == "psycopg":
                raise ImportError("psycopg not found")
            return __import__(name, *args, **kwargs)

        monkeypatch.setattr("builtins.__import__", mock_import)
        with pytest.raises(DbError, match="db 功能需要 psycopg,其余功能不受影响"):
            tables("postgresql://localhost/testdb")


class TestDescribeImportError:
    def test_psycopg_import_error(self, tmp_path, monkeypatch):
        def mock_import(name, *args, **kwargs):
            if name == "psycopg":
                raise ImportError("psycopg not found")
            return __import__(name, *args, **kwargs)

        monkeypatch.setattr("builtins.__import__", mock_import)
        with pytest.raises(DbError, match="db 功能需要 psycopg,其余功能不受影响"):
            describe("postgresql://localhost/testdb", "test_table")


def test_captured_catalog_has_safe_slug_and_credential_free_resource(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DB_URL", "postgresql://secret:token@db.example:5432/app")
    monkeypatch.setattr(_db, "tables", lambda url, schema: [{"name": "Order Items"}])
    monkeypatch.setattr(
        _db,
        "describe",
        lambda url, table, schema: {
            "name": table,
            "columns": [],
            "primary_key": [],
            "foreign_keys": [],
        },
    )
    catalog = _db.capture_catalog(
        tmp_path,
        SimpleNamespace(
            name="appdb",
            url_env="DB_URL",
            schema="Public Data",
            tables=("Order Items",),
        ),
    )
    table = catalog["tables"][0]
    assert "secret" not in catalog["resource"] and "token" not in catalog["resource"]
    assert catalog["resource"].endswith("/Public%20Data")
    assert table["page_slug"].startswith("order-items-")
    assert table["resource"].endswith("/Order%20Items")
    assert (
        tmp_path
        / ".okf-wiki"
        / "catalogs"
        / catalog["content_hash"]
        / "catalog.json"
    ).is_file()
