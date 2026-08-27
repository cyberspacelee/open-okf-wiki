# Survey

Read contract.md, the target scope and its Source root from the dispatch
packet. The packet already carries triage `orientation` / `themes` and the
matching `drafts/index/<source>.json` file — orient from those, then read
only the named scope. Package layout alone is not a domain.

Write exactly one survey JSON to the packet's `artifact` path — never return
its content in your reply:

    {
      "source": "api",
      "target": "api",
      "findings": [{
        "id": "api-request-lifecycle",
        "claim": "decision-relevant finding",
        "evidence": ["api/src/request.py#L20-L48"],
        "domain": "requests"
      }],
      "gaps": ["optional explicit gap"]
    }

`target` is the task name from the dispatch packet. Write claims,
domains and gaps in the packet's `language`; ids stay ASCII slugs.
Evidence uses plain locators (`source/path`, optional `#Lx-Ly`); every
range must exist at the run's recorded revision. Write no excerpt or evidence
pack: after the gate validates the locators, the kernel derives the Evidence
Cache from the Pin.

The gate enforces at most 32 findings, 8 locators per finding, 16 gaps and
a byte budget — prioritize Grep-Test knowledge and record omitted scope
as a gap rather than padding. Class-level inventory belongs to search,
not findings.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the artifact, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, finding ids, gap count. Nothing else.
