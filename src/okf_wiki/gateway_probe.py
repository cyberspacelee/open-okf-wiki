import concurrent.futures
import json
import socket
from collections.abc import Mapping
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, OpenerDirector, Request, build_opener

from .gateway_common import GatewayError


class GatewayConnection(Protocol):
    @property
    def base_url(self) -> str: ...

    @property
    def headers(self) -> Mapping[str, str]: ...


class RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GatewayProbe:
    def __init__(
        self,
        profile: GatewayConnection,
        secret: str,
        timeout_seconds: float,
        *,
        opener: OpenerDirector | None = None,
    ) -> None:
        self.profile = profile
        self.secret = secret
        self.timeout_seconds = timeout_seconds
        self.opener = opener or build_opener(RejectRedirects())

    def run(self, model: str | None) -> dict:
        models_payload = self._request("GET", "models")
        raw_models = models_payload.get("data")
        if not isinstance(raw_models, list):
            raise GatewayError(
                "Gateway model discovery returned an invalid response",
                category="capability",
            )
        models = [
            item["id"]
            for item in raw_models
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]
        if not models:
            raise GatewayError("Gateway model discovery returned no models", category="capability")
        selected = model or models[0]
        if selected not in models:
            raise GatewayError(
                "Selected model is not available from the Gateway",
                category="capability",
                model_specific=True,
            )
        self._verify_error_mapping()

        schema_payload = {
            "model": selected,
            "messages": [{"role": "user", "content": "Return ok=true."}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "okf_gateway_probe",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {"ok": {"type": "boolean"}},
                        "required": ["ok"],
                        "additionalProperties": False,
                    },
                },
            },
        }
        structured = self._request("POST", "chat/completions", schema_payload)
        self._validate_structured(structured)
        self._validate_usage(structured)

        tool_payload = {
            "model": selected,
            "messages": [{"role": "user", "content": "Call the probe tool."}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "okf_probe",
                        "description": "Verify function tool calling.",
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "required": [],
                            "additionalProperties": False,
                        },
                    },
                }
            ],
            "tool_choice": "required",
        }
        tool_result = self._request("POST", "chat/completions", tool_payload)
        self._validate_tools(tool_result)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(self._request, "POST", "chat/completions", schema_payload)
                for _ in range(2)
            ]
            for future in futures:
                self._validate_structured(future.result())

        return {
            "ok": True,
            "model": selected,
            "models": models,
            "error_mapping_basis": "live_invalid_authentication_and_not_found",
            "capabilities": {
                "authentication": True,
                "concurrency": True,
                "error_mapping": True,
                "model_discovery": True,
                "structured_output": True,
                "tool_calling": True,
                "usage_reporting": True,
            },
        }

    def _verify_error_mapping(self) -> None:
        try:
            self._request(
                "GET",
                "models",
                credential="okf-wiki-deliberately-invalid-capability-probe",
            )
        except GatewayError as error:
            if error.category != "authentication":
                raise GatewayError(
                    "Gateway does not map invalid authentication safely",
                    category="capability",
                ) from None
        else:
            raise GatewayError(
                "Gateway accepted an invalid authentication credential",
                category="capability",
            )
        try:
            self._request("GET", ".well-known/okf-wiki-capability-probe-not-found")
        except GatewayError as error:
            if error.category != "request":
                raise GatewayError(
                    "Gateway does not map an authenticated missing endpoint safely",
                    category="capability",
                ) from None
        else:
            raise GatewayError(
                "Gateway unexpectedly serves the capability probe missing endpoint",
                category="capability",
            )

    def _request(
        self,
        method: str,
        endpoint: str,
        payload: dict | None = None,
        *,
        credential: str | None = None,
    ) -> dict:
        body = json.dumps(payload).encode() if payload is not None else None
        request = Request(
            f"{self.profile.base_url}/{endpoint}",
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {credential or self.secret}",
                **self.profile.headers,
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout_seconds) as response:
                raw = response.read(1_048_577)
        except HTTPError as error:
            status = error.code
            error.close()
            raise status_error(status) from None
        except TimeoutError, socket.timeout:
            raise GatewayError("Gateway request timed out", category="timeout") from None
        except URLError as error:
            if isinstance(error.reason, (TimeoutError, socket.timeout)):
                raise GatewayError("Gateway request timed out", category="timeout") from None
            raise GatewayError("Gateway connection failed", category="connection") from None
        except OSError:
            raise GatewayError("Gateway connection failed", category="connection") from None
        if len(raw) > 1_048_576:
            raise GatewayError("Gateway response exceeded the size limit", category="capability")
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            raise GatewayError("Gateway returned invalid JSON", category="capability") from None
        if not isinstance(value, dict):
            raise GatewayError("Gateway returned an invalid response", category="capability")
        return value

    @staticmethod
    def _message(payload: dict) -> dict:
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise GatewayError(
                "Gateway chat response is missing a choice",
                category="capability",
                model_specific=True,
            )
        message = choices[0].get("message")
        if not isinstance(message, dict):
            raise GatewayError(
                "Gateway chat response is missing a message",
                category="capability",
                model_specific=True,
            )
        return message

    def _validate_structured(self, payload: dict) -> None:
        content = self._message(payload).get("content")
        try:
            value = json.loads(content) if isinstance(content, str) else None
        except json.JSONDecodeError:
            value = None
        if value != {"ok": True}:
            raise GatewayError(
                "Gateway does not satisfy structured output",
                category="capability",
                model_specific=True,
            )

    def _validate_tools(self, payload: dict) -> None:
        calls = self._message(payload).get("tool_calls")
        if not isinstance(calls, list) or not calls:
            raise GatewayError(
                "Gateway does not satisfy function tool calling",
                category="capability",
                model_specific=True,
            )
        function = calls[0].get("function") if isinstance(calls[0], dict) else None
        if not isinstance(function, dict) or function.get("name") != "okf_probe":
            raise GatewayError(
                "Gateway returned an invalid function tool call",
                category="capability",
                model_specific=True,
            )

    @staticmethod
    def _validate_usage(payload: dict) -> None:
        usage = payload.get("usage")
        names = ("prompt_tokens", "completion_tokens", "total_tokens")
        if not isinstance(usage, dict) or any(
            not isinstance(usage.get(name), int) for name in names
        ):
            raise GatewayError(
                "Gateway does not report token usage",
                category="capability",
                model_specific=True,
            )


def status_error(status: int) -> GatewayError:
    if 300 <= status <= 399:
        return GatewayError("Gateway redirect was rejected", category="redirect")
    if status in {401, 403}:
        return GatewayError("Gateway authentication was rejected", category="authentication")
    if status == 429:
        return GatewayError("Gateway rate limit was reached", category="rate_limit")
    if 500 <= status <= 599:
        return GatewayError("Gateway service failed", category="gateway")
    return GatewayError(f"Gateway request failed with HTTP {status}", category="request")
