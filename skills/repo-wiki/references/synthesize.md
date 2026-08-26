# Synthesize

Run only after every survey completes and only for multiple Git sources. Read
all survey JSON and reopen evidence in frozen snapshots. Confirm each
connection from both ends.

Write drafts/synthesize.json:

    {
      "connections": [{
        "id": "web-calls-api",
        "source_a": "web",
        "source_b": "api",
        "evidence_a": ["web/src/client.ts#L10-L30"],
        "evidence_b": ["api/src/routes.py#L8-L25"],
        "contract": "HTTP request/response boundary",
        "failure_propagation": "API errors surface through the web client"
      }],
      "gaps": []
    }

Do not add a connection with only one evidenced end.
