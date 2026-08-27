import pytest
from _models import Survey
from pydantic import ValidationError


def finding(index: int) -> dict:
    return {
        "id": f"finding-{index}",
        "claim": "Decision-relevant claim.",
        "evidence": ["SourceA/app.py#L1-L2"],
        "domain": "core",
    }


def test_survey_is_revision_bound_and_context_bounded():
    survey = Survey.model_validate(
        {
            "source": "SourceA",
            "target": "source-core",
            "revision": "a" * 40,
            "findings": [finding(index) for index in range(16)],
            "gaps": ["Missing runtime evidence."],
            "remaining": [],
        }
    )
    assert survey.revision == "a" * 40

    with pytest.raises(ValidationError):
        Survey.model_validate(
            {
                **survey.model_dump(),
                "findings": [finding(index) for index in range(17)],
            }
        )
    with pytest.raises(ValidationError):
        Survey.model_validate(
            {**survey.model_dump(), "remaining": ["more source to read"]}
        )
    with pytest.raises(ValidationError):
        Survey.model_validate(
            {
                **survey.model_dump(),
                "findings": [{**finding(1), "evidence": ["x"] * 5}],
            }
        )
