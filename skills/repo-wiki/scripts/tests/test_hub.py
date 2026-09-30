"""Multi-source hubs (ADR 0028): derived page paths, per-source canon, contracts
between sources, layered indexes, the System map and the derived log."""

import json

import pytest

import _code
import _config
import _impact
import _page
import _scan
import _stamp
import _status
import _validate
from helpers import commit, git_repo, write
from hubkit import CLIENT, CONTRACTS, EXTERNAL, ORDER, RESERVE, complete_hub, hub
from kit import approve


def _set(ws, path, body=None, **meta):
    page = _page.load_page(ws, path)
    if body is not None:
        page.body = body
    page.meta = dict(page.meta) | meta
    _page.write_page(page)


def _codes(ws, code):
    return [i for i in _validate.validate(ws) if i.code == code]


def _stamped(tmp_path):
    root, ws = complete_hub(tmp_path)
    approve(ws)
    result = _stamp.stamp(ws, "repo-wiki/test")
    assert result["blocked"] == [], result["blocked"]
    commit(root, {}, "wiki v1")
    return root, ws


# --- contract sites ----------------------------------------------------------------------


@pytest.mark.parametrize("path, text, expected", [
    ("A.java",
     ('@RestController\n@RequestMapping("/api/orders")\nclass A {\n  @GetMapping("/{id}")\n  X get() {}\n'
     '  @RequestMapping(value = "/{id}/cancel", method = RequestMethod.POST)\n  void cancel() {}\n}\n'),
     {("http", "GET /api/orders/{}", "provider"), ("http", "POST /api/orders/{}/cancel", "provider")}),
    ("C.java",
     '@FeignClient(name = "inventory", path = "/api")\ninterface C {\n  @PostMapping("/items/{id}")\n  void r();\n}\n',
     {("http", "POST /api/items/{}", "consumer")}),
    ("R.java",
     '@Path("/1.0/kb/accounts")\nclass R {\n  @Path("/{accountId}")\n  @GET\n  X get() {}\n  @POST\n  X add() {}\n}\n',
     {("http", "GET /1.0/kb/accounts/{}", "provider"), ("http", "POST /1.0/kb/accounts", "provider")}),
    ("T.java",
     ('class T { void f() { rest.postForObject("http://billing/v1/invoices", x, Y.class);'
     ' web.get().uri("/v1/items/{id}", 1); } }\n'),
     {("http", "POST /v1/invoices", "consumer"), ("http", "GET /v1/items/{}", "consumer")}),
    ("S.java", "@DubboService\npublic class InventoryServiceImpl implements InventoryService {}\n",
     {("rpc", "InventoryService", "provider")}),
    ("U.java", ("class U { @DubboReference private InventoryService inventory;"
               " void f() { PaymentGrpc.newBlockingStub(ch); } }\n"),
     {("rpc", "InventoryService", "consumer"), ("rpc", "Payment", "consumer")}),
    ("G.java", "class G extends PaymentGrpc.PaymentImplBase {}\n", {("rpc", "Payment", "provider")}),
    ("L.java", '@KafkaListener(topics = "order-created")\nvoid on(String m) { template.send("audit", m); }\n',
     {("topic", "order-created", "consumer"), ("topic", "audit", "provider")}),
    ("D.java", ('class D { void f() { jdbc.query("select * from t_order join t_item on 1=1");'
               ' jdbc.update("delete from t_cart where id = ?"); } }\n'),
     {("table", "t_order", "consumer"), ("table", "t_item", "consumer"), ("table", "t_cart", "provider")}),
    ("app.py",
     ('router = APIRouter(prefix="/jobs")\n@router.post("/{job_id}/run")\ndef run(job_id): ...\n'
     '@app.route("/x", methods=["PUT"])\ndef x(): ...\n'
     'requests.get(f"{BASE}/api/orders/{oid}")\ncache.get("key")\n'),
     {("http", "POST /jobs/{}/run", "provider"), ("http", "PUT /x", "provider"),
      ("http", "GET /api/orders/{}", "consumer")}),
    ("urls.py", 'urlpatterns = [path("orders/<int:pk>/", view)]\n', {("http", "ANY /orders/{}", "provider")}),
    ("svc.py", "add_PaymentServicer_to_server(s, x)\nstub = payment_pb2_grpc.LedgerStub(ch)\n",
     {("rpc", "Payment", "provider"), ("rpc", "Ledger", "consumer")}),
    ("api.ts",
     ("app.get('/health', h);\nfetch(`${API}/api/orders/${id}`, { method: 'DELETE' });\n"
     "axios.post('/api/items');\n"),
     {("http", "GET /health", "provider"), ("http", "DELETE /api/orders/{}", "consumer"),
      ("http", "POST /api/items", "consumer")}),
    ("c.ts", "@Controller('orders')\nclass C {\n  @Get(':id')\n  one() {}\n}\n", {("http", "GET /orders/{}", "provider")}),
    ("main.go",
     ('mux.HandleFunc("POST /v1/pay", h)\nr.GET("/v1/items/:id", h)\nhttp.Get("http://billing/v1/invoices")\n'
     'pb.RegisterLedgerServer(s, x)\nc := pb.NewPaymentClient(conn)\n'),
     {("http", "POST /v1/pay", "provider"), ("http", "GET /v1/items/{}", "provider"),
      ("http", "GET /v1/invoices", "consumer"), ("rpc", "Ledger", "provider"), ("rpc", "Payment", "consumer")}),
    ("O.cs",
     ('[Route("api/[controller]")]\npublic class OrdersController : ControllerBase {\n'
     '  [HttpGet("{id}")] public IActionResult Get(int id) {}\n}\n'),
     {("http", "GET /api/orders/{}", "provider")}),
    ("x.sql", "insert into t_audit select * from t_order;\n",
     {("table", "t_audit", "provider"), ("table", "t_order", "consumer")}),
    ("A.java", "// @PostMapping(\"/commented\")\nclass A {}\n", set()),
])
def test_contract_sites(path, text, expected):
    assert {(s.kind, s.key, s.role) for s in _code.contract_sites(path, text)} == expected


