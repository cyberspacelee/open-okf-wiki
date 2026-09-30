"""Databases in repo-wiki.yaml: parsing, repository binding, and okf db end to end
against a fake catalog."""

import json

import pytest

import _config
import _db
import _page
import _validate
import okf
from _config import ConfigError, SchemaRule
from helpers import commit, git_repo
from test_db import FakeConn

HUB_DBS = """lang: en
sources: [order-api, order-worker, billing]
databases:
  - name: order_db
    url_env: ORDER_DB_URL
    repos: [order-api, order-worker]
    schemas:
      - name: public
        include: ["t_order*", "*_config"]
        exclude: ["*_bak"]
      - tenant_*
  - name: billing_db
    url_env: BILLING_DB_URL
    repos: [billing]
"""


def _hub(tmp_path, config=HUB_DBS):
    names = ("order-api", "order-worker", "billing")
    hub = git_repo(tmp_path / "hub", {".gitignore": "".join(f"/{n}/\n" for n in names)})
    git_repo(hub / "order-api", {"src/Order.java": 'String SQL = "select * from t_order";\n'})
    git_repo(hub / "order-worker", {"src/Job.java": 'String SQL = "update customer set x = 1";\n'})
    git_repo(hub / "billing", {"src/Bill.java": 'String SQL = "select * from invoice";\n'})
    commit(hub, {"docs/wiki/repo-wiki.yaml": config})
    return hub


def test_databases_parse_with_bindings_rules_and_defaults(tmp_path):
    ws = _config.load(_hub(tmp_path))
    order, billing = ws.databases
    assert order.name == "order_db" and order.url_env == "ORDER_DB_URL"
    assert order.repos == ("order-api", "order-worker")
    assert order.schemas == (
        SchemaRule("public", ("t_order*", "*_config"), ("*_bak",)),
        SchemaRule("tenant_*"),
    )
    # A database without schemas takes every table of public.
    assert billing.repos == ("billing",) and billing.schemas == (SchemaRule("public"),)
    assert ws.database("billing_db") is billing
    with pytest.raises(ConfigError, match="order_db, billing_db"):
        ws.database("nope")


def test_rules_match_prefix_suffix_and_exclude():
    rule = SchemaRule("public", ("t_order*", "*_config"), ("*_bak",))
    assert [t for t in ("t_order", "t_order_item", "t_order_bak", "sys_config", "user", "T_ORDER")
            if rule.takes(t)] == ["t_order", "t_order_item", "sys_config"]
    assert SchemaRule("tenant_*").matches_schema("tenant_a") and not SchemaRule("tenant_*").matches_schema("public")


def test_single_repository_binds_itself(tmp_path):
    repo = git_repo(tmp_path / "r", {"docs/wiki/repo-wiki.yaml": (
        "lang: en\ndatabases:\n  - name: app\n    url_env: APP_DB_URL\n")})
    (db,) = _config.load(repo).databases
    assert db.repos == (".",) and db.schemas == (SchemaRule("public"),)


@pytest.mark.parametrize("databases, match", [
    ("databases: []\n", "non-empty list of databases"),
    ("databases:\n  - name: a\n    url: opengauss://u:p@h/db\n", "unknown keys url.*never a URL"),
    ("databases:\n  - name: a\n    url_env: opengauss://h/db\n", "never the URL itself"),
    ("databases:\n  - name: ../x\n    url_env: A\n", "plain name"),
    ("databases:\n  - {name: a, url_env: A}\n  - {name: a, url_env: B}\n", "listed twice"),
    ("databases:\n  - {name: a, url_env: A, repos: [x]}\n", "only for a hub"),
    ("databases:\n  - name: a\n    url_env: A\n    schemas:\n      - name: public\n        include: []\n",
     "table name globs"),
    ("databases:\n  - name: a\n    url_env: A\n    schemas:\n      - name: public\n        exclude:\n          - *_bak\n",
     "quote globs that start with"),
    ("databases:\n  - name: a\n    url_env: A\n    schemas: [public, public]\n", "listed twice"),
    ("databases:\n  - name: a\n    url_env: A\n    schemas:\n      - {name: public, only: [x]}\n",
     "unknown keys only"),
])
def test_bad_databases(tmp_path, databases, match):
    repo = git_repo(tmp_path / "r", {"docs/wiki/repo-wiki.yaml": "lang: en\n" + databases})
    with pytest.raises(ConfigError, match=match):
        _config.load(repo)


@pytest.mark.parametrize("repos, match", [
    ("", "repos must list the hub sources"),
    ("    repos: [web]\n", "not a source; use one of: order-api"),
    ("    repos: [billing, billing]\n", "twice"),
])
def test_hub_databases_need_known_repos(tmp_path, repos, match):
    config = "lang: en\nsources: [order-api, order-worker, billing]\ndatabases:\n  - name: a\n    url_env: A\n" + repos
    with pytest.raises(ConfigError, match=match):
        _config.load(_hub(tmp_path, config))


# --- okf db against a fake catalog ---------------------------------------------------


def _catalog():
    return FakeConn({
        "schemas": [("public",), ("tenant_a",)],
        ("tables", "public"): [(10, "t_order", "", "r", "p"), (11, "t_order_bak", "", "r", "p"),
                               (12, "customer", "", "r", "p"), (13, "sys_config", "", "r", "p")],
        ("tables", "tenant_a"): [(20, "t_order", "", "r", "p")],
        ("columns", 10): [(1, "id", "bigint", False, None, "")],
    })


