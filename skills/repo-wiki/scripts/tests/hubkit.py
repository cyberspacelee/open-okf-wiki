"""A three-source hub whose sources share contracts: api serves orders, publishes
order-created and calls worker's reservation route through a Feign client; worker
consumes the topic, writes t_reservation and publishes the common library api
depends on; web calls api's order route and an external payment service."""

from pathlib import Path

import _config
from helpers import _git, commit, git_repo

API = {
    "pom.xml": (
        "<project>\n  <groupId>com.acme</groupId>\n  <artifactId>order-api</artifactId>\n"
        "  <dependencies>\n    <dependency>\n      <groupId>com.acme</groupId>\n"
        "      <artifactId>common</artifactId>\n    </dependency>\n  </dependencies>\n</project>\n"
    ),
    "src/main/java/com/acme/order/OrderController.java": (
        "package com.acme.order;\n"
        "@RestController\n"
        "@RequestMapping(\"/api/orders\")\n"
        "public class OrderController {\n"
        "  @PostMapping\n"
        "  public Order create(Order o) {\n"
        "    kafka.send(\"order-created\", o);\n"
        "    inventory.reserve(o.id);\n"
        "    return o;\n"
        "  }\n"
        "}\n"
    ),
    "src/main/java/com/acme/order/InventoryClient.java": (
        "package com.acme.order;\n"
        "@FeignClient(name = \"worker\")\n"
        "public interface InventoryClient {\n"
        "  @PostMapping(\"/reservations/{orderId}\")\n"
        "  void reserve(@PathVariable long orderId);\n"
        "}\n"
    ),
}
WORKER = {
    "pom.xml": "<project>\n  <groupId>com.acme</groupId>\n  <artifactId>common</artifactId>\n</project>\n",
    "src/main/java/com/acme/inv/ReservationController.java": (
        "package com.acme.inv;\n"
        "@RestController\n"
        "public class ReservationController {\n"
        "  @PostMapping(\"/reservations/{id}\")\n"
        "  public void reserve(long id) {\n"
        "    jdbc.update(\"insert into t_reservation values (?)\");\n"
        "  }\n"
        "  @KafkaListener(topics = \"order-created\")\n"
        "  public void onOrder(String message) {}\n"
        "}\n"
    ),
}
WEB = {
    "src/api.ts": (
        "export const create = () => fetch(`${BASE}/api/orders`, { method: 'POST' });\n"
        "export const pay = () => axios.post('https://pay.example.com/v1/charges');\n"
    ),
}
SOURCES = {"api": API, "worker": WORKER, "web": WEB}


def hub(base: Path, lang: str = "en") -> tuple[Path, _config.Workspace]:
    """The hub with its canon stubs committed; returns (hub root, workspace)."""
    root = git_repo(base / "hub", {"README.md": "# Platform\n"})
    for name, files in SOURCES.items():
        git_repo(root / name, files)
    ws = _config.init(root, lang=lang, hub_sources=list(SOURCES))
    _git(root, "add", "-A")
    commit(root, {}, "wiki stubs")
    return root, ws


ORDER = "api/src/main/java/com/acme/order/OrderController.java"
CLIENT = "api/src/main/java/com/acme/order/InventoryClient.java"
RESERVE = "worker/src/main/java/com/acme/inv/ReservationController.java"
WEB = "web/src/api.ts"
CONTRACTS = [
    "http POST /api/orders", "http POST /reservations/{}", "library com.acme:common", "topic order-created",
]
EXTERNAL = "http POST /v1/charges"

_CONVENTIONS = """## Commands

| Purpose | Command | Status |
|---|---|---|
| Tests | `mvn -q test`[^pom] | verified |

## Rules

| Area | Rule | Enforced by |
|---|---|---|
| build-ci | Builds use Maven.[^pom] | ci |

[^pom]: {pom}#L1-L3
"""


def _module(what: str, label: str, locator: str) -> str:
    return (f"## Responsibility\n\n{what}\n\n## How it works\n\nSee the code.[^{label}]\n\n## Making changes\n\n"
            "| Change | Start at | Also change | Verify |\n|---|---|---|---|\n"
            f"| Change it | `{label}`[^{label}] | - | `mvn -q test` |\n\n[^{label}]: {locator}\n")