def test_contract_ids_normalize():
    assert _code.normalize_http_path("https://inv:8080/api/v1/items/{id}?x=1") == "/api/v1/items/{}"
    assert _code.normalize_http_path("${BASE}/Orders/:id/") == "/orders/{}"
    assert _code.normalize_http_path("orders/{id}") is None  # a client URL starts with a slash or a host
    assert _code.normalize_http_path("orders/{id}", route=True) == "/orders/{}"
    assert _code.normalize_http_path("/{id}") is None  # nothing but a parameter
    assert _code.normalize_contract_id("  http post  /Orders/<int:pk>/ ") == "http POST /orders/{}"
    assert _code.normalize_contract_id("http * /orders/*") == "http * /orders/*"
    assert _page.contract_match("http * /api/*", "http POST /api/orders")
    assert _page.contract_match("topic order-*", "topic order-created")
    assert not _page.contract_match("topic order", "topic order-created")


# --- contracts between sources ------------------------------------------------------------


def test_contracts_match_sites_across_sources(tmp_path):
    _root, ws = hub(tmp_path)
    found = {c.id: c for c in _scan.contracts(ws)}
    assert sorted(found) == sorted(CONTRACTS + [EXTERNAL])
    reserve = found["http POST /reservations/{}"]
    assert [(s.source, s.locator) for s in reserve.providers] == [("worker", f"{RESERVE}#L4")]
    assert [(s.source, s.locator) for s in reserve.consumers] == [("api", f"{CLIENT}#L4")]
    topic = found["topic order-created"]
    assert [s.source for s in topic.providers] == ["api"] and [s.source for s in topic.consumers] == ["worker"]
    assert found[EXTERNAL].external and not found[EXTERNAL].providers
    assert not any(c.id == "table t_reservation" for c in found.values())  # one source only
    scanned = _scan.scan(ws)["contracts"]
    assert scanned == [c.to_dict() for c in _scan.contracts(ws)]
    assert scanned[-1] == {"id": EXTERNAL, "kind": "http", "providers": [],
                           "consumers": [{"source": "web", "locator": "web/src/api.ts#L2"}], "external": True}


