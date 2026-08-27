# Survey

Read contract.md, the target scope and its Source root from the dispatch
packet. The scope lists the source's top-level tracked directories — orient
from build manifests and the README title block first, then map capability
boundaries from entry points, enforced rules, lifecycle, failure paths and
focused tests. Package layout alone is not a domain.

Write the artifact yourself to the packet's `artifact` path — never return
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

`target` is the task name from the dispatch packet. Evidence uses plain
locators (`source/path`, optional `#Lx-Ly`); every range must exist at the
run's recorded revision. The gate enforces at most 32 findings, 8 locators
per finding, 16 gaps and 64 KiB — prioritize Grep-Test knowledge and record
omitted scope as a gap rather than padding. Large sources are split into
one survey task per top-level directory.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the artifact, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, finding ids, gap count. Nothing else.
