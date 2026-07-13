import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from okf_wiki.gateway_profiles import GatewayApplication, GatewayProfileRegistry
from okf_wiki.workspace import WorkspaceApplication


CREDENTIAL = "launcher-credential-must-not-leak"
HEADER_VALUE = "launcher-header-must-not-leak"
SOURCE_LINE = "Catalog entries MUST remain deterministic."


def git(repository: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def semantic_workspace(tmp_path: Path, base_url: str) -> tuple[WorkspaceApplication, Path, dict]:
    repository = tmp_path / "source"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.email", "fixture@example.test")
    git(repository, "config", "user.name", "Fixture")
    (repository / "README.md").write_text(f"# Catalog\n\n{SOURCE_LINE}\n")
    git(repository, "add", "README.md")
    git(repository, "commit", "-m", "fixture")

    workspace = tmp_path / "workspace"
    config_root = tmp_path / "machine-config-must-not-leak"
    application = WorkspaceApplication(workspace, config_root=config_root)
    application.initialize("catalog")
    application.link_source({"id": "code", "role": "implementation", "checkout": str(repository)})
    settings = application.settings()
    settings["definition"]["profile"]["dispositions"]["major"] = {
        "disposition": "open",
        "reason": None,
    }
    application.update_settings(
        settings["definition"],
        settings["local_settings"],
        settings["configuration_digest"],
    )

    registry = GatewayProfileRegistry(config_root)
    registry.save(
        {
            "id": "enterprise",
            "name": "Enterprise Gateway",
            "gateway_id": "fake-openai",
            "base_url": base_url,
            "headers": {"X-Tenant": HEADER_VALUE},
        },
        credential=CREDENTIAL,
    )
    payload = json.loads(registry.path.read_text())
    models = ["planner-model", "worker-model", "verifier-model"]
    payload["profiles"][0]["models"] = models
    payload["profiles"][0]["capabilities"] = {
        model: {
            "authentication": True,
            "concurrency": True,
            "error_mapping": True,
            "model_discovery": True,
            "structured_output": True,
            "tool_calling": True,
            "usage_reporting": True,
        }
        for model in models
    }
    registry.path.write_text(json.dumps(payload))
    GatewayApplication(config_root).select_workspace(
        workspace,
        profile_id="enterprise",
        default_model="worker-model",
        role_overrides={"planner": "planner-model", "verifier": "verifier-model"},
        concurrency=2,
    )
    return application, config_root, application.run_preflight()


def start_from_cli(
    application: WorkspaceApplication,
    config_root: Path,
    preflight: dict,
    *,
    worker_fault: str | None = None,
) -> dict:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "okf_wiki",
            "workspace",
            "start-run",
            str(application.root),
            "--configuration-digest",
            preflight["configuration_digest"],
            "--source-set-digest",
            preflight["source_set_digest"],
            "--config-root",
            str(config_root),
        ],
        cwd=application.root.parent,
        env={
            **os.environ,
            **({"OKF_WIKI_WORKER_FAULT": worker_fault} if worker_fault else {}),
        },
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)


def wait_for_terminal(application: WorkspaceApplication, run_id: str) -> dict:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        status = application.run_status(run_id)
        if status["state"] in {"review_required", "failed"}:
            return status
        time.sleep(0.05)
    raise AssertionError(f"Run {run_id} did not terminate: {status}")


def message_text(payload: dict) -> str:
    content = payload["messages"][-1]["content"]
    if isinstance(content, str):
        return content
    return "".join(item.get("text", "") for item in content if isinstance(item, dict))


class SemanticGatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: "SemanticGatewayServer"

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length))
        self.server.requests.append((dict(self.headers), payload))
        if self.server.failure_status:
            self._send(
                self.server.failure_status,
                {
                    "error": {
                        "message": (
                            f"rejected {CREDENTIAL} {HEADER_VALUE} {self.server.config_root}"
                        )
                    }
                },
            )
            return

        model = payload["model"]
        if model == "planner-model":
            summary = json.loads(message_text(payload))
            obligation = summary["prioritized_obligations"][0]
            output = {
                "tasks": [
                    {
                        "obligation_ids": [obligation["id"]],
                        "source_id": obligation["source_id"],
                        "allowed_paths": [obligation["path"]],
                        "agent_role": "extraction",
                        "allowed_tools": ["list_paths", "search_text", "read_text"],
                        "prompt": "Extract the assigned source-grounded obligation.",
                        "budgets": summary["remaining_budgets"]["worker"],
                    }
                ]
            }
        elif model == "worker-model":
            assignment = json.loads(message_text(payload).split("Task assignment: ", 1)[1])
            obligation_id = assignment["obligation_ids"][0]
            output = {
                "task_id": assignment["task_id"],
                "obligation_ids": [obligation_id],
                "evidence": [
                    {
                        "id": "evidence-1",
                        "source_id": assignment["source_id"],
                        "path": "README.md",
                        "revision": assignment["revision"],
                        "start_line": 3,
                        "end_line": 3,
                        "digest": "sha256:" + hashlib.sha256(SOURCE_LINE.encode()).hexdigest(),
                    }
                ],
                "claims": [
                    {
                        "id": "claim-1",
                        "text": SOURCE_LINE,
                        "evidence_ids": ["evidence-1"],
                    }
                ],
                "concepts": [
                    {
                        "id": "concept-1",
                        "name": "Deterministic catalog entries",
                        "description": "Catalog entries are produced deterministically.",
                        "claim_ids": ["claim-1"],
                    }
                ],
                "relations": [],
                "dispositions": [
                    {
                        "obligation_id": obligation_id,
                        "disposition": "covered",
                        "reason": "The exact source statement is cited.",
                        "evidence_ids": ["evidence-1"],
                    }
                ],
            }
        else:
            prompt = json.loads(message_text(payload))
            output = {
                "target_id": prompt["target"]["candidate_id"],
                "perspective": prompt["perspective"],
                "verdict": "pass",
                "severity": "info",
                "evidence": [prompt["evidence"][0]["id"]],
                "rationale": "The bounded source evidence supports the candidate.",
            }
        self._send(200, self._completion(model, output))

    def _completion(self, model: str, output: dict) -> dict:
        self.server.call_id += 1
        return {
            "id": f"completion-{self.server.call_id}",
            "object": "chat.completion",
            "created": 1,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": f"call-{self.server.call_id}",
                                "type": "function",
                                "function": {
                                    "name": "final_result",
                                    "arguments": json.dumps(output),
                                },
                            }
                        ],
                    },
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SemanticGatewayServer(ThreadingHTTPServer):
    def __init__(self, *, failure_status: int = 0) -> None:
        super().__init__(("127.0.0.1", 0), SemanticGatewayHandler)
        self.call_id = 0
        self.config_root = ""
        self.failure_status = failure_status
        self.requests: list[tuple[dict[str, str], dict]] = []


@contextmanager
def fake_semantic_gateway(*, failure_status: int = 0):
    server = SemanticGatewayServer(failure_status=failure_status)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def assert_machine_secrets_absent(value: object, config_root: Path) -> None:
    encoded = json.dumps(value)
    assert CREDENTIAL not in encoded
    assert HEADER_VALUE not in encoded
    assert str(config_root) not in encoded