def test_cross_source_imports_are_library_contracts(tmp_path):
    root = git_repo(tmp_path / "hub", {"README.md": "hub\n"})
    git_repo(root / "api", {"app/main.py": "from shared.money import cents\n"})
    git_repo(root / "lib", {"shared/__init__.py": "", "shared/money.py": "def cents(x):\n    return x\n"})
    ws = _config.init(root, hub_sources=["api", "lib"])
    (contract,) = _scan.contracts(ws)
    assert contract.id == "library lib/shared"
    assert [s.locator for s in contract.consumers] == ["api/app/main.py#L1"]


def test_a_single_repository_has_no_contracts(tmp_path):
    from kit import repo

    _, ws = repo(tmp_path)
    assert _scan.contracts(ws) == [] and _scan.scan(ws)["contracts"] == []


# --- layout ---------------------------------------------------------------------------------


def test_init_creates_system_and_source_canon(tmp_path):
    root, ws = hub(tmp_path)
    assert list(_page.canon(ws)) == [
        "glossary.md", "conventions.md", "architecture.md",
        "sources/api/conventions.md", "sources/api/overview.md",
        "sources/worker/conventions.md", "sources/worker/overview.md",
        "sources/web/conventions.md", "sources/web/overview.md",
    ]
    overview = _page.load_page(ws, "sources/api/overview.md")
    assert overview.type == "Overview" and overview.meta["title"] == "api overview"
    assert _page.role(ws, _page.load_page(ws, "architecture.md")) == "system-architecture"
    assert _page.role(ws, _page.load_page(ws, "conventions.md")) == "system-conventions"
    assert _page.role(ws, _page.load_page(ws, "sources/web/conventions.md")) == "conventions"
    assert "## Contracts" in _page.load_page(ws, "architecture.md").body
    (ws.wiki / "sources/web/overview.md").unlink()
    missing = _codes(ws, "canon-missing")
    assert [(i.page, i.fix) for i in missing] == [
        ("sources/web/overview.md", "Create it with okf new --type Overview --source web.")]
    status = _status.status(root)
    assert status["phase"] == "research"
    assert status["next_actions"] == ["recreate the canon page: okf new --type Overview --source web"]


def test_page_paths_derive_from_type_scope_and_source(tmp_path):
    _, ws = hub(tmp_path)
    assert _page.page_path(ws, "Module", "orders", scope=["api/src/**"]) == "sources/api/modules/orders.md"
    assert _page.page_path(ws, "Workflow", "w", scope=[ORDER]) == "sources/api/workflows/w.md"
    assert _page.page_path(ws, "Flow", "checkout", scope=[ORDER, RESERVE]) == "flows/checkout.md"
    assert _page.page_path(ws, "Conventions", source="web") == "sources/web/conventions.md"
    assert _page.page_path(ws, "Conventions") == "conventions.md"
    for type, name, scope, source, message in (
        ("Module", "x", ["api/src/**", "worker/src/**"], None, "stay inside one source"),
        ("Module", "x", ["*/src/**"], None, "stay inside one source"),
        ("Flow", "x", [ORDER], None, "two or more sources"),
        ("Overview", None, [], None, "needs its source"),
        ("Overview", None, [], "nope", "not configured"),
        ("Module", "x", ["api/src/**"], "worker", "does not match the scope"),
    ):
        with pytest.raises(_page.PageError, match=message):
            _page.page_path(ws, type, name, source, scope)


