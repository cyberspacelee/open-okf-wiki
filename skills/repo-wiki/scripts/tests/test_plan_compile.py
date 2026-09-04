import _plan
from _models import KnowledgePlanIntent


def intent(**overrides):
    value = {
        "kind": "knowledge-plan-intent",
        "source_areas": [
            {
                "id": "app.orders",
                "source": "app",
                "paths": ["src/orders"],
                "disposition": "domain",
                "domain_ids": ["orders"],
            }
        ],
        "domains": [
            {
                "id": "orders",
                "name": "Orders",
                "definition": "Owns order acceptance and fulfillment.",
                "owner_unit_id": "order-capability",
            }
        ],
        "concepts": [
            {
                "id": "order",
                "domain_id": "orders",
                "kind": "entity",
                "name": "Order",
                "definition": "A durable accepted order.",
                "owner_unit_id": "order-capability",
                "model_basis": {"basis": "opengauss"},
            }
        ],
        "catalog_groups": [
            {
                "source": "database",
                "domain_id": "orders",
                "role": "entity",
                "tables": ["orders"],
                "concept_ids": ["order"],
            }
        ],
        "units": [
            {
                "id": "order-capability",
                "kind": "capability",
                "question": "What does order acceptance own and enforce?",
                "domain_ids": ["orders"],
                "concept_ids": ["order"],
                "participants": [
                    {
                        "source": "app",
                        "roles": ["owner"],
                        "paths": ["src/orders"],
                        "evidence": ["app/src/orders/Order.java#L1-L20"],
                    }
                ],
            }
        ],
    }
    value.update(overrides)
    return value


def catalogs():
    return [
        {
            "name": "database",
            "resource": "database/.",
            "tables": [
                {
                    "name": "orders",
                    "page_slug": "orders",
                    "resource": "database/orders",
                }
            ],
        }
    ]


def test_compile_derives_repeated_routing_and_catalog_fields():
    source = KnowledgePlanIntent.model_validate(intent())

    result = _plan.compile_intent(source, catalogs())

    assert result.diagnostics == []
    assert result.plan.kind == "knowledge-plan-ledger"
    assert result.plan.intent_digest == _plan.intent_digest(source)
    assert result.plan.source_areas[0].model_dump() == {
        "id": "app.orders",
        "source": "app",
        "paths": ["src/orders"],
        "disposition": "domain",
        "domain_ids": ["orders"],
    }
    assert result.plan.concepts[0].model_basis.catalog_tables[0].model_dump() == {
        "source": "database",
        "table": "orders",
    }
    assert result.plan.table_groups[0].model_dump(exclude_defaults=True) == {
        "source": "database",
        "role": "entity",
        "tables": ["orders"],
        "domain_id": "orders",
    }
    unit = result.plan.units[0]
    assert unit.scopes[0].model_dump() == {
        "source": "app",
        "roles": ["owner"],
        "paths": ["src/orders"],
    }
    assert unit.evidence_seeds == ["app/src/orders/Order.java#L1-L20"]
    assert result.plan.effective_units[-1].evidence_seeds == ["database/orders"]


def test_compile_aggregates_independent_cross_record_diagnostics():
    value = intent()
    value["domains"].append(dict(value["domains"][0]))
    value["source_areas"].append(
        {
            **value["source_areas"][0],
            "id": "app.orders.child",
            "paths": ["src/orders/model"],
        }
    )
    value["units"][0]["domain_ids"] = ["missing-domain"]
    source = KnowledgePlanIntent.model_validate(value)

    result = _plan.compile_intent(source, catalogs())

    assert result.plan is None
    assert {item.code for item in result.diagnostics} >= {
        "domain-id-duplicate",
        "source-area-overlap",
        "unit-domain-invalid",
    }
    assert all(
        item.category and item.pointer and item.suggestion
        for item in result.diagnostics
    )


def test_compile_reports_every_catalog_coverage_failure_together():
    value = intent()
    value["catalog_groups"] = []
    source = KnowledgePlanIntent.model_validate(value)

    result = _plan.compile_intent(source, catalogs())

    assert result.plan is None
    assert {item.code for item in result.diagnostics} >= {
        "catalog-table-unclassified",
        "concept-catalog-model-missing",
    }


def test_compile_requires_a_capability_as_domain_owner():
    value = intent()
    value["units"][0]["kind"] = "flow"

    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), catalogs())

    assert result.plan is None
    assert "domain-owner-invalid" in {item.code for item in result.diagnostics}


def test_compile_rejects_reserved_derived_unit_ids_and_missing_replica_mapping():
    value = intent()
    value["units"].append(
        {
            **value["units"][0],
            "id": "model.order",
        }
    )
    value["catalog_groups"][0]["role"] = "replica"

    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), catalogs())

    assert result.plan is None
    assert {item.code for item in result.diagnostics} >= {
        "unit-id-reserved",
        "replica-mapping-missing",
    }


def test_compile_blocks_unresolved_catalog_classifications():
    value = intent()
    value["gaps"] = [
        {
            "id": "orders-role-unknown",
            "category": "catalog-selection",
            "claim": "The captured table role is not yet established.",
            "evidence": [],
        }
    ]
    value["catalog_groups"][0].update(
        role="unresolved", gap_ids=["orders-role-unknown"]
    )

    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), catalogs())

    assert result.plan is None
    assert "table-disposition-unresolved" in {item.code for item in result.diagnostics}
