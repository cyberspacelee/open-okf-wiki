import { expect, test, type Page } from "@playwright/test"

const overview = {
  ok: true,
  project: { id: "catalog", name: "Catalog Platform" },
  source_count: 1,
  latest_bundle: null,
  active_run: null,
  blockers: [],
  next_actions: [],
}

const event = {
  run_id: "run-1",
  entity_type: "claim",
  sequence: 7,
  previous_state: null,
  state: "supported",
  occurred_at: "2026-07-13T01:02:03+00:00",
  candidate_id: "candidate-1",
}

const concepts = {
  ok: true,
  run_id: "run-1",
  run_state: "review_required",
  selected_concept_id: "concept:workspace",
  concepts: [
    {
      id: "concept:workspace",
      name: "Workspace",
      status: "stale",
      page: "concepts/workspace.md",
    },
  ],
  nodes: [
    {
      id: "source:guide",
      stable_id: "source:guide",
      run_id: "run-1",
      type: "source_unit",
      label: "file:guide.md",
      states: [],
      events: [],
      revision: "a".repeat(40),
      path: "guide.md",
      span: { start_line: 1, end_line: 20 },
      digest: `sha256:${"1".repeat(64)}`,
      decision: null,
    },
    {
      id: "evidence:guide",
      stable_id: "evidence:guide",
      run_id: "run-1",
      type: "evidence",
      label: "guide.md:3-4",
      states: [],
      events: [],
      revision: "a".repeat(40),
      path: "guide.md",
      span: { start_line: 3, end_line: 4 },
      digest: `sha256:${"2".repeat(64)}`,
      decision: null,
    },
    {
      id: "claim:defining",
      stable_id: "claim:defining",
      run_id: "run-1",
      type: "claim",
      label: "A Workspace represents one product.",
      states: ["supported", "conflicting", "superseded"],
      role: "defining",
      events: [event],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "supported",
    },
    {
      id: "claim:supporting",
      stable_id: "claim:supporting",
      run_id: "run-1",
      type: "claim",
      label: "A Workspace can include documentation.",
      states: ["disputed"],
      role: "supporting",
      events: [{ ...event, sequence: 8, state: "disputed" }],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "disputed",
    },
    {
      id: "verification:run-1:candidate:candidate-1",
      stable_id: "verification:run-1:candidate:candidate-1",
      run_id: "run-1",
      type: "verification",
      label: "Verification · candidate-1",
      states: ["accepted"],
      events: [
        {
          ...event,
          entity_type: "verification_candidate",
          sequence: 6,
          previous_state: "staged",
          state: "accepted",
        },
      ],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "accepted",
      candidate_id: "candidate-1",
      metadata: { findings: [], reasons: [] },
    },
    {
      id: "verification:run-1:candidate:candidate-rejected",
      stable_id: "verification:run-1:candidate:candidate-rejected",
      run_id: "run-1",
      type: "verification",
      label: "Verification · candidate-rejected",
      states: ["rejected"],
      events: [],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "rejected",
      candidate_id: "candidate-rejected",
      metadata: {
        findings: [
          {
            target_id: "concept-a",
            target_type: "concept",
            perspective: "contradiction",
            verdict: "fail",
            severity: "critical",
            evidence: ["evidence-a"],
            rationale: "The rejected proposal contradicts accepted knowledge.",
          },
        ],
        reasons: ["unsupported"],
      },
    },
    {
      id: "verification:run-1:obligation:obligation-2",
      stable_id: "verification:run-1:obligation:obligation-2",
      run_id: "run-1",
      type: "verification",
      label: "Blocked · obligation-2",
      states: ["blocked"],
      events: [],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "blocked",
      metadata: { reason: "Missing input" },
    },
    {
      id: "concept:workspace",
      stable_id: "concept:workspace",
      run_id: "run-1",
      type: "concept",
      label: "Workspace",
      states: ["stale"],
      events: [
        {
          ...event,
          entity_type: "concept",
          sequence: 9,
          state: "stale",
        },
      ],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "stale",
    },
    {
      id: "page:run-1:concepts/workspace.md",
      stable_id: "page:run-1:concepts/workspace.md",
      run_id: "run-1",
      type: "page",
      label: "Workspace",
      states: [],
      events: [],
      revision: "a".repeat(40),
      path: "concepts/workspace.md",
      span: null,
      digest: `sha256:${"3".repeat(64)}`,
      decision: null,
    },
  ],
  edges: [
    {
      id: "source:guide|contains|evidence:guide",
      source: "source:guide",
      target: "evidence:guide",
      relation: "contains",
    },
    {
      id: "evidence:guide|grounds|claim:defining",
      source: "evidence:guide",
      target: "claim:defining",
      relation: "grounds",
    },
    {
      id: "claim:defining|verified_by|verification:run-1:candidate:candidate-1",
      source: "claim:defining",
      target: "verification:run-1:candidate:candidate-1",
      relation: "verified_by",
    },
    {
      id: "verification:run-1:candidate:candidate-1|forms|concept:workspace",
      source: "verification:run-1:candidate:candidate-1",
      target: "concept:workspace",
      relation: "forms",
    },
    {
      id: "concept:workspace|renders|page:run-1:concepts/workspace.md",
      source: "concept:workspace",
      target: "page:run-1:concepts/workspace.md",
      relation: "renders",
    },
    {
      id: "verification:run-1:candidate:candidate-rejected|proposes|concept:workspace",
      source: "verification:run-1:candidate:candidate-rejected",
      target: "concept:workspace",
      relation: "proposes",
    },
    {
      id: "concept:workspace|assesses|verification:run-1:candidate:candidate-rejected",
      source: "concept:workspace",
      target: "verification:run-1:candidate:candidate-rejected",
      relation: "assesses",
    },
  ],
  bounds: {
    limit: 100,
    offset: 0,
    previous_offset: null,
    next_offset: null,
    total_nodes: 9,
    total_edges: 7,
    filtered_total_nodes: 9,
    filtered_total_edges: 7,
    truncated: false,
  },
}