def test_new_page_in_a_hub(tmp_path):
    _, ws = hub(tmp_path)
    flow = _page.new_page(ws, "Flow", "checkout", "Read before checkout.", [ORDER, RESERVE],
                          contracts=["http POST /reservations/*"])
    assert flow.path == "flows/checkout.md" and flow.contracts == ["http POST /reservations/*"]
    assert "## Call chain" in flow.body
    with pytest.raises(_page.PageError, match="matches no contract"):
        _page.new_page(ws, "Flow", "other", "d", [ORDER, RESERVE], contracts=["topic nope"])
    with pytest.raises(_page.PageError, match="only Flow pages"):
        _page.new_page(ws, "Module", "m", "d", ["api/src/**"], contracts=["topic order-created"])
    (ws.wiki / "sources/web/overview.md").unlink()
    with pytest.raises(_page.PageError, match="has no scope"):
        _page.new_page(ws, "Overview", source="web", scope=["web/src/**"])
    assert _page.new_page(ws, "Overview", source="web").meta["title"] == "web overview"


def test_misplaced_pages_fail_page_path(tmp_path):
    _, ws = hub(tmp_path)
    meta = {"type": "Module", "title": "M", "description": "d", "scope": ["api/src/**"], "status": "draft",
            "revision": _page.current_revision(ws)}
    write(ws.wiki / "modules/m.md", meta, "Body.\n")
    write(ws.wiki / "sources/worker/modules/w.md", meta | {"scope": ["api/src/**"]}, "Body.\n")
    write(ws.wiki / "guides/conventions.md", meta | {"type": "Conventions", "scope": []}, "Body.\n")
    found = {i.page: i.message for i in _codes(ws, "page-path")}
    assert found == {
        "modules/m.md": "a Module page with this scope belongs at sources/api/modules/m.md",
        "sources/worker/modules/w.md": "a Module page with this scope belongs at sources/api/modules/w.md",
        "guides/conventions.md": "a Conventions page with this scope belongs at conventions.md",
    }


def test_log_and_index_are_never_pages(tmp_path):
    _, ws = hub(tmp_path)
    (ws.wiki / "log.md").write_text("# Update log\n", encoding="utf-8")
    (ws.wiki / "sources/api/log.md").write_text("# Update log\n", encoding="utf-8")
    assert not any(p.path.endswith("log.md") for p in _page.load_pages(ws))
    with pytest.raises(_page.PageError, match="reserved"):
        _page.new_page(ws, "Module", "log", "d", ["api/src/**"])


# --- contract validation --------------------------------------------------------------------


def test_complete_hub_validates(tmp_path):
    _, ws = complete_hub(tmp_path)
    issues = [i for i in _validate.validate(ws) if i.severity != "warning"]
    assert issues == []


def test_every_contract_is_claimed_or_excluded(tmp_path):
    _, ws = complete_hub(tmp_path)
    _set(ws, "flows/checkout.md", contracts=["http POST /reservations/{}"])
    unclaimed = {i.message.split(" (")[0] for i in _codes(ws, "link-coverage")}
    assert unclaimed == {"contract http POST /api/orders", "contract topic order-created"}
    assert all(i.page == "architecture.md" for i in _codes(ws, "link-coverage"))
    # A Not covered row matching a site file excludes the contract; a glob claim covers several.
    body = _page.load_page(ws, "architecture.md").body.replace(
        "|---|---|\n\n[^common]", "|---|---|\n| `web/src/api.ts` | The storefront is out of scope. |\n\n[^common]")
    _set(ws, "architecture.md", body)
    _set(ws, "flows/checkout.md", contracts=["http POST /reservations/*", "topic order-*"])
    assert _codes(ws, "link-coverage") == []
    assert not any(c.id == EXTERNAL for c in _validate.unclaimed_contracts(ws, _validate.Facts(ws),
                                                                           _page.load_pages(ws)))


