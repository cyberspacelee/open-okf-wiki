# Survey

Read contract.md, the target scope and its Source root from the dispatch. Map
capability boundaries from entry points, enforced rules, lifecycle, failure
paths and focused tests. Package layout alone is not a domain.

Write JSON:

    {
      "source": "api",
      "target": "api-core",
      "revision": "<Git commit from the run>",
      "findings": [{
        "id": "api-request-lifecycle",
        "claim": "decision-relevant finding",
        "evidence": ["api/src/request.py#L20-L48"],
        "domain": "requests"
      }],
      "gaps": ["optional explicit gap"],
      "remaining": []
    }

Every finding has at least one valid line locator. Keep at most 16 findings,
four locators per finding and eight gaps; the artifact must stay under 24 KiB.
`remaining` is empty. Prioritize Grep-Test knowledge and record omitted scope as
a gap. Return only artifact path, finding ids and gap count.