const extraNodes = Array.from({ length: 241 }, (_, index) => ({
  id: `source:extra-${index}`,
  stable_id: `source:extra-${index}`,
  run_id: "run-1",
  type: "source_unit",
  label: `file:extra-${index}.md`,
  states: [],
  events: [],
  revision: "b".repeat(40),
  path: `extra-${index}.md`,
  span: null,
  digest: `sha256:${index.toString(16).padStart(64, "0")}`,
  decision: null,
}))

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => sessionStorage.clear())
})

test("filters persisted provenance and opens complete node details", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await mockOverview(page)
  await mockConcepts(page)
  await page.goto("/?view=concepts#token=concepts")

  await expect(
    page.getByRole("heading", { level: 1, name: "Concept provenance" })
  ).toBeVisible()
  await expect(
    page.getByText("Source Unit", { exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByText("Bundle page", { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByText("Defining", { exact: true })).toBeVisible()
  await expect(page.getByText("Supporting", { exact: true })).toBeVisible()
  for (const state of [
    "Supported",
    "Disputed",
    "Stale",
    "Conflicting",
    "Superseded",
    "Rejected",
    "Blocked",
  ]) {
    await expect(page.getByText(state, { exact: true }).first()).toBeVisible()
  }

  const details = page.getByRole("region", { name: "Node details" })
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await expect(details).toContainText("run-1")
  await expect(details).toContainText("a".repeat(40))
  await expect(details).toContainText(`sha256:${"3".repeat(64)}`)

  await page
    .getByRole("button", { name: /A Workspace represents one product/ })
    .click()
  await expect(details).toContainText("claim:defining")
  await expect(details).toContainText("candidate-1")
  await expect(details).toContainText(/Jul.*13.*2026|13.*Jul.*2026/)

  await page.getByRole("button", { name: "Filter rejected" }).click()
  const rejected = page.getByRole("button", {
    name: /Verification · candidate-rejected/,
  })
  await expect(rejected).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Workspace, stale/ })
  ).toHaveCount(0)
  await rejected.click()
  await expect(details).toContainText("unsupported")
  await expect(details).toContainText(
    "The rejected proposal contradicts accepted knowledge."
  )
  await expect(details).toContainText("evidence-a")
  await page.getByRole("button", { name: "Filter rejected" }).click()
  await page.getByRole("button", { name: "Filter claims" }).click()
  await expect(
    page.getByRole("button", { name: /A Workspace represents one product/ })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /file:guide.md/ })).toHaveCount(
    0
  )
  expect(errors).toEqual([])
})

test("requests more bounded nodes and stays within a 390px viewport", async ({
  page,
}) => {
  const requests: ConceptRequest[] = []
  await mockOverview(page)
  await mockConcepts(page, requests)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/?view=concepts#token=mobile")

  await page.getByRole("button", { name: "Show more" }).click()
  await expect.poll(() => requests.at(-1)?.limit).toBe("200")
  await page.getByRole("button", { name: "Next" }).click()
  await expect.poll(() => requests.at(-1)?.offset).toBe("200")
  await page.getByRole("button", { name: "Filter claims" }).click()
  await expect
    .poll(() => requests.at(-1))
    .toMatchObject({
      offset: "0",
      types: "claim",
    })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: "test-results/concepts-mobile.png",
    fullPage: true,
  })
})

