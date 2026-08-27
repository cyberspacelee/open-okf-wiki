# Synthesize

Run only after every survey completes, and only for multiple Git sources.
Read all survey JSON from the dispatch inputs, then reopen the evidence in
the Source roots — confirm each connection from both ends. Never add a
connection with only one evidenced end.

Write the artifact yourself to the packet's `artifact` path — never return
its content in your reply:

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

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the artifact, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, connection ids, gap count.
