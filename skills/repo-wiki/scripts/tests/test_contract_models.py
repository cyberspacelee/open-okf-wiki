import pytest
from _models import Connect, Connection, PagePlan, Survey
from pydantic import ValidationError


def finding(index: int) -> dict:
    return {
        "id": f"finding-{index}",
        "claim": "Decision-relevant claim.",
        "evidence": ["SourceA/app.py#L1-L2"],
        "domain": "core",
    }


def test_survey_allows_thirty_two_findings_and_eight_locators():
    survey = Survey.model_validate(
        {
            "source": "SourceA",
            "target": "source-core",
            "findings": [finding(index) for index in range(32)],
            "gaps": ["Missing runtime evidence."],
        }
    )
    assert len(survey.findings) == 32

    with pytest.raises(ValidationError):
        Survey.model_validate(
            {
                **survey.model_dump(),
                "findings": [finding(index) for index in range(33)],
            }
        )
    with pytest.raises(ValidationError):
        Survey.model_validate(
            {
                **survey.model_dump(),
                "findings": [{**finding(1), "evidence": ["x"] * 9}],
            }
        )


def test_connection_requires_two_participants_and_unique_sources():
    connection = Connection.model_validate(
        {
            "id": "web-api",
            "participants": [
                {"source": "WebUI", "evidence": ["WebUI/app.py#L1-L2"]},
                {"source": "API", "evidence": ["API/app.py#L1-L2"]},
            ],
            "contract": "HTTP boundary",
            "contract_evidence": ["contracts/openapi.yaml#L1-L20"],
            "failure_propagation": "API errors surface in the web client",
        }
    )
    assert len(connection.participants) == 2
    with pytest.raises(ValidationError):
        Connection.model_validate(
            {
                **connection.model_dump(),
                "participants": [connection.participants[0].model_dump()],
            }
        )
    with pytest.raises(ValidationError):
        Connection.model_validate(
            {
                **connection.model_dump(),
                "participants": [
                    {"source": "API", "evidence": ["API/a.py#L1-L1"]},
                    {"source": "API", "evidence": ["API/b.py#L1-L1"]},
                ],
            }
        )


def test_connect_artifact_scopes_connections_to_one_source():
    payload = {
        "source": "API",
        "connections": [
            {
                "id": "web-api",
                "participants": [
                    {"source": "API", "evidence": ["API/app.py#L1-L2"]},
                    {"source": "WebUI", "evidence": ["WebUI/app.py#L1-L2"]},
                ],
                "contract": "HTTP boundary",
                "failure_propagation": "web receives API failure",
            }
        ],
        "gaps": [],
    }
    assert Connect.model_validate(payload).source == "API"


def test_plan_shard_may_be_empty_pages():
    plan = PagePlan.model_validate({"source": "API", "pages": [], "exclusions": []})
    assert plan.pages == []
    with pytest.raises(ValidationError):
        PagePlan.model_validate(
            {
                "pages": [
                    {
                        "path": "overview.md",
                        "type": "Overview",
                        "owner": "workspace",
                        "title": "Overview",
                        "description": "Open first.",
                        "tags": [],
                    },
                    {
                        "path": "overview.md",
                        "type": "Overview",
                        "owner": "workspace",
                        "title": "Dup",
                        "description": "Open first.",
                        "tags": [],
                    },
                ]
            }
        )
