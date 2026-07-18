"""Compatibility shim — evaluation lives in ``okf_wiki.evaluation``."""

from .evaluation.wiki_evaluation import WikiEvaluationReport, evaluate_wiki_producer

__all__ = ["WikiEvaluationReport", "evaluate_wiki_producer"]