def _overview(source: str, module: str) -> str:
    return (f"## Structure\n\nOne module, [{module}](/sources/{source}/modules/{module}.md).\n\n"
            "## Not covered\n\n| Path | Reason |\n|---|---|\n")


BODIES = {
    "glossary.md": f"""| Term | Meaning | Avoid | Where |
|---|---|---|---|
| Reservation | In worker, stock held for one order. | hold | `ReservationController`[^res] |

[^res]: {RESERVE}#L3
""",
    "conventions.md": """## Rules

| Area | Rule | Enforced by |
|---|---|---|
| dependencies | api builds against worker's common artifact; release common first.[^common] | review |

[^common]: api/pom.xml#L4-L8
""",
    "architecture.md": """## Structure

web calls api, api calls worker; see the [System map](/system-map.md),
[api](/sources/api/overview.md), [worker](/sources/worker/overview.md),
[web](/sources/web/overview.md) and [checkout](/flows/checkout.md).

## Contracts

| Contract | Provider | Consumers | Change order | Verify |
|---|---|---|---|---|
| `library com.acme:common` | worker | api | Release common from worker first.[^common] | `mvn -q verify` in both |

## Not covered

| Path | Reason |
|---|---|

[^common]: api/pom.xml#L4-L8
""",
    "sources/api/conventions.md": _CONVENTIONS.format(pom="api/pom.xml"),
    "sources/worker/conventions.md": _CONVENTIONS.format(pom="worker/pom.xml"),
    "sources/web/conventions.md": """## Commands

| Purpose | Command | Status |
|---|---|---|

## Rules

| Area | Rule | Enforced by |
|---|---|---|
""",
    "sources/api/overview.md": _overview("api", "orders"),
    "sources/worker/overview.md": _overview("worker", "inventory"),
    "sources/web/overview.md": _overview("web", "client"),
    "sources/api/modules/orders.md": _module("Orders owns order creation.", "create", f"{ORDER}#L6-L10"),
    "sources/worker/modules/inventory.md": _module("Inventory owns reservations.", "reserve", f"{RESERVE}#L4-L7"),
    "sources/web/modules/client.md": _module("The web client calls api.", "create", f"{WEB}#L1"),
    "flows/checkout.md": f"""## Call chain

| Step | Source | Entry | Contract | Next |
|---|---|---|---|---|
| 1 | web | `create`[^web] | `http POST /api/orders` | api creates the order |
| 2 | api | `OrderController.create`[^create] | `http POST /reservations/{{}}`; `topic order-created` | worker reserves and hears the event |
| 3 | worker | `ReservationController.reserve`[^reserve] | - | - |

```mermaid
sequenceDiagram
  participant web
  participant api
  participant worker
  web->>api: POST /api/orders
  api->>worker: POST /reservations/{{id}}
  api->>worker: order-created
```

## Making changes

| Change | Start at | Also change | Verify |
|---|---|---|---|
| Reservation request | `InventoryClient.reserve`[^client] | `ReservationController.reserve` | `mvn -q test` in both |

[^web]: {WEB}#L1
[^create]: {ORDER}#L6-L10
[^reserve]: {RESERVE}#L4-L7
[^client]: {CLIENT}#L4-L5
""",
}


def complete_hub(base: Path) -> tuple[Path, _config.Workspace]:
    """The hub with every page written: drafts without todo blocks, valid, unreviewed."""
    import _page

    root, ws = hub(base)
    _page.new_page(ws, "Module", "orders", "Read before changing order creation.", ["api/src/**"])
    _page.new_page(ws, "Module", "inventory", "Read before changing reservations.", ["worker/src/**"])
    _page.new_page(ws, "Module", "client", "Read before changing the web client.", ["web/src/**"])
    _page.new_page(ws, "Flow", "checkout", "Read before changing how an order moves from web to worker.",
                   [WEB, ORDER, RESERVE], contracts=["http POST /api/orders", "http POST /reservations/{}",
                                                     "topic order-created"])
    arch = _page.load_page(ws, "architecture.md")
    arch.meta["contracts"] = ["library com.acme:common"]
    _page.write_page(arch)
    for path, body in BODIES.items():
        page = _page.load_page(ws, path)
        page.body = body
        _page.write_page(page)
    return root, ws
