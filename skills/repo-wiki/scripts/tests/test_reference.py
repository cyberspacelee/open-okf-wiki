import json
import pathlib
from datetime import datetime, timezone
from types import SimpleNamespace as NS

import _db
import _publish
import _reference
import _state
import _validate
import _workspace
import pytest
from _diagram import validate as validate_diagrams
from _frontmatter import parse_file, render
from _markdown import extract
from _models import (
    CompositionMap,
    CompositionPage,
    DiagramSpec,
    KnowledgePlan,
    ReferenceRoot,
)
from _reference import derive_pages, enrich_data_model

MARKER = "<!-- okf-generated:model -->"


def con(name, kind, columns, **extra):
    return {
        "name": name,
        "type": kind,
        "columns": columns,
        "definition": name,
        "validated": True,
        "soft": False,
        **extra,
    }


def captured_tables():
    ref = {
        "ref_schema": "public",
        "ref_table": "customers",
        "ref_columns": ["tenant_id", "id"],
        "match": "full",
        "on_update": "cascade",
        "on_delete": "restrict",
    }
    active = con(
        "orders_customer_fk",
        "foreign_key",
        ["tenant_id", "customer_id"],
        **ref,
    )
    soft = con(
        "orders_soft_fk",
        "foreign_key",
        ["tenant_id", "customer_id"],
        soft=True,
        **ref,
    )

    def col(position, name, kind="bigint"):
        return {
            "position": position,
            "name": name,
            "type": kind,
            "nullable": False,
            "default": "0" if name == "amount" else None,
            "comment": name,
        }

    return [
        {
            "schema": "public",
            "name": "customers",
            "comment": "Customer identity.",
            "relation_kind": "table",
            "persistence": "permanent",
            "columns": [col(1, "tenant_id"), col(2, "id")],
            "constraints": [con("customers_pkey", "primary_key", ["tenant_id", "id"])],
            "primary_key": ["tenant_id", "id"],
            "foreign_keys": [],
            "indexes": [],
            "partitions": [],
        },
        {
            "schema": "public",
            "name": "orders",
            "comment": "Customer order.",
            "relation_kind": "partitioned_table",
            "persistence": "permanent",
            "columns": [
                col(1, "tenant_id"),
                col(2, "customer_id"),
                col(3, "amount", "numeric(18,2)"),
            ],
            "constraints": [
                con(
                    "orders_pkey",
                    "primary_key",
                    ["tenant_id", "customer_id"],
                ),
                active,
                soft,
            ],
            "primary_key": ["tenant_id", "customer_id"],
            "foreign_keys": [active, soft],
            "indexes": [
                {
                    "name": "orders_amount_idx",
                    "method": "btree",
                    "keys": ["amount DESC"],
                    "include": [],
                    "valid": True,
                    "usable": True,
                    "ready": True,
                    "predicate": "amount > 0",
                }
            ],
            "partitions": [
                {
                    "name": "orders_2026",
                    "type": "p",
                    "strategy": "r",
                    "boundaries": ["2027-01-01"],
                    "tablespace": None,
                }
            ],
        },
    ]


