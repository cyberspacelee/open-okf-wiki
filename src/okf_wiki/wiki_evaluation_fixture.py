"""Compatibility shim — evaluation fixtures live in ``okf_wiki.evaluation``."""

from .evaluation.wiki_evaluation_fixture import FixtureCase, fixture_cases, fixture_model

__all__ = ["FixtureCase", "fixture_cases", "fixture_model"]
