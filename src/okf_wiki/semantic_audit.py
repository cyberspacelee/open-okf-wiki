import json
import sqlite3
import uuid
from pathlib import Path
from typing import TypedDict

from pydantic_ai import ModelRequest, ModelResponse
from pydantic_ai.messages import RetryPromptPart
from pydantic_ai.usage import RunUsage

from .security import redact_secrets
from .state_schema import migrate_worker_audit


class AuditGroup(TypedDict):
    role: str
    model: str
    calls: int
    failures: int
    latency_ms: int
    retries: int
    tokens: int
    tool_calls: int


def initialize_semantic_audit(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        migrate_worker_audit(connection)


def record_agent_invocation(
    path: Path,
    *,
    role: str,
    status: str,
    messages: list[ModelRequest | ModelResponse],
    usage: RunUsage | None,
    latency_ms: int,
    model: str,
    error: str | None,
    secrets: tuple[str, ...],
) -> None:
    if usage is None:
        usage = RunUsage()
        for message in messages:
            if isinstance(message, ModelResponse):
                usage.incr(message.usage)
    payload = {
        "requests": usage.requests,
        "tool_calls": usage.tool_calls,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
    }
    retries = sum(
        isinstance(part, RetryPromptPart) for message in messages for part in message.parts
    )
    with sqlite3.connect(path, timeout=30) as connection:
        connection.execute(
            """INSERT INTO agent_invocations
               (id, role, status, usage_json, latency_ms, retry_count, model, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                uuid.uuid4().hex,
                role,
                status,
                json.dumps(payload, sort_keys=True),
                latency_ms,
                retries,
                redact_secrets(model, secrets),
                redact_secrets(error, secrets) if error else None,
            ),
        )


def aggregate_semantic_audit(path: Path) -> dict:
    totals = {
        "by_role_model": [],
        "failures": 0,
        "latency_ms": 0,
        "models": set(),
        "retries": 0,
        "tokens": 0,
        "tool_calls": 0,
    }
    if not path.is_file():
        return {**totals, "models": []}
    records: list[tuple[str, str, str, str, int, int]] = []
    with sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True) as connection:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "worker_candidates" in tables:
            records.extend(
                ("worker", model, status, usage, latency, retries)
                for status, usage, latency, retries, model in connection.execute(
                    """SELECT status, usage_json, latency_ms, retry_count, response_model
                       FROM worker_candidates"""
                )
            )
        if "agent_invocations" in tables:
            records.extend(
                (role, model, status, usage, latency, retries)
                for role, status, usage, latency, retries, model in connection.execute(
                    """SELECT role, status, usage_json, latency_ms, retry_count, model
                       FROM agent_invocations"""
                )
            )
    groups: dict[tuple[str, str], AuditGroup] = {}
    for role, model, status, usage_json, latency_ms, retries in records:
        usage = json.loads(usage_json)
        failures = status != "accepted"
        totals["failures"] += failures
        totals["latency_ms"] += latency_ms
        totals["models"].add(model)
        totals["retries"] += retries
        totals["tokens"] += usage.get("total_tokens", 0)
        totals["tool_calls"] += usage.get("tool_calls", 0)
        group = groups.setdefault(
            (role, model),
            {
                "role": role,
                "model": model,
                "calls": 0,
                "failures": 0,
                "latency_ms": 0,
                "retries": 0,
                "tokens": 0,
                "tool_calls": 0,
            },
        )
        group["calls"] += 1
        group["failures"] += failures
        group["latency_ms"] += latency_ms
        group["retries"] += retries
        group["tokens"] += usage.get("total_tokens", 0)
        group["tool_calls"] += usage.get("tool_calls", 0)
    return {
        **totals,
        "by_role_model": [groups[key] for key in sorted(groups)],
        "models": sorted(totals["models"]),
    }
