import json
import mimetypes
import secrets
import webbrowser
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urlsplit

from .workspace import WorkspaceApplication, WorkspaceError


CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self' data:; font-src 'self'; object-src 'none'; frame-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


class ConsoleServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root: Path | str, port: int, assets: Path) -> None:
        super().__init__(("127.0.0.1", port), ConsoleHandler)
        self.application = WorkspaceApplication(root)
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
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self._api(path, head=head)
        elif self.command in {"GET", "HEAD"}:
            self._asset(path, head=head)
        else:
            self._json(404, {"errors": ["Not found"], "ok": False}, head=head)

    def _api(self, path: str, *, head: bool) -> None:
        if not self._authorized():
            self._json(401, {"errors": ["Unauthorized"], "ok": False}, head=head)
            return
        if self.command not in {"GET", "HEAD"}:
            self._json(404, {"errors": ["Not found"], "ok": False}, head=head)
            return
        try:
            if path == "/api/v1/workspace":
                payload = {"ok": True, **self.server.application.inspect()}
            elif path == "/api/v1/overview":
                payload = {"ok": True, **self.server.application.overview()}
            else:
                self._json(404, {"errors": ["Not found"], "ok": False}, head=head)
                return
        except WorkspaceError as error:
            self._json(400, {"errors": [str(error)], "ok": False}, head=head)
            return
        except Exception:
            self._json(500, {"errors": ["Internal server error"], "ok": False}, head=head)
            return
        self._json(200, payload, head=head)

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
) -> tuple[ConsoleServer, str]:
    if not 0 <= port <= 65535:
        raise WorkspaceError("Console port must be between 0 and 65535")
    asset_root = assets or Path(__file__).with_name("console_assets")
    server = ConsoleServer(root, port, asset_root)
    session_url = f"{server.origin}/#token={quote(server.session_token)}"
    return server, session_url


def run_console(root: Path | str, port: int = 0, *, open_browser: bool = True) -> int:
    server, session_url = create_console(root, port)
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
