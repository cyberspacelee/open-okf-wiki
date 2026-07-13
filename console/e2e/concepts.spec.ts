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
      id: "verification:candidate-1",
      stable_id: "verification:candidate-1",
      type: "verification",
      label: "Verification · candidate-1",
      states: ["accepted"],
      events: [
        {
          ...event,
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
      id: "verification:rejected",
      stable_id: "verification:rejected",
      type: "verification",
      label: "Verification · rejected",
      states: ["rejected"],
      events: [],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "rejected",
      candidate_id: "candidate-rejected",
      metadata: { findings: [], reasons: ["unsupported"] },
    },
    {
      id: "verification:blocked",
      stable_id: "verification:blocked",
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
      type: "concept",
      label: "Workspace",
      states: ["stale"],
      events: [{ ...event, sequence: 9, state: "stale" }],
      revision: null,
      path: null,
      span: null,
      digest: null,
      decision: "stale",
    },
    {
      id: "page:workspace",
      stable_id: "page:workspace",
      type: "page",
      label: "Workspace",
      states: [],
      events: [],
      revision: null,
      path: "concepts/workspace.md",
      span: null,
      digest: null,
      decision: null,
    },
  ],
  edges: [
    {
      id: "1",
      source: "source:guide",
      target: "evidence:guide",
      relation: "contains",
    },
    {
      id: "2",
      source: "evidence:guide",
      target: "claim:defining",
      relation: "grounds",
    },
    {
      id: "3",
      source: "claim:defining",
      target: "verification:candidate-1",
      relation: "verified_by",
    },
    {
      id: "4",
      source: "verification:candidate-1",
      target: "concept:workspace",
      relation: "forms",
    },
    {
      id: "5",
      source: "concept:workspace",
      target: "page:workspace",
      relation: "renders",
    },
  ],
  bounds: {
    limit: 100,
    total_nodes: 250,
    total_edges: 300,
    truncated: true,
  },
}

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

  await page
    .getByRole("button", { name: /A Workspace represents one product/ })
    .click()
  const details = page.getByRole("region", { name: "Node details" })
  await expect(details).toContainText("claim:defining")
  await expect(details).toContainText("candidate-1")
  await expect(details).toContainText(/Jul.*13.*2026|13.*Jul.*2026/)

  await page.getByRole("button", { name: "Filter rejected" }).click()
  await expect(
    page.getByRole("button", { name: /Verification · rejected/ })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Workspace, stale/ })
  ).toHaveCount(0)
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
  const limits: string[] = []
  await mockOverview(page)
  await mockConcepts(page, limits)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/?view=concepts#token=mobile")

  await page.getByRole("button", { name: "Show more" }).click()
  await expect.poll(() => limits.at(-1)).toBe("200")
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

test("rejects malformed nested provenance instead of rendering invented data", async ({
  page,
}) => {
  await mockOverview(page)
  await page.route("**/api/v1/concepts**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...concepts, nodes: [{ type: "claim" }] }),
    })
  })
  await page.goto("/?view=concepts#token=invalid")

  await expect(page.getByRole("alert")).toContainText(
    "invalid provenance response"
  )
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

async function mockConcepts(page: Page, limits: string[] = []) {
  await page.route("**/api/v1/concepts**", async (route) => {
    const url = new URL(route.request().url())
    limits.push(url.searchParams.get("limit") ?? "")
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...concepts,
        bounds: {
          ...concepts.bounds,
          limit: Number(url.searchParams.get("limit") ?? 100),
        },
      }),
    })
  })
}