def assert_run_storage_is_secret_free(
    application: WorkspaceApplication, run_id: str, config_root: Path
) -> None:
    with sqlite3.connect(application.database_path) as connection:
        stored = connection.execute(
            "SELECT source_set_json, error FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
    assert_machine_secrets_absent(stored, config_root)
    audit = application.root / ".okf-wiki" / "runs" / run_id / "worker.db"
    if audit.is_file():
        with sqlite3.connect(audit) as connection:
            audit_dump = "\n".join(connection.iterdump())
        assert_machine_secrets_absent(audit_dump, config_root)


def test_cli_launcher_runs_semantic_roles_through_fake_gateway(tmp_path: Path) -> None:
    with fake_semantic_gateway() as (server, base_url):
        application, config_root, preflight = semantic_workspace(tmp_path, base_url)
        server.config_root = str(config_root)
        started = start_from_cli(application, config_root, preflight)
        status = wait_for_terminal(application, started["run_id"])

    assert status["state"] == "review_required"
    assert [request[1]["model"] for request in server.requests] == [
        "planner-model",
        "worker-model",
        "verifier-model",
        "verifier-model",
        "verifier-model",
        "verifier-model",
        "verifier-model",
    ]
    assert all(headers["Authorization"] == f"Bearer {CREDENTIAL}" for headers, _ in server.requests)
    assert all(headers["X-Tenant"] == HEADER_VALUE for headers, _ in server.requests)
    assert_machine_secrets_absent([payload for _, payload in server.requests], config_root)
    assert status["models"]["assignments"]["planner"] == "planner-model"
    assert status["models"]["assignments"]["worker"] == "worker-model"
    assert status["models"]["assignments"]["verifier"] == "verifier-model"
    assert_machine_secrets_absent(started, config_root)
    assert_machine_secrets_absent(status, config_root)
    assert_machine_secrets_absent(application.list_runs(), config_root)
    assert_run_storage_is_secret_free(application, started["run_id"], config_root)


def test_cli_recovers_interrupted_semantic_run_with_machine_config_root(tmp_path: Path) -> None:
    with fake_semantic_gateway() as (server, base_url):
        application, config_root, preflight = semantic_workspace(tmp_path, base_url)
        server.config_root = str(config_root)
        started = start_from_cli(application, config_root, preflight, worker_fault="after_state")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            interrupted = application.run_status(started["run_id"])
            if interrupted["operations"]["can_recover"]:
                break
            time.sleep(0.05)
        else:
            raise AssertionError(f"Run did not become recoverable: {interrupted}")

        recovered = subprocess.run(
            [
                sys.executable,
                "-m",
                "okf_wiki",
                "workspace",
                "recover-run",
                started["run_id"],
                str(application.root),
                "--config-root",
                str(config_root),
            ],
            cwd=application.root.parent,
            text=True,
            capture_output=True,
            check=False,
        )
        assert recovered.returncode == 0, recovered.stderr or recovered.stdout
        status = wait_for_terminal(application, started["run_id"])

    assert status["state"] == "review_required"
    assert [request[1]["model"] for request in server.requests] == [
        "planner-model",
        "worker-model",
        "verifier-model",
        "verifier-model",
        "verifier-model",
        "verifier-model",
        "verifier-model",
    ]
    assert all(headers["Authorization"] == f"Bearer {CREDENTIAL}" for headers, _ in server.requests)
    assert all(headers["X-Tenant"] == HEADER_VALUE for headers, _ in server.requests)
    assert_machine_secrets_absent(json.loads(recovered.stdout), config_root)
    assert_machine_secrets_absent(status, config_root)
    assert_machine_secrets_absent(application.list_runs(), config_root)
    assert_run_storage_is_secret_free(application, started["run_id"], config_root)


def test_cli_launcher_maps_gateway_failure_without_secret_diagnostics(tmp_path: Path) -> None:
    with fake_semantic_gateway(failure_status=401) as (server, base_url):
        application, config_root, preflight = semantic_workspace(tmp_path, base_url)
        server.config_root = str(config_root)
        started = start_from_cli(application, config_root, preflight)
        status = wait_for_terminal(application, started["run_id"])

    assert status["state"] == "failed"
    assert status["actionable_errors"] == [
        "RuntimeError: Gateway authentication failed; update the Gateway Profile credential"
    ]
    assert_machine_secrets_absent(started, config_root)
    assert_machine_secrets_absent(status, config_root)
    assert_machine_secrets_absent(application.list_runs(), config_root)
    assert_run_storage_is_secret_free(application, started["run_id"], config_root)


def test_cli_launcher_redacts_unknown_top_level_worker_failure(tmp_path: Path) -> None:
    with fake_semantic_gateway() as (server, base_url):
        application, config_root, preflight = semantic_workspace(tmp_path, base_url)
        server.config_root = str(config_root)
        message = f"unexpected {CREDENTIAL} {HEADER_VALUE} {config_root}"
        with sqlite3.connect(application.database_path) as connection:
            connection.execute(
                f"""CREATE TRIGGER fail_exploration BEFORE UPDATE OF state ON runs
                    WHEN NEW.state = 'exploring'
                    BEGIN SELECT RAISE(ABORT, {json.dumps(message)}); END"""
            )
        started = start_from_cli(application, config_root, preflight)
        status = wait_for_terminal(application, started["run_id"])

    assert status["state"] == "failed"
    assert status["actionable_errors"] == [
        "unexpected [REDACTED CREDENTIAL] [REDACTED CREDENTIAL] [REDACTED CREDENTIAL]"
    ]
    assert server.requests == []
    assert_machine_secrets_absent(started, config_root)
    assert_machine_secrets_absent(status, config_root)
    assert_machine_secrets_absent(application.list_runs(), config_root)
    assert_run_storage_is_secret_free(application, started["run_id"], config_root)
    diagnostics = "".join(
        path.read_text(errors="replace")
        for path in (application.root / ".okf-wiki").rglob("*")
        if path.is_file() and path.suffix in {".json", ".log", ".txt"}
    )
    assert CREDENTIAL not in diagnostics
    assert HEADER_VALUE not in diagnostics
    assert str(config_root) not in diagnostics
