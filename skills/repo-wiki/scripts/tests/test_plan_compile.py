import _plan
from _models import KnowledgePlanIntent


def intent(**overrides):
    value = {
        "kind": "knowledge-plan-intent",
        "analysis": {
            "global_model": "Orders owns acceptance and fulfillment.",
            "lifecycles": "Accepted orders proceed to fulfillment.",
            "conclusions": [
                {
                    "claim": "The entry owns acceptance.",
                    "evidence": ["app/src/orders/Order.java#L1-L20"],
                }
            ],
        },
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
                "owner_capability": "order-capability",
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


def test_gap_routes_accept_derived_units_and_reject_unknown_units():
    value = intent()
    value["gaps"] = [
        {
            "id": "recovery",
            "category": "source-coverage",
            "claim": "Recovery belongs to an unregistered source.",
            "evidence": [],
            "unit_ids": ["model.order"],
        }
    ]
    assert not _plan.compile_intent(
        KnowledgePlanIntent.model_validate(value), catalogs()
    ).diagnostics
    value["gaps"][0]["unit_ids"] = ["missing"]
    assert "gap-unit-invalid" in {
        issue.code
        for issue in _plan.compile_intent(
            KnowledgePlanIntent.model_validate(value), catalogs()
        ).diagnostics
    }


def test_ownership_and_catalog_domain_are_derived_without_reverse_links():
    value = intent()
    value["units"][0].pop("domain_ids")
    value["units"][0].pop("concept_ids")
    value["catalog_groups"][0].pop("domain_id")
    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), catalogs())
    assert not result.diagnostics
    assert result.plan.units[0].domain_ids == ["orders"]
    assert result.plan.units[0].concept_ids == ["order"]
    assert result.plan.table_groups[0].domain_id == "orders"


def test_large_derived_models_and_participant_unions_preserve_all_evidence():
    value = intent()
    names = [f"orders_{i}" for i in range(45)]
    value["catalog_groups"][0]["tables"] = names
    captured = catalogs()
    captured[0]["tables"] = [
        {"name": n, "page_slug": n, "resource": f"database/{n}"} for n in names
    ]
    value["units"][0]["participants"] = [
        {
            "source": "app",
            "roles": ["owner"],
            "paths": [f"src/orders/p{i}" for i in range(start, start + 32)],
            "evidence": [
                f"app/src/orders/p{i}/Order.java#L1" for i in range(start, start + 16)
            ],
        }
        for start in (0, 32)
    ]
    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), captured)
    assert result.diagnostics == []
    assert len(result.plan.units[0].scopes[0].paths) == 64
    assert len(result.plan.units[0].evidence_seeds) == 32
    assert len(result.plan.effective_units[-1].evidence_seeds) == 45
    assert result.plan.effective_units[-1].evidence_seeds[-1] == "database/orders_44"


def test_flat_replica_locators_resolve_captured_identity_and_reject_unknowns():
    value = intent()
    captured = catalogs() + [
        {
            "name": "analytics",
            "resource": "analytics/.",
            "tables": [
                {
                    "name": "order copy",
                    "page_slug": "order-copy",
                    "resource": "analytics/order%20copy",
                }
            ],
        }
    ]
    value["catalog_groups"].append(
        {"source": "analytics", "role": "replica", "tables": ["order copy"]}
    )
    value["table_replicas"] = [
        {
            "table": "analytics/order%20copy",
            "replica_of": "database/orders",
            "evidence": ["app/src/orders/Order.java#L1-L20"],
        }
    ]
    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), captured)
    assert not result.diagnostics
    assert result.plan.table_replicas[0].table.table == "order copy"
    scopes, evidence = _plan.normalize_participants(
        [
            _plan.KnowledgePlanIntent.model_validate(value)
            .units[0]
            .participants[0]
            .model_copy(
                update={"source": "analytics", "paths": ["order-copy"], "evidence": []}
            )
        ],
        captured,
    )
    assert evidence == ["analytics/order%20copy"]
    value["table_replicas"][0]["replica_of"] = "database/missing"
    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), captured)
    assert any(
        d.pointer == "/table_replicas/0/replica_of" and d.actual == "database/missing"
        for d in result.diagnostics
    )


def test_long_concept_ids_use_the_same_derived_id_for_gap_routing():
    value = intent()
    concept_id = "order-" + "x" * 58
    value["concepts"][0]["id"] = concept_id
    value["units"][0]["concept_ids"] = [concept_id]
    value["catalog_groups"][0]["concept_ids"] = [concept_id]
    value["gaps"] = [
        {
            "id": "recovery",
            "category": "source-coverage",
            "claim": "Recovery is outside registered Sources.",
            "evidence": [],
            "unit_ids": [_plan.model_unit_id(concept_id)],
        }
    ]
    result = _plan.compile_intent(KnowledgePlanIntent.model_validate(value), catalogs())
    assert not result.diagnostics
    assert result.plan.effective_units[-1].id == value["gaps"][0]["unit_ids"][0]