def test_claims_name_contracts_and_are_backed_by_rows(tmp_path):
    _, ws = complete_hub(tmp_path)
    _set(ws, "flows/checkout.md", contracts=[
        "http POST /api/orders", "http POST /reservations/{}", "topic order-created", "topic gone"])
    assert [i.message for i in _codes(ws, "contract-claim")] == ["claimed contract 'topic gone' matches no contract"]
    body = _page.load_page(ws, "flows/checkout.md").body.replace("; `topic order-created`", "")
    _set(ws, "flows/checkout.md", body)
    assert [(i.page, i.message) for i in _codes(ws, "contract-row")] == [
        ("flows/checkout.md", "claimed contract topic order-created has no row in the call chain table")]
    _set(ws, "flows/checkout.md", "<!-- okf:todo\nstill tracing\n-->\n\n" + body)
    assert _codes(ws, "contract-row") == []  # a page being written is not held to its claims yet
    _set(ws, "architecture.md", _page.load_page(ws, "architecture.md").body.replace(
        "`library com.acme:common` |", "`topic nope` |"))
    assert [i.message for i in _codes(ws, "contract-row")] == [
        "claimed contract library com.acme:common has no row in the Contracts table"]
    unknown = _codes(ws, "contract-unknown")
    assert [(i.page, i.severity) for i in unknown] == [("architecture.md", "warning")]
    assert _codes(ws, "frontmatter") == []
    _set(ws, "sources/api/modules/orders.md", contracts=["topic order-created"])
    assert [i.message for i in _codes(ws, "frontmatter")] == ["a Module page cannot claim contracts"]


def test_contract_and_call_chain_rows_name_sources(tmp_path):
    _, ws = complete_hub(tmp_path)
    arch = _page.load_page(ws, "architecture.md").body.replace("| worker | api | Release", "| billing | api, nope | Release")
    _set(ws, "architecture.md", arch)
    flow = _page.load_page(ws, "flows/checkout.md").body.replace("| 3 | worker |", "| 3 | inventory |")
    _set(ws, "flows/checkout.md", flow)
    messages = sorted(i.message for i in _codes(ws, "table-values"))
    assert messages == ["Consumers 'api, nope' are not sources", "Provider 'billing' is not a source",
                        "Source 'inventory' is not a source"]


def test_flow_needs_a_call_chain_and_a_sequence_diagram(tmp_path):
    _, ws = complete_hub(tmp_path)
    body = _page.load_page(ws, "flows/checkout.md").body
    no_diagram = body.split("```mermaid")[0] + body.split("```\n", 1)[1]
    _set(ws, "flows/checkout.md", no_diagram)
    assert [i.message for i in _codes(ws, "flow-hops")] == ["Flow page has no mermaid sequenceDiagram"]


def test_coverage_lands_on_the_source_overview(tmp_path):
    _, ws = complete_hub(tmp_path)
    _set(ws, "sources/web/modules/client.md", scope=["web/src/api.ts"])
    commit(ws.root / "web", {"lib/util.ts": "export const x = 1;\n"})
    (issue,) = _codes(ws, "coverage")
    assert (issue.page, issue.message) == ("sources/web/overview.md", "module web/lib is in no page scope")
    body = _page.load_page(ws, "sources/api/overview.md").body + "| `web/lib/` | Belongs to web. |\n"
    _set(ws, "sources/api/overview.md", body)
    outside = _codes(ws, "not-covered")
    assert [i.message for i in outside] == ["Not covered path web/lib is outside source api"]


def test_orphan_pages_warn(tmp_path):
    _, ws = complete_hub(tmp_path)
    _set(ws, "sources/web/overview.md", "## Structure\n\nOne module.\n\n## Not covered\n\n| Path | Reason |\n|---|---|\n")
    orphans = _codes(ws, "orphan")
    assert [(i.page, i.severity) for i in orphans] == [("sources/web/modules/client.md", "warning")]


# --- stamp: indexes, System map, log ---------------------------------------------------------