test("rejects malformed provenance invariants instead of rendering invented data", async ({
  page,
}) => {
  await mockOverview(page)
  for (const kind of [
    "concept status",
    "node state",
    "decision",
    "event state",
    "duplicate concept",
    "duplicate node",
    "duplicate edge",
    "stable identity",
    "edge identity",
    "selected concept",
    "bounds",
  ]) {
    await test.step(kind, async () => {
      await page.unroute("**/api/v1/concepts**")
      await page.route("**/api/v1/concepts**", async (route) => {
        const url = new URL(route.request().url())
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(malformedConceptResponse(url, kind)),
        })
      })
      await page.goto(
        `/?view=concepts&invalid=${encodeURIComponent(kind)}#token=invalid`
      )
      await expect(page.getByRole("alert")).toContainText(
        "invalid provenance response"
      )
    })
  }
})

async function mockOverview(page: Page) {
  await page.route("**/api/v1/overview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overview),
    })
  })
}

type ConceptRequest = {
  limit: string
  offset: string
  types: string
  states: string
}

async function mockConcepts(page: Page, requests: ConceptRequest[] = []) {
  await page.route("**/api/v1/concepts**", async (route) => {
    const url = new URL(route.request().url())
    requests.push({
      limit: url.searchParams.get("limit") ?? "",
      offset: url.searchParams.get("offset") ?? "",
      types: url.searchParams.get("types") ?? "",
      states: url.searchParams.get("states") ?? "",
    })
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(conceptResponse(url)),
    })
  })
}

function conceptResponse(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 100)
  const offset = Number(url.searchParams.get("offset") ?? 0)
  const types = new Set(
    (url.searchParams.get("types") ?? "").split(",").filter(Boolean)
  )
  const states = new Set(
    (url.searchParams.get("states") ?? "").split(",").filter(Boolean)
  )
  const allNodes = [...concepts.nodes, ...extraNodes]
  const filteredNodes = allNodes.filter(
    (node) =>
      (types.size === 0 || types.has(node.type)) &&
      (states.size === 0 || node.states.some((state) => states.has(state)))
  )
  const filteredIds = new Set(filteredNodes.map((node) => node.id))
  const filteredEdges = concepts.edges.filter(
    (edge) => filteredIds.has(edge.source) && filteredIds.has(edge.target)
  )
  const nodes = filteredNodes.slice(offset, offset + limit)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = filteredEdges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
  )
  const nextOffset =
    offset + limit < filteredNodes.length ? offset + limit : null
  return {
    ...concepts,
    nodes,
    edges,
    bounds: {
      limit,
      offset,
      previous_offset: offset > 0 ? Math.max(0, offset - limit) : null,
      next_offset: nextOffset,
      total_nodes: allNodes.length,
      total_edges: concepts.edges.length,
      filtered_total_nodes: filteredNodes.length,
      filtered_total_edges: filteredEdges.length,
      truncated:
        offset > 0 ||
        nextOffset !== null ||
        filteredEdges.length > edges.length,
    },
  }
}

type MutableConceptResponse = {
  selected_concept_id: string | null
  concepts: Array<Record<string, unknown>>
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  bounds: Record<string, unknown>
}

function malformedConceptResponse(url: URL, kind: string) {
  const payload = structuredClone(
    conceptResponse(url)
  ) as unknown as MutableConceptResponse
  const claim = payload.nodes.find((node) => node.type === "claim")
  if (!claim) throw new Error("Mock Claim missing")
  switch (kind) {
    case "concept status":
      payload.concepts[0].status = "archived"
      break
    case "node state":
      claim.states = ["blocked"]
      break
    case "decision":
      claim.decision = "accepted"
      break
    case "event state": {
      const events = claim.events as Array<Record<string, unknown>>
      events[0].state = "accepted"
      break
    }
    case "duplicate concept":
      payload.concepts.push(structuredClone(payload.concepts[0]))
      break
    case "duplicate node":
      payload.nodes.push(structuredClone(payload.nodes[0]))
      break
    case "duplicate edge":
      payload.edges.push(structuredClone(payload.edges[0]))
      break
    case "stable identity":
      payload.nodes[0].stable_id = "different"
      break
    case "edge identity":
      payload.edges[0].id = "not-canonical"
      break
    case "selected concept":
      payload.selected_concept_id = "concept:missing"
      break
    case "bounds":
      payload.bounds.filtered_total_nodes =
        Number(payload.bounds.filtered_total_nodes) + 1
      break
  }
  return payload
}
