# Survey

Read contract.md, the target scope and its Source root from the dispatch
packet. The scope lists this task's directories or files, relative to the
Source root — survey only what the scope names. Orient from build manifests
and the README title block first, then map capability boundaries from entry
points, enforced rules, lifecycle, failure paths and focused tests. Package
layout alone is not a domain.

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

`target` is the task name from the dispatch packet. Write claims, domains
and gaps in the packet's `language`; ids stay ASCII slugs. Evidence uses
plain locators (`source/path`, optional `#Lx-Ly`); every range must exist at
the run's recorded revision. The gate enforces at most 32 findings, 8
locators per finding, 16 gaps and a byte budget — prioritize Grep-Test
knowledge and record omitted scope as a gap rather than padding. The Wiki
carries architecture-level knowledge; class-level inventory belongs to
search, not findings. Large sources are pre-split into scope-sized survey
tasks; if a scope is still too dense, record the compression as a gap so a
maintainer can steer the split via `survey.split` in workspace.json.

Then run the packet's `complete_command` from its `workdir`. If the gate
rejects the artifact, fix it and complete again until it passes.

Handoff: artifact path, gate verdict, finding ids, gap count. Nothing else.