def test_stamp_writes_layered_indexes_the_map_and_the_log(tmp_path):
    root, ws = _stamped(tmp_path)
    assert _status.status(root)["next_actions"] == ["nothing to do: the wiki is committed and current"]
    index = (ws.wiki / "index.md").read_text(encoding="utf-8")
    assert index.startswith('---\nokf_version: "0.2"\n---\n# Architecture\n')
    assert "\n# System map\n\n* [System map](system-map.md) - Generated from the code" in index
    assert "\n# Sources\n\n* [api](sources/api/) - Read before changing api:" in index
    assert "[Checkout](flows/checkout.md) - Read before changing how an order moves from web to worker." in index
    assert "modules/" not in index
    api = (ws.wiki / "sources/api/index.md").read_text(encoding="utf-8")
    assert api.startswith("# Overview\n\n* [api overview](overview.md) - ")
    assert "* [Orders](modules/orders.md) - Read before changing order creation. (reviewed " in api
    assert "* `api/src/` - [Checkout](/flows/checkout.md), [Orders](modules/orders.md)" in api
    system_map = _page.load_page(ws, "system-map.md")
    assert system_map.type == "Map" and system_map.is_generated
    body = system_map.body
    assert '  s2 -->|http 1| s0\n' in body  # web calls api
    assert f"| `http POST /reservations/{{}}` | worker `{RESERVE}#L4` | api `{CLIENT}#L4` | [Checkout](/flows/checkout.md) |" in body
    assert "| `library com.acme:common` | worker `worker/pom.xml#L3` | api `api/pom.xml#L7` | [Architecture](/architecture.md) |" in body
    assert f"| `{EXTERNAL}` | web `web/src/api.ts#L2` |" in body
    log = (ws.wiki / "log.md").read_text(encoding="utf-8")
    assert log.count("**Creation**") == 13 and "[Checkout](/flows/checkout.md) - api " in log
    # Deleting the derived files and stamping again rebuilds them byte for byte.
    before = {p: (ws.wiki / p).read_bytes() for p in _stamp.derived_on_disk(ws)}
    for path in before:
        (ws.wiki / path).unlink()
    assert _codes(ws, "log") and _codes(ws, "map") and _codes(ws, "index")
    assert set(_stamp.stamp(ws, "repo-wiki/test")["derived"]) == {f"docs/wiki/{p}" for p in before}
    assert {p: (ws.wiki / p).read_bytes() for p in _stamp.derived_on_disk(ws)} == before


def test_log_records_updates_with_their_revision_range(tmp_path):
    root, ws = _stamped(tmp_path)
    old = _page.load_page(ws, "sources/worker/modules/inventory.md").revision["worker"]
    new = commit(ws.root / "worker", {"src/main/java/com/acme/inv/ReservationController.java": (
        ws.root / RESERVE).read_text(encoding="utf-8").replace("values (?)", "values (?, ?)")})
    _impact.update(ws)
    for path in ("sources/worker/modules/inventory.md", "flows/checkout.md", "glossary.md"):
        page = _page.load_page(ws, path)
        page.body = page.body.split("-->\n", 1)[1].lstrip("\n") if page.todos else page.body
        _page.write_page(page)
    result = _stamp.stamp(ws, "repo-wiki/test", unreviewed=True)
    assert result["blocked"] == [], result["blocked"]
    log = (ws.wiki / "log.md").read_text(encoding="utf-8")
    line = next(line for line in log.splitlines() if "[Inventory]" in line and "**Update**" in line)
    assert f"worker {old[:12]}..{new[:12]}; unreviewed" in line
    commit(root, {}, "wiki v2")
    assert _codes(ws, "log") == []  # committed history derives the same log
    entries = _stamp.log_entries(ws, files=[RESERVE])["entries"]
    assert {(e["path"], e["kind"]) for e in entries} >= {
        ("sources/worker/modules/inventory.md", "update"), ("sources/worker/modules/inventory.md", "creation")}
    assert _stamp.log_entries(ws, since="2999-01-01")["entries"] == []
    with pytest.raises(_stamp.StampError):
        _stamp.log_entries(ws, since="yesterday")


