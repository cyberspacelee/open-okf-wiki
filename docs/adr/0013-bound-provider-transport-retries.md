# Bound provider transport retries

Keep provider transport retries separate from PydanticAI tool/output retries and allow at most three total attempts per model request (the initial attempt plus two retries). Retry only HTTP `408`, `429`, `500`, `502`, `503`, and `504`, plus transient connection, read, and timeout failures; authentication, invalid-request, and other stable `4xx` responses fail immediately.

Use PydanticAI's `AsyncTenacityTransport`: honor a valid `Retry-After` header up to 60 seconds, otherwise use exponential backoff with small positive jitter starting at one second and capped at 30 seconds. Retry waits count against the existing Wiki Run wall-clock deadline. A connection/read timeout may have reached the provider, so Host-owned run events record the attempt as possibly duplicated; the bounded retry is still preferred because it has no Wiki write side effect. Once the transport budget is exhausted, the Wiki Run fails without restarting the whole run, and a human may create a new Manual Retry Run.

Separating the budgets prevents nested retry multiplication while retaining a bounded response to rate limits and short-lived provider outages.