@pytest.fixture
def model(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_URL", "opengauss://localhost/app")
    catalog = _db.capture_catalog(
        tmp_path,
        NS(
            name="database",
            url_env="DB_URL",
            schema="public",
            tables=("customers", "orders"),
        ),
        inspect=lambda *_args: (
            {"opengauss_version": "7.0.0", "database": "app"},
            captured_tables(),
        ),
    )
    manifest = _db.load_index(tmp_path, catalog["storage_key"])
    resources = {item["name"]: item["resource"] for item in manifest["tables"]}
    plan = KnowledgePlan.model_validate(
        {
            "kind": "knowledge-plan",
            "source_areas": [
                {
                    "id": "database.sales",
                    "source": "database",
                    "paths": ["."],
                    "disposition": "domain",
                    "domain_ids": ["sales"],
                    "evidence_seeds": ["database/."],
                }
            ],
            "domains": [
                {
                    "id": "sales",
                    "name": "Sales",
                    "definition": "Owns customer and order persistence.",
                    "owner_unit_id": "sales-capability",
                }
            ],
            "concepts": [
                {
                    "id": concept_id,
                    "domain_id": "sales",
                    "kind": "entity",
                    "name": title,
                    "definition": f"The Sales {title.lower()} record.",
                    "owner_unit_id": "sales-capability",
                    "model_basis": {
                        "basis": "opengauss",
                        "catalog_tables": [
                            {"source": "database", "table": table}
                        ],
                    },
                }
                for concept_id, table, title in (
                    ("customer", "customers", "Customer"),
                    ("order", "orders", "Order"),
                )
            ],
            "table_groups": [
                {
                    "source": "database",
                    "role": "entity",
                    "tables": ["customers", "orders"],
                    "domain_id": "sales",
                }
            ],
            "units": [
                {
                    "id": "sales-capability",
                    "kind": "capability",
                    "question": "What does Sales own?",
                    "domain_ids": ["sales"],
                    "concept_ids": ["customer", "order"],
                    "scopes": [
                        {"source": "database", "role": "model", "paths": ["."]}
                    ],
                    "evidence_seeds": ["database/."],
                }
            ],
        }
    )
    composition = CompositionMap.model_validate(
        {
            "kind": "composition-map",
            "reference_roots": [
                {"source": "database", "path": "reference/database"}
            ],
            "pages": [
                {
                    "id": "sales-domain",
                    "path": "sales/sales.md",
                    "type": "Domain",
                    "title": "Sales",
                    "description": "Open before changing Sales boundaries.",
                    "tags": ["sales"],
                    "units": ["sales-capability"],
                    "diagrams": [],
                },
                {
                    "id": "sales-data-model",
                    "path": "sales/data-model.md",
                    "type": "DataModel",
                    "title": "Sales data model",
                    "description": "Open before changing Sales persistence.",
                    "tags": ["sales"],
                    "units": ["model.customer", "model.order"],
                    "merge_rationale": "Customer and Order form one model.",
                    "diagrams": [],
                },
            ],
        }
    )
    page = composition.pages[1]
    return tmp_path, catalog, resources, plan, composition, page


def test_derive_pages_has_schema_tables_ids_and_links(model):
    root, catalog, resources, plan, composition, _page = model
    pages = derive_pages(
        root, {"language": "en", "catalogs": [catalog]}, plan, composition
    )
    assert [(item["id"], item["path"], item["type"]) for item in pages] == [
        ("schema-database", "reference/database/schema.md", "Schema"),
        (
            "table-database-customers",
            "reference/database/sales/tables/customers.md",
            "Table",
        ),
        (
            "table-database-orders",
            "reference/database/sales/tables/orders.md",
            "Table",
        ),
    ]
    assert "### [Sales][sales-domain]" in pages[0]["body"]
    assert "#### entity" in pages[0]["body"]
    assert "[customers][table-database-customers]" in pages[0]["body"]
    assert "[orders][table-database-orders]" in pages[0]["body"]
    assert all(item["units"] == [] for item in pages)
    order = pages[2]
    assert order["sources"] == [{"id": "catalog", "resource": resources["orders"]}]
    for expected in (
        "numeric(18,2)",
        "orders_customer_fk",
        "orders_amount_idx",
        "orders_2026",
        "[Sales][sales-domain]",
        "[Order][sales-domain]",
    ):
        assert expected in order["body"]


def test_unowned_tables_are_grouped_by_role(model):
    root, catalog, _resources, plan, composition, _page = model
    group = plan.table_groups[0]
    plan.table_groups = [
        group.model_copy(update={"tables": ["customers"]}),
        group.model_copy(
            update={
                "tables": ["orders"],
                "domain_id": None,
                "role": "infrastructure",
            }
        ),
    ]
    plan.concepts[1].model_basis.catalog_tables = []

    pages = derive_pages(
        root, {"language": "en", "catalogs": [catalog]}, plan, composition
    )

    assert pages[2]["path"] == (
        "reference/database/roles/infrastructure/tables/orders.md"
    )
    assert "### No Domain ownership" in pages[0]["body"]
    assert "#### infrastructure" in pages[0]["body"]


def test_reference_pages_are_bilingual(model):
    root, catalog, _resources, plan, composition, _page = model
    _workspace.init(root, "zh")
    _workspace.add_opengauss_source(
        root, "database", "DB_URL", "public", ["customers", "orders"]
    )
    state = {
        "language": "zh",
        "catalogs": [catalog],
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    pages = derive_pages(root, state, plan, composition)
    assert pages[0]["title"] == "database 数据库 Schema"
    assert "## Domain 与表角色" in pages[0]["body"]
    assert pages[2]["title"] == "orders 数据表"
    assert "## 数据表结构" in pages[2]["body"]
    for page in pages:
        path = root / page["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        meta = {
            key: page[key]
            for key in (
                "id",
                "type",
                "title",
                "description",
                "tags",
                "diagrams",
                "sources",
            )
        }
        meta.update(
            {
                "coverage": "full",
                "language": "zh",
                "status": "draft",
                "generated": {
                    "by": "repo-wiki",
                    "at": datetime.fromisoformat(state["started_at"]),
                },
            }
        )
        path.write_text(render(meta, page["body"]), encoding="utf-8")
        errors = [
            issue
            for issue in _validate.validate_page(
                root, state, path, owner="workspace", expected=page
            )
            if issue.severity == "error"
        ]
        assert errors == []


def test_reference_renderer_uses_the_selected_templates(model, monkeypatch):
    root, catalog, _resources, plan, composition, _page = model
    original = _reference.parse_file

    def marked_template(path):
        parsed = original(path)
        if path.name == "table.md":
            parsed.body = parsed.body.replace(
                "## Structure", "## Template-selected structure"
            )
        return parsed

    monkeypatch.setattr(_reference, "parse_file", marked_template)
    pages = derive_pages(
        root, {"language": "en", "catalogs": [catalog]}, plan, composition
    )

    assert "## Template-selected structure" in pages[1]["body"]


def test_physical_er_resolves_foreign_keys_across_captured_schemas():
    column = lambda name: {"name": name, "type": "bigint", "nullable": False}
    customer = {
        "resource": "database/customers",
        "schema": "crm",
        "name": "customers",
        "columns": [column("id")],
        "constraints": [con("customers_pkey", "primary_key", ["id"])],
        "primary_key": ["id"],
        "indexes": [],
    }
    order = {
        "resource": "database/orders",
        "schema": "sales",
        "name": "orders",
        "columns": [column("id"), column("customer_id")],
        "constraints": [
            con("orders_pkey", "primary_key", ["id"]),
            con(
                "orders_customer_fk",
                "foreign_key",
                ["customer_id"],
                ref_schema="crm",
                ref_table="customers",
                ref_columns=["id"],
            ),
        ],
        "primary_key": ["id"],
        "indexes": [],
    }

    body, diagram = _reference._physical_er(
        NS(title="Sales model"),
        [("database", customer), ("database", order)],
        "en",
    )

    assert body.count("orders_customer_fk") == 1
    assert diagram["sources"] == ["database"]


def test_composition_reserves_a_diagram_slot_for_generated_physical_er(model):
    _root, _catalog, _resources, plan, composition, _page = model
    diagrams = [
        DiagramSpec(
            id=f"logical-{index}",
            kind="er",
            question="What maps?",
            sources=["database"],
        )
        for index in range(4)
    ]
    composition.pages = [
        NS(
            id="sales-data-model",
            path="sales/data-model.md",
            type="DataModel",
            units=["model.customer", "model.order"],
            diagrams=diagrams,
        )
    ]

    codes = {
        issue.code
        for issue in _validate._validate_composition(
            plan, composition, pathlib.Path("composition.md")
        )
    }

    assert "generated-diagram-capacity-exceeded" in codes


def test_enrich_injects_composite_er_and_filters_nonphysical_fk(model):
    root, catalog, resources, plan, _composition, page = model
    meta, body = enrich_data_model(
        root,
        {"language": "en", "catalogs": [catalog]},
        plan,
        page,
        {
            "sources": [{"id": "orders-db", "resource": resources["orders"]}],
            "diagrams": [],
        },
        "Before" + chr(10) + MARKER + chr(10) + "After",
    )
    assert MARKER not in body
    assert "[customers][table-database-customers]" in body
    assert "%% okf-id: physical-schema" in body
    assert "accTitle: Physical schema for Sales data model" in body
    assert "||--o|" in body
    assert body.count("orders_customer_fk") == 1
    assert "orders_soft_fk" not in body
    assert meta["diagrams"][0]["kind"] == "er"
    assert meta["diagrams"][0]["sources"] == ["database"]
    assert {item["resource"] for item in meta["sources"]} == set(resources.values())
    orders = next(
        item for item in meta["sources"] if item["resource"] == resources["orders"]
    )
    assert orders["id"] == "orders-db"
    assert (
        "The diagram contains only validated, enabled, non-soft OpenGauss foreign keys.[^"
        in body
    )
    assert (
        validate_diagrams(
            extract(body),
            [DiagramSpec.model_validate(meta["diagrams"][0])],
            {"database": {item["id"] for item in meta["sources"]}},
        )
        == []
    )


def test_enrich_is_bilingual_and_marker_is_exact(model):
    root, catalog, _resources, plan, _composition, page = model
    meta, body = enrich_data_model(
        root,
        {"language": "zh", "catalogs": [catalog]},
        plan,
        page,
        {"sources": [], "diagrams": []},
        MARKER,
    )
    assert "### 生成的模型依据" in body
    assert "accDescr: OpenGauss 声明的数据表和有效外键关系。" in body
    assert meta["diagrams"][0]["question"] == "OpenGauss 声明了哪些物理关系？"
    for invalid in ("none", MARKER + chr(10) + MARKER):
        with pytest.raises(ValueError, match="exactly one"):
            enrich_data_model(
                root,
                {"language": "zh", "catalogs": [catalog]},
                plan,
                page,
                {"sources": [], "diagrams": []},
                invalid,
            )


def test_code_basis_does_not_invent_a_physical_er():
    concept = NS(
        name="Order",
        model_unit_id="sales-model",
        model_basis=NS(
            basis="code",
            coverage="full",
            catalog_tables=[],
            structure_evidence=["src/model.py#L1"],
        ),
    )
    plan = KnowledgePlan.model_construct(concepts=[concept])
    meta, body = enrich_data_model(
        ".",
        {"language": "en", "catalogs": []},
        plan,
        NS(units=["sales-model"], title="Sales model"),
        {"sources": [], "diagrams": []},
        MARKER,
    )
    assert "`src/model.py#L1`" in body
    assert "[^code-model-src-model.py-l1]" in body
    assert "mermaid" not in body
    assert meta == {
        "sources": [
            {"id": "code-model-src-model.py-l1", "resource": "src/model.py#L1"}
        ],
        "diagrams": [],
    }


def test_reference_pages_bind_into_candidate_and_manifest(model):
    root, catalog, resources, plan, _composition, _page = model
    _workspace.init(root)
    _workspace.add_opengauss_source(
        root, "database", "DB_URL", "public", ["customers", "orders"]
    )
    page = CompositionPage.model_construct(
        id="sales-data-model",
        path="sales/data-model.md",
        type="DataModel",
        title="Sales data model",
        description="Open before changing the Sales persistence model.",
        tags=["sales"],
        units=["model.customer", "model.order"],
        merge_rationale="Customer and Order form one Sales persistence model.",
        diagrams=[],
    )
    domain_page = CompositionPage.model_construct(
        id="sales-domain",
        path="sales/sales.md",
        type="Domain",
        title="Sales",
        description="Open before changing Sales capability boundaries.",
        tags=["sales"],
        units=["sales-capability"],
        merge_rationale=None,
        diagrams=[],
    )
    composition = CompositionMap.model_construct(
        kind="composition-map",
        reference_roots=[ReferenceRoot(source="database", path="reference/database")],
        pages=[domain_page, page],
    )
    state = {
        "run_id": "run-reference",
        "language": "en",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "revisions": [],
        "catalogs": [catalog],
        "approved_review_digest": "a" * 64,
    }
    work = root / ".okf-wiki/runs/run-reference/work"
    draft = work / "drafts/sales-data-model.md"
    draft.parent.mkdir(parents=True)
    (work / "drafts/sales-domain.md").write_text(
        render(
            {"coverage": "full", "sources": [{"id": "catalog", "resource": "database/."}]},
            """## Responsibility and public surface

Sales owns customer and order persistence.[^catalog]

## Invariants and rules

| Rule | Enforcement point | Observable failure |
|---|---|---|
| Sales owns its records. | Catalog | Missing ownership |

## Data model overview

Customer and Order form the Sales model.[^catalog]

## State and lifecycle

The fixture captures structure but no state lifecycle.[^catalog]

## Key flows

The fixture captures structure but no operational flow.[^catalog]

## Concepts

Customer and Order are the primary concepts.[^catalog]

## Change points

Start from the Sales data model.[^catalog]

[^catalog]: Frozen OpenGauss Catalog.
""",
        ),
        encoding="utf-8",
    )
    draft.write_text(
        render(
            {"coverage": "full", "sources": []},
            """## Model basis

Catalog-backed Sales concepts.

## Physical model

<!-- okf-generated:model -->

## Logical relationships

No additional logical relationships.

## Ownership and boundaries

Sales owns this model.

## Reference model

Use the generated references.

## Code-to-data mapping

| Path | Concept |
|---|---|
| database | Sales |
""",
        ),
        encoding="utf-8",
    )
    (work / "composition.md").write_text(
        render(composition.model_dump(mode="json"), "# Composition\n"),
        encoding="utf-8",
    )
    (work / "plan.md").write_text("plan\n", encoding="utf-8")
    (work / "plan-ledger.json").write_text("{}\n", encoding="utf-8")
    (work / "plan-review.json").write_text("{}\n", encoding="utf-8")

    _state._bind_candidate(root, state, plan, composition)
    candidate = root / ".okf-wiki/runs/run-reference/candidate"
    reference_map = json.loads(
        (work / "reference-map.json").read_text(encoding="utf-8")
    )
    assert len(reference_map["pages"]) == 3
    assert reference_map["pages"][2]["table"] == "orders"
    authored = (candidate / "sales/data-model.md").read_text(encoding="utf-8")
    assert "](/reference/database/sales/tables/orders.md)" in authored
    assert "%% okf-id: physical-schema" in authored
    schema = parse_file(candidate / "reference/database/schema.md")
    assert schema.meta["type"] == "Schema"
    assert "## Constraint and storage summary" in schema.body

    manifest = _publish._page_manifest(root, candidate, state)
    catalog_tables = _db.load_index(root, catalog["storage_key"])["tables"]
    assert manifest["sales/data-model.md"]["inputs"] == {
        f"catalog:database:{name}": next(
            item["content_hash"] for item in catalog_tables if item["name"] == name
        )
        for name in resources
    }
    assert manifest["reference/database/schema.md"]["inputs"] == {
        "catalog:database": catalog["content_hash"]
    }
    assert (
        manifest["reference/database/sales/tables/orders.md"]["origin"] == "generated"
    )
    assert len(_publish._nav_manifest(candidate)) == 5
    expected = {
        item["path"]: {**item, "owner": "workspace"}
        for item in derive_pages(root, state, plan, composition)
    }
    expected[domain_page.path] = _validate.generated_page_spec(
        root, state, plan, domain_page
    )
    expected[page.path] = _validate.generated_page_spec(root, state, plan, page)
    errors = [
        issue
        for path in _publish._content_pages(candidate)
        for issue in _validate.validate_page(
            root,
            state,
            path,
            owner=expected[path.relative_to(candidate).as_posix()]["owner"],
            expected=expected[path.relative_to(candidate).as_posix()],
        )
        if issue.severity == "error"
    ]
    assert errors == []