def test_stale_index_files_are_reported_and_removed(tmp_path):
    _root, ws = _stamped(tmp_path)
    stray = ws.wiki / "sources/gone/index.md"
    stray.parent.mkdir(parents=True)
    stray.write_text("# Old\n", encoding="utf-8")
    assert [(i.page, i.message) for i in _codes(ws, "index")] == [
        ("sources/gone/index.md", "sources/gone/index.md is stale")]
    assert "docs/wiki/sources/gone/index.md" in _stamp.stamp(ws, "repo-wiki/test")["derived"]
    assert not stray.exists()


def test_a_long_index_warns(tmp_path, monkeypatch):
    _, ws = _stamped(tmp_path)
    monkeypatch.setattr(_stamp, "INDEX_MAX_LINES", 5)
    sizes = {i.page for i in _codes(ws, "index-size")}
    assert sizes == {"index.md", "sources/api/index.md", "sources/worker/index.md", "sources/web/index.md"}


# --- impact, status, pointer ------------------------------------------------------------------


def test_impact_files_names_contracts_and_source_canon(tmp_path):
    _, ws = _stamped(tmp_path)
    files = _impact.impact_files(ws, [CLIENT, "worker/pom.xml", "web/src"])["files"]
    (reserve,) = files[CLIENT]["contracts"]
    assert reserve == {"id": "http POST /reservations/{}", "role": "consumer",
                       "counterparts": [f"worker {RESERVE}#L4"], "pages": ["flows/checkout.md"],
                       "change_order": [], "external": False}
    assert files[CLIENT]["canon"] == ["glossary.md", "conventions.md", "sources/api/conventions.md",
                                      "sources/api/overview.md"]
    (common,) = files["worker/pom.xml"]["contracts"]
    assert common["role"] == "provider" and common["pages"] == ["architecture.md"]
    assert common["change_order"][0]["change_order"] == "Release common from worker first."
    web = {c["id"]: c for c in files["web/src"]["contracts"]}
    assert web[EXTERNAL]["external"] and web["http POST /api/orders"]["counterparts"] == [f"api {ORDER}#L5"]


def test_a_contract_change_stales_claiming_pages_outside_their_scope(tmp_path):
    _root, ws = _stamped(tmp_path)
    text = (ws.root / CLIENT).read_text(encoding="utf-8").replace("long orderId)", "long orderId, int qty)")
    commit(ws.root / "api", {"src/main/java/com/acme/order/InventoryClient.java": text})
    report = {p["page"]: p["reasons"] for p in _impact.impact(ws)["pages"]}
    assert {r["kind"] for r in report["flows/checkout.md"]} == {"contract-changed", "cited-changed"}
    changed = [r for r in report["flows/checkout.md"] if r["kind"] == "contract-changed"]
    assert changed == [{"kind": "contract-changed", "contract": "http POST /reservations/{}", "path": CLIENT,
                        "since": changed[0]["since"]}]
    assert "architecture.md" not in report  # it claims only the library
    _impact.update(ws)
    todo = _page.load_page(ws, "flows/checkout.md").todos[0][1]
    assert f"contract-changed http POST /reservations/{{}} {CLIENT} (since " in todo


def test_new_contracts_are_filed_on_the_architecture_page(tmp_path):
    _root, ws = _stamped(tmp_path)
    commit(ws.root / "worker", {"src/main/java/com/acme/inv/Audit.java": (
        "class Audit {\n  @KafkaListener(topics = \"order-cancelled\")\n  void on(String m) {}\n}\n")})
    commit(ws.root / "api", {"src/main/java/com/acme/order/Cancel.java": (
        "class Cancel {\n  void f() { kafka.send(\"order-cancelled\", x); }\n}\n")})
    report = _impact.impact(ws)
    assert report["unclaimed_contracts"] == [{"id": "topic order-cancelled", "sources": ["api", "worker"]}]
    result = _impact.update(ws)
    assert "architecture.md" in result["drafted"]
    todo = _page.load_page(ws, "architecture.md").todos[0][1]
    assert "unclaimed-contract topic order-cancelled (api, worker)" in todo


