from types import SimpleNamespace

import _db
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

    def test_invalid_scheme(self, tmp_path):
        env_file = tmp_path / ".env"
        env_file.write_text("DB_URL=mysql://localhost/testdb\n")
        with pytest.raises(
            DbError, match="URL must start with postgres:// or postgresql://"
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
        tables=lambda url, schema: [{"name": "Order Items"}],
        describe=lambda url, table, schema: {
            "name": table,
            "columns": [],
            "primary_key": [],
            "foreign_keys": [],
        },
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