def _run(hub, monkeypatch, capsys, *argv, code=0):
    monkeypatch.chdir(hub)
    assert okf.main([*argv, "--json"]) == code
    return json.loads(capsys.readouterr().out)


def test_db_tables_reports_matches_and_the_code_gaps_of_bound_repos(tmp_path, monkeypatch, capsys):
    hub = _hub(tmp_path)
    monkeypatch.setenv("ORDER_DB_URL", "opengauss://reader@db:5432/orders")
    monkeypatch.setattr(_db, "_connect", lambda _url: _catalog())
    out = _run(hub, monkeypatch, capsys, "db", "tables", "--db", "order_db")
    (db,) = out["databases"]
    assert db["name"] == "order_db" and db["repos"] == ["order-api", "order-worker"]
    assert db["schemas"] == [
        {"schema": "public", "tables": ["t_order", "sys_config"], "excluded": ["t_order_bak"], "skipped": 1},
        {"schema": "tenant_a", "tables": ["t_order"], "excluded": [], "skipped": 0},
    ]
    # order-worker's code updates customer, which the rules leave out; billing's
    # invoice is not bound to this database and is not reported.
    assert [(g["table"], g["reason"]) for g in db["code_not_taken"]] == [("customer", "not included")]
    assert db["code_not_taken"][0]["locator"] == "order-worker/src/Job.java#L1"
    assert db["code_not_found"] == []


def test_db_capture_writes_per_database_pages_removes_dropped_ones_and_reports_failures(
        tmp_path, monkeypatch, capsys):
    hub = _hub(tmp_path)
    monkeypatch.setenv("ORDER_DB_URL", "opengauss://reader@db:5432/orders")
    monkeypatch.delenv("BILLING_DB_URL", raising=False)
    monkeypatch.setattr(_db, "_connect", lambda _url: _catalog())
    out = _run(hub, monkeypatch, capsys, "db", "capture", code=1)
    order, billing = out["databases"]
    assert billing["name"] == "billing_db" and billing["error"].startswith("Variable 'BILLING_DB_URL' not found")
    assert order["pages"] == [
        "docs/wiki/databases/order_db/public.md",
        "docs/wiki/databases/order_db/public/sys_config.md",
        "docs/wiki/databases/order_db/public/t_order.md",
        "docs/wiki/databases/order_db/tenant_a.md",
        "docs/wiki/databases/order_db/tenant_a/t_order.md",
    ]
    assert order["written"] == order["pages"] and order["removed"] == []
    ws = _config.load(hub)
    table = _page.load_page(ws, "databases/order_db/tenant_a/t_order.md")
    assert table.meta["db"]["repos"] == ["order-api", "order-worker"]
    # Narrow the rules: the tenant pages go, nothing else is touched.
    narrowed = HUB_DBS.replace("      - tenant_*\n", "")
    (hub / "docs/wiki/repo-wiki.yaml").write_text(narrowed, encoding="utf-8")
    out = _run(hub, monkeypatch, capsys, "db", "capture", "--db", "order_db")
    (order,) = out["databases"]
    assert order["written"] == [] and order["removed"] == [
        "docs/wiki/databases/order_db/tenant_a.md", "docs/wiki/databases/order_db/tenant_a/t_order.md"]


def test_db_commands_need_configured_databases(tmp_path, monkeypatch, capsys):
    repo = git_repo(tmp_path / "r", {"docs/wiki/repo-wiki.yaml": "lang: en\n"})
    out = _run(repo, monkeypatch, capsys, "db", "tables", code=2)
    assert "no databases in docs/wiki/repo-wiki.yaml" in out["error"]


def test_linking_a_table_of_an_unbound_database_warns(tmp_path, monkeypatch, capsys):
    hub = _hub(tmp_path)
    monkeypatch.setenv("ORDER_DB_URL", "opengauss://reader@db:5432/orders")
    monkeypatch.setattr(_db, "_connect", lambda _url: _catalog())
    monkeypatch.setattr(_db, "resolve_url", lambda _root, env: "opengauss://db/x")
    _run(hub, monkeypatch, capsys, "db", "capture", "--db", "order_db")
    ws = _config.load(hub)
    commit(hub, {}, "capture")
    for name, scope in (("billing", "billing/src/**"), ("orders", "order-api/src/**")):
        page = _page.new_page(ws, "Module", name, "d", [scope])
        page.body = "Writes [t_order](/databases/order_db/public/t_order.md).\n"
        _page.write_page(page)
    found = [(i.page, i.severity) for i in _validate.validate(ws) if i.code == "db-binding"]
    assert found == [("sources/billing/modules/billing.md", "warning")]


def test_status_asks_for_a_capture_while_discovering(tmp_path):
    import _status

    repo = git_repo(tmp_path / "r", {"src/a.py": "x = 1\n"})
    ws = _config.init(repo)
    config = ws.wiki / _config.CONFIG
    config.write_text(config.read_text() + "databases:\n  - name: app\n    url_env: APP_DB_URL\n")
    commit(repo, {}, "wiki")
    status = _status.status(repo)
    assert status["phase"] == "discover"
    assert any("okf db capture: databases app have no pages yet" in a for a in status["next_actions"])