def test_status_assembles_overviews_and_architecture_last(tmp_path):
    root, ws = complete_hub(tmp_path)
    commit(root, {}, "pages")
    for path in ("sources/api/overview.md", "flows/checkout.md", "sources/api/conventions.md"):
        page = _page.load_page(ws, path)
        page.body = "<!-- okf:todo\nmore\n-->\n\n" + page.body
        _page.write_page(page)
    assert _status.status(root)["phase"] == "research"
    _set(ws, "sources/api/conventions.md", BODY := _page.load_page(ws, "sources/api/conventions.md").body.split(
        "-->\n\n", 1)[1])
    assert BODY.startswith("## Commands")
    assert _status.status(root)["phase"] == "write"
    _set(ws, "flows/checkout.md", _page.load_page(ws, "flows/checkout.md").body.split("-->\n\n", 1)[1])
    status = _status.status(root)
    assert status["phase"] == "assemble" and "sources/api/overview.md" in status["next_actions"][0]


def test_status_discovers_until_contracts_are_traced(tmp_path):
    root, ws = hub(tmp_path)
    for path in _page.canon(ws):
        _set(ws, path, _page.load_page(ws, path).body.replace("<!-- okf:todo\n-->", "<!-- okf:todo\nbrief\n-->", 1))
    for name, glob in (("orders", "api/src/**"), ("inventory", "worker/src/**"), ("client", "web/src/**")):
        page = _page.new_page(ws, "Module", name, "Read before.", [glob])
        _set(ws, page.path, page.body.replace("<!-- okf:todo\n-->", "<!-- okf:todo\nbrief\n-->", 1))
    status = _status.status(root)
    assert status["phase"] == "discover"
    assert any("trace the 4 contracts between sources" in a for a in status["next_actions"])
    assert {i["code"] for i in status["issues"][:6]} == {"trigger-coverage", "link-coverage"}


def test_pointer_per_source(tmp_path, monkeypatch, capsys):
    import okf

    root, ws = _stamped(tmp_path)
    block = _stamp.pointer(ws, "api")
    lines = block.splitlines()
    assert len(lines) <= _stamp.POINTER_MAX_LINES
    assert "open `docs/wiki/sources/api/index.md`" in block
    assert ("`docs/wiki/glossary.md`, `docs/wiki/conventions.md` and `docs/wiki/sources/api/conventions.md`"
            in block)
    assert "`docs/wiki/system-map.md`" in block and "- Tests: `mvn -q test`" in block
    hub_block = _stamp.pointer(ws)
    assert "okf pointer --source <name>" in hub_block and "Verified commands" not in hub_block
    with pytest.raises(_stamp.StampError, match="use one of: api, worker, web"):
        _stamp.pointer(ws, "nope")
    monkeypatch.chdir(root)
    assert okf.main(["pointer", "--source", "worker"]) == 0
    assert "sources/worker/index.md" in capsys.readouterr().out


def test_cli_links_and_log(tmp_path, monkeypatch, capsys):
    import okf

    root, _ws = _stamped(tmp_path)
    monkeypatch.chdir(root / "api")
    assert okf.main(["links", "--source", "worker", "--json"]) == 0
    ids = [c["id"] for c in json.loads(capsys.readouterr().out)["contracts"]]
    assert ids == ["http POST /reservations/{}", "library com.acme:common", "topic order-created"]
    assert okf.main(["links", "--contract", "http * /api/*", "--json"]) == 0
    assert [c["id"] for c in json.loads(capsys.readouterr().out)["contracts"]] == ["http POST /api/orders"]
    assert okf.main(["links", "--file", "src/main/java/com/acme/order/InventoryClient.java", "--json"]) == 0
    assert [c["id"] for c in json.loads(capsys.readouterr().out)["contracts"]] == ["http POST /reservations/{}"]
    assert okf.main(["log", "--files", "src/main/java/com/acme/order/OrderController.java", "--json"]) == 0
    paths = {e["path"] for e in json.loads(capsys.readouterr().out)["entries"]}
    assert paths == {"flows/checkout.md", "sources/api/modules/orders.md"}
