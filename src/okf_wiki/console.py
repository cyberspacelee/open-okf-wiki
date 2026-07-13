import json
import mimetypes
import secrets
import webbrowser
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .gateway_common import GatewayError
from .gateway_profiles import GatewayApplication
from .workspace import (
    WorkspaceApplication,
    WorkspaceError,
    WorkspaceReviewStaleError,
    WorkspaceStaleError,
)


CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self' data:; font-src 'self'; object-src 'none'; frame-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
MAX_JSON_BODY = 1024 * 1024


class ConsoleRequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class ConsoleServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        root: Path | str,
        port: int,
        assets: Path,
        config_root: Path | str | None = None,
    ) -> None:
        super().__init__(("127.0.0.1", port), ConsoleHandler)
        self.application = WorkspaceApplication(root, config_root=config_root)
        self.gateways = GatewayApplication(config_root)
        self.assets = assets.resolve()
        self.session_token = secrets.token_urlsafe(32)
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.expected_host = f"127.0.0.1:{self.server_port}"


class ConsoleHandler(BaseHTTPRequestHandler):
    server: ConsoleServer
    server_version = "okf-wiki"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self._handle(head=False)

    def do_HEAD(self) -> None:
        self._handle(head=True)

    def do_POST(self) -> None:
        self._handle(head=False)

    def do_PUT(self) -> None:
        self._handle(head=False)

    def do_PATCH(self) -> None:
        self._handle(head=False)

    def do_DELETE(self) -> None:
        self._handle(head=False)

    def do_OPTIONS(self) -> None:
        self._handle(head=False)

    def _handle(self, *, head: bool) -> None:
        if self.headers.get_all("Host", []) != [self.server.expected_host]:
            self._json(400, {"errors": ["Invalid Host header"], "ok": False}, head=head)
            return
        if self.command not in {"GET", "HEAD"}:
            if not self._authorized():
                self._json(401, {"errors": ["Unauthorized"], "ok": False}, head=head)
                return
            if self.headers.get("Origin") != self.server.origin:
                self._json(403, {"errors": ["Invalid request origin"], "ok": False}, head=head)
                return
        request_url = urlsplit(self.path)
        path = request_url.path
        if path.startswith("/api/"):
            self._api(path, request_url.query, head=head)
        elif self.command in {"GET", "HEAD"}:
            self._asset(path, head=head)
        else:
            self._json(404, {"errors": ["Not found"], "ok": False}, head=head)

    def _api(self, path: str, query_string: str, *, head: bool) -> None:
        if not self._authorized():
            self._json(401, {"errors": ["Unauthorized"], "ok": False}, head=head)
            return
        try:
            if path == "/api/v1/workspace" and self.command in {"GET", "HEAD"}:
                payload = {"ok": True, **self.server.application.inspect()}
            elif path == "/api/v1/overview" and self.command in {"GET", "HEAD"}:
                payload = {"ok": True, **self.server.application.overview()}
            elif path == "/api/v1/settings" and self.command in {"GET", "HEAD"}:
                payload = {"ok": True, **self.server.application.settings()}
            elif path == "/api/v1/settings" and self.command == "PUT":
                payload = {
                    "ok": True,
                    **self.server.application.update_settings_payload(self._json_body()),
                }
            elif path == "/api/v1/sources" and self.command in {"GET", "HEAD"}:
                payload = {"ok": True, **self.server.application.sources()}
            elif path == "/api/v1/workspace/preflight" and self.command in {"GET", "HEAD"}:
                payload = {"ok": True, **self.server.application.run_preflight()}
            elif path == "/api/v1/runs" and self.command in {"GET", "HEAD"}:
                payload = {"ok": True, **self.server.application.list_runs()}
            elif path == "/api/v1/concepts" and self.command in {"GET", "HEAD"}:
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                unknown = set(query) - {
                    "run_id",
                    "concept_id",
                    "limit",
                    "offset",
                    "types",
                    "states",
                }
                if unknown or any(len(values) != 1 for values in query.values()):
                    raise ConsoleRequestError(400, "Invalid Concepts query")
                try:
                    limit = int(query.get("limit", ["100"])[0])
                    offset = int(query.get("offset", ["0"])[0])
                except ValueError as error:
                    raise ConsoleRequestError(
                        400, "Concept limit and offset must be integers"
                    ) from error

                def comma_values(name: str) -> tuple[str, ...]:
                    raw = query.get(name, [""])[0]
                    if not raw:
                        return ()
                    values = tuple(raw.split(","))
                    if any(not value or value.strip() != value for value in values):
                        raise ConsoleRequestError(400, "Invalid Concepts query")
                    return values

                payload = {
                    "ok": True,
                    **self.server.application.concept_provenance(
                        run_id=query.get("run_id", [None])[0] or None,
                        concept_id=query.get("concept_id", [None])[0] or None,
                        limit=limit,
                        offset=offset,
                        node_types=comma_values("types"),
                        states=comma_values("states"),
                    ),
                }
            elif path == "/api/v1/replay" and self.command in {"GET", "HEAD"}:
                query = self._query(
                    query_string,
                    {
                        "run_id",
                        "event_limit",
                        "event_offset",
                        "event_sequence",
                        "entity_type",
                        "entity_id",
                        "impact_limit",
                        "impact_offset",
                        "path_limit",
                        "path_offset",
                    },
                )
                try:
                    event_limit = int(query.get("event_limit", "50"))
                    event_offset = int(query.get("event_offset", "0"))
                    impact_limit = int(query.get("impact_limit", "100"))
                    impact_offset = int(query.get("impact_offset", "0"))
                    path_limit = int(query.get("path_limit", "50"))
                    path_offset = int(query.get("path_offset", "0"))
                    event_sequence = (
                        int(query["event_sequence"]) if "event_sequence" in query else None
                    )
                except ValueError as error:
                    raise ConsoleRequestError(
                        400, "Replay limits and offsets must be integers"
                    ) from error
                entity_type = query.get("entity_type") or None
                entity_id = query.get("entity_id") or None
                if (entity_type is None) != (entity_id is None):
                    raise ConsoleRequestError(400, "Provide both entity_type and entity_id")
                if event_sequence is not None and entity_id is not None:
                    raise ConsoleRequestError(
                        400, "Choose either event_sequence or an entity locator"
                    )
                payload = {
                    "ok": True,
                    **self.server.application.concept_replay(
                        run_id=query.get("run_id") or None,
                        event_limit=event_limit,
                        event_offset=event_offset,
                        event_sequence=event_sequence,
                        entity_type=entity_type,
                        entity_id=entity_id,
                        impact_limit=impact_limit,
                        impact_offset=impact_offset,
                        path_limit=path_limit,
                        path_offset=path_offset,
                    ),
                }
            elif path == "/api/v1/runs" and self.command == "POST":
                payload = {"ok": True, **self.server.application.start_run(self._json_body())}
            elif path.startswith("/api/v1/runs/") and self.command == "POST":
                run_path = path.removeprefix("/api/v1/runs/")
                if run_path.endswith("/cancel"):
                    run_id = unquote(run_path.removesuffix("/cancel"))
                    payload = {"ok": True, **self.server.application.cancel_run(run_id)}
                elif run_path.endswith("/recover"):
                    run_id = unquote(run_path.removesuffix("/recover"))
                    payload = {"ok": True, **self.server.application.recover_run(run_id)}
                else:
                    raise ConsoleRequestError(404, "Not found")
            elif path.startswith("/api/v1/runs/") and self.command in {"GET", "HEAD"}:
                run_id = unquote(path.removeprefix("/api/v1/runs/"))
                payload = {"ok": True, **self.server.application.run_status(run_id)}
            elif path.startswith("/api/v1/reviews/"):
                parts = path.removeprefix("/api/v1/reviews/").split("/")
                run_id = unquote(parts[0])
                if len(parts) == 1 and self.command in {"GET", "HEAD"}:
                    payload = {"ok": True, **self.server.application.review_snapshot(run_id)}
                elif len(parts) == 2 and parts[1] == "decision" and self.command == "POST":
                    result = self.server.application.decide_review(run_id, self._json_body())
                    if "errors" in result:
                        self._json(422, {"ok": False, **result}, head=head)
                        return
                    payload = {"ok": True, **result}
                elif len(parts) == 3 and parts[1] == "evidence" and self.command in {"GET", "HEAD"}:
                    payload = {
                        "ok": True,
                        **self.server.application.review_evidence(run_id, unquote(parts[2])),
                    }
                elif len(parts) == 3 and parts[1] == "bundle" and self.command in {"GET", "HEAD"}:
                    payload = {
                        "ok": True,
                        **self.server.application.review_bundle_file(run_id, unquote(parts[2])),
                    }
                else:
                    self._json(404, {"errors": ["Not found"], "ok": False}, head=head)
                    return
            elif path == "/api/v1/sources/clone" and self.command == "POST":
                payload = {"ok": True, **self.server.application.clone_source(self._json_body())}
            elif path == "/api/v1/sources/link" and self.command == "POST":
                payload = {"ok": True, **self.server.application.link_source(self._json_body())}
            elif path == "/api/v1/sources/remove" and self.command == "POST":
                payload = {"ok": True, **self.server.application.remove_source(self._json_body())}
            elif path == "/api/v1/sources/delete-managed" and self.command == "POST":
                payload = {
                    "ok": True,
                    **self.server.application.delete_managed_source(self._json_body()),
                }
            elif path == "/api/v1/sources/pull" and self.command == "POST":
                payload = {"ok": True, **self.server.application.pull_source(self._json_body())}
            elif path == "/api/v1/sources/revision" and self.command == "PUT":
                payload = {
                    "ok": True,
                    **self.server.application.set_source_revision(self._json_body()),
                }
            elif path == "/api/v1/gateway-profiles" and self.command in {"GET", "HEAD"}:
                payload = {"ok": True, "profiles": self.server.gateways.list_profiles()}
            elif path == "/api/v1/gateway-profiles" and self.command == "POST":
                body = self._json_body()
                profile = body.get("profile")
                if not isinstance(profile, dict):
                    raise GatewayError("invalid field 'profile': must be an object")
                credential = body.get("credential")
                expected = body.get("expected_revision")
                if credential is not None and not isinstance(credential, str):
                    raise GatewayError("invalid field 'credential': must be a string")
                if expected is not None and not isinstance(expected, int):
                    raise GatewayError("invalid field 'expected_revision': must be an integer")
                payload = {
                    "ok": True,
                    "profile": self.server.gateways.save_profile(
                        profile,
                        credential=credential,
                        expected_revision=expected,
                    ),
                }
            elif (
                path.startswith("/api/v1/gateway-profiles/")
                and path.endswith("/test")
                and self.command == "POST"
            ):
                profile_id = unquote(
                    path.removeprefix("/api/v1/gateway-profiles/").removesuffix("/test").rstrip("/")
                )
                body = self._json_body()
                model = body.get("model")
                timeout = body.get("timeout_seconds", 10)
                if model is not None and not isinstance(model, str):
                    raise GatewayError("invalid field 'model': must be a string")
                if not isinstance(timeout, int | float):
                    raise GatewayError("invalid field 'timeout_seconds': must be a number")
                payload = {
                    "ok": True,
                    "result": self.server.gateways.test_profile(
                        profile_id,
                        model=model,
                        timeout_seconds=float(timeout),
                    ),
                }
            elif path == "/api/v1/workspace/models" and self.command == "PUT":
                body = self._json_body()
                payload = {
                    "ok": True,
                    "workspace": self.server.gateways.select_workspace(
                        self.server.application.root,
                        profile_id=self._required_text(body, "profile_id"),
                        default_model=self._required_text(body, "default_model"),
                        concurrency=body.get("concurrency", 4),
                        budgets=body.get("budgets", {}),
                        role_overrides=body.get("role_overrides", {}),
                    ),
                }
            elif path == "/api/v1/workspace/run-snapshot" and self.command in {"GET", "HEAD"}:
                payload = {
                    "ok": True,
                    "models": self.server.gateways.run_snapshot(self.server.application.root),
                }
            elif path == "/api/v1/knowledge" and self.command in {"GET", "HEAD"}:
                query = self._query(query_string, {"bundle", "run_id"})
                payload = {
                    "ok": True,
                    **self.server.application.knowledge_snapshot(
                        query.get("bundle", "staged"), query.get("run_id")
                    ),
                }
            elif path == "/api/v1/knowledge/page" and self.command in {"GET", "HEAD"}:
                query = self._query(query_string, {"bundle", "path", "run_id"}, {"path", "run_id"})
                payload = {
                    "ok": True,
                    **self.server.application.knowledge_page(
                        query.get("bundle", "staged"), query["path"], query["run_id"]
                    ),
                }
            elif path == "/api/v1/knowledge/search" and self.command in {"GET", "HEAD"}:
                query = self._query(
                    query_string, {"bundle", "query", "run_id"}, {"query", "run_id"}
                )
                payload = {
                    "ok": True,
                    "results": self.server.application.search_knowledge(
                        query["query"], query.get("bundle", "staged"), query["run_id"]
                    ),
                }
            elif path == "/api/v1/knowledge/query" and self.command == "POST":
                payload = {
                    "ok": True,
                    **self.server.application.query_knowledge(self._json_body()),
                }
            elif path == "/api/v1/source-investigations" and self.command == "POST":
                payload = {
                    "ok": True,
                    **self.server.application.investigate_source(self._json_body()),
                }
            elif path == "/api/v1/knowledge/diff" and self.command in {"GET", "HEAD"}:
                query = self._query(
                    query_string,
                    {"base", "base_run_id", "path", "target", "target_run_id"},
                    {"base", "base_run_id", "path", "target", "target_run_id"},
                )
                payload = {
                    "ok": True,
                    **self.server.application.diff_knowledge(
                        query["path"],
                        query["base"],
                        query["target"],
                        query["base_run_id"],
                        query["target_run_id"],
                    ),
                }
            elif path.startswith("/api/v1/knowledge/claims/") and self.command in {"GET", "HEAD"}:
                query = self._query(query_string, {"bundle", "run_id"}, {"run_id"})
                claim_id = unquote(path.removeprefix("/api/v1/knowledge/claims/"))
                payload = {
                    "ok": True,
                    **self.server.application.knowledge_claim(
                        claim_id, query.get("bundle", "staged"), query["run_id"]
                    ),
                }
            else:
                self._json(404, {"errors": ["Not found"], "ok": False}, head=head)
                return
        except ConsoleRequestError as error:
            self._json(error.status, {"errors": [str(error)], "ok": False}, head=head)
            return
        except WorkspaceReviewStaleError as error:
            self._json(
                409,
                {
                    "errors": [str(error)],
                    "ok": False,
                    "review": {"ok": True, **error.snapshot},
                },
                head=head,
            )
            return
        except WorkspaceStaleError as error:
            self._json(409, {"errors": [str(error)], "ok": False}, head=head)
            return
        except (GatewayError, WorkspaceError) as error:
            self._json(400, {"errors": [str(error)], "ok": False}, head=head)
            return
        except Exception:
            self._json(500, {"errors": ["Internal server error"], "ok": False}, head=head)
            return
        self._json(200, payload, head=head)

    def _json_body(self) -> dict:
        media_type = self.headers.get("Content-Type", "").partition(";")[0].strip().lower()
        if media_type != "application/json":
            raise ConsoleRequestError(415, "Content-Type must be application/json")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError as error:
            raise ConsoleRequestError(400, "Invalid JSON request body") from error
        if length > MAX_JSON_BODY:
            raise ConsoleRequestError(413, "JSON request body is too large")
        if length < 1:
            raise ConsoleRequestError(400, "Invalid JSON request body")
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ConsoleRequestError(400, "Invalid JSON request body") from error
        if not isinstance(payload, dict):
            raise ConsoleRequestError(400, "JSON request body must be an object")
        return payload

    @staticmethod
    def _required_text(payload: dict, name: str) -> str:
        value = payload.get(name)
        if not isinstance(value, str) or not value.strip():
            raise GatewayError(f"invalid field '{name}': must be a non-empty string")
        return value

    @staticmethod
    def _query(
        query_string: str, allowed: set[str], required: set[str] | None = None
    ) -> dict[str, str]:
        try:
            values = parse_qs(query_string, keep_blank_values=True, strict_parsing=True)
        except ValueError as error:
            raise ConsoleRequestError(400, "Invalid query string") from error
        if unknown := set(values) - allowed:
            raise ConsoleRequestError(400, f"Unknown query parameter: {sorted(unknown)[0]}")
        if duplicate := next((key for key, items in values.items() if len(items) != 1), None):
            raise ConsoleRequestError(400, f"Duplicate query parameter: {duplicate}")
        query = {key: items[0] for key, items in values.items()}
        if missing := next(
            (key for key in sorted(required or set()) if not query.get(key, "").strip()), None
        ):
            raise ConsoleRequestError(400, f"Missing query parameter: {missing}")
        return query

    def _authorized(self) -> bool:
        received = self.headers.get("Authorization", "").encode(errors="surrogatepass")
        expected = f"Bearer {self.server.session_token}".encode()
        return compare_digest(received, expected)

    def _asset(self, raw_path: str, *, head: bool) -> None:
        try:
            decoded = unquote(raw_path, errors="strict")
        except UnicodeDecodeError:
            self._not_found(head)
            return
        if decoded in {"/", "/index.html"}:
            relative = PurePosixPath("index.html")
        elif decoded.startswith("/assets/"):
            relative = PurePosixPath(decoded.removeprefix("/"))
        else:
            self._not_found(head)
            return
        if ".." in relative.parts or "\\" in decoded or "\0" in decoded:
            self._not_found(head)
            return
        target = (self.server.assets / Path(*relative.parts)).resolve()
        try:
            target.relative_to(self.server.assets)
        except ValueError:
            self._not_found(head)
            return
        if not target.is_file():
            self._not_found(head)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        try:
            body = target.read_bytes()
        except OSError:
            self._json(500, {"errors": ["Internal server error"], "ok": False}, head=head)
            return
        self._send(200, body, content_type, head=head)

    def _not_found(self, head: bool) -> None:
        self._json(404, {"errors": ["Not found"], "ok": False}, head=head)

    def _json(self, status: int, payload: dict, *, head: bool) -> None:
        self._send(
            status,
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode(),
            "application/json",
            head=head,
        )

    def _send(self, status: int, body: bytes, content_type: str, *, head: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head:
            self.wfile.write(body)


def create_console(
    root: Path | str,
    port: int = 0,
    *,
    assets: Path | None = None,
    config_root: Path | str | None = None,
) -> tuple[ConsoleServer, str]:
    if not 0 <= port <= 65535:
        raise WorkspaceError("Console port must be between 0 and 65535")
    asset_root = assets or Path(__file__).with_name("console_assets")
    server = ConsoleServer(root, port, asset_root, config_root)
    session_url = f"{server.origin}/#token={quote(server.session_token)}"
    return server, session_url


def run_console(
    root: Path | str,
    port: int = 0,
    *,
    open_browser: bool = True,
    config_root: Path | str | None = None,
) -> int:
    server, session_url = create_console(root, port, config_root=config_root)
    print(
        json.dumps(
            {"address": server.origin, "ok": True, "session_url": session_url},
            sort_keys=True,
        ),
        flush=True,
    )
    if open_browser:
        webbrowser.open(session_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0
