# Connect

Run only after every survey completes, and only when two or more Git or
files sources exist. One task per source: record that source's edges to
others. Connection ids must be globally unique — emit an edge from exactly
one connect task.

Read survey JSON from the dispatch inputs, then reopen the evidence in the
Pin roots from the packet. Never add a connection with only one evidenced
participant.

Write the artifact yourself to the packet's `artifact` path — never return
its content in your reply:

    {
      "source": "API",
      "connections": [{
        "id": "web-calls-api",
        "participants": [
          {"source": "web", "evidence": ["web/src/client.ts#L10-L30"]},
          {"source": "API", "evidence": ["API/src/routes.py#L8-L25"]}
        ],
        "contract": "HTTP request/response boundary",
        "contract_evidence": ["contracts/openapi.yaml#L1-L40"],
        "failure_propagation": "API errors surface through the web client"
      }],
      "gaps": []
    }

`contract_evidence` is optional and may point at a files Source. Empty
`connections` is valid when this source has no evidenced edges.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the artifact, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, connection ids, gap count.
