# Survey

Read contract.md, the target scope and only its frozen Git snapshot. Map
capability boundaries from entry points, enforced rules, lifecycle, failure
paths and focused tests. Package layout alone is not a domain.

Write JSON:

    {
      "source": "api",
      "target": "api-core",
      "snapshot": "<content_hash from state>",
      "findings": [{
        "id": "api-request-lifecycle",
        "claim": "decision-relevant finding",
        "evidence": ["api/src/request.py#L20-L48"],
        "domain": "requests"
      }],
      "gaps": ["optional explicit gap"],
      "remaining": []
    }

Every finding has at least one valid line locator. remaining must be empty to
complete. Record connection leads as findings; synthesize verifies both ends.
Return only artifact path, finding ids and gap count.
