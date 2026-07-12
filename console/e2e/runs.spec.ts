import { expect, test, type Page } from "@playwright/test"

const overview = {
  ok: true,
  project: { id: "catalog", name: "Catalog" },
  source_count: 1,
  latest_bundle: null,
  active_run: {
    run_id: "run-active",
    state: "preparing",
    updated_at: "2026-07-13T09:00:00Z",
  },
  blockers: [],
  next_actions: ["view_run"],
}

test("deep links, polls recorded phases, and reloads the same Run", async ({
  page,
}) => {
  let detailRequests = 0
  await mockShell(page)
  await page.route("**/api/v1/runs/run-active", async (route) => {
    detailRequests += 1
    const state =
      detailRequests <= 2
        ? "preparing"
        : detailRequests <= 4
          ? "verifying"
          : "review_required"
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail(state)),
    })
  })
  await page.route("**/api/v1/runs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runs: [summary("preparing")] }),
    })
  })

  await page.goto("/?view=runs&run=run-active#token=runs-token")

  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/?view=runs&run=run-active"
  )
  await expect(
    page.getByRole("heading", { level: 1, name: "Production Runs" })
  ).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toHaveText("Preparing")
  await expect(page.locator('[aria-current="step"]')).toHaveText("Verifying")
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  expect(detailRequests).toBeGreaterThanOrEqual(3)

  await page.reload()
  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/?view=runs&run=run-active"
  )
  await expect(
    page.getByText("run-active", { exact: true }).last()
  ).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole("heading", { level: 1, name: "Production Runs" })
  ).toBeVisible()
  await page.screenshot({
    path: "test-results/runs-mobile.png",
    fullPage: true,
  })
})

test("polling errors preserve the last valid phase and expose retry", async ({
  page,
}) => {
  let detailRequests = 0
  await mockShell(page)
  await page.route("**/api/v1/runs/run-active", async (route) => {
    detailRequests += 1
    await route.fulfill(
      detailRequests <= 2
        ? {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(detail("verifying")),
          }
        : {
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              errors: ["Run ledger temporarily unavailable"],
            }),
          }
    )
  })
  await page.route("**/api/v1/runs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runs: [summary("verifying")] }),
    })
  })

  await page.goto("/?view=runs&run=run-active#token=retry-token")

  await expect(page.locator('[aria-current="step"]')).toHaveText("Verifying")
  await expect(page.getByRole("alert")).toContainText(
    "Run ledger temporarily unavailable"
  )
  await expect(page.locator('[aria-current="step"]')).toHaveText("Verifying")
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
})

async function mockShell(page: Page) {
  await page.route("**/api/v1/overview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overview),
    })
  })
}

function summary(state: string) {
  return {
    run_id: "run-active",
    state,
    phase: state,
    created_at: "2026-07-13T09:00:00Z",
    updated_at: "2026-07-13T09:00:01Z",
    source_set_digest: "a".repeat(64),
    outcome: state === "review_required" ? "review_required" : null,
    execution: { mode: "deterministic_fixture", requested_outcome: "success" },
  }
}

function detail(state: string) {
  const all = [
    "preparing",
    "exploring",
    "verifying",
    "rendering",
    "checking",
    "review_required",
  ]
  const limit = Math.max(0, all.indexOf(state))
  return {
    ok: true,
    ...summary(state),
    project_id: "catalog",
    actionable_errors: [],
    events: all.slice(0, limit + 1).map((eventState, index) => ({
      sequence: index + 1,
      previous_state: index ? all[index - 1] : null,
      state: eventState,
      occurred_at: `2026-07-13T09:00:0${index}Z`,
    })),
    entity_events: [],
    sources: [
      {
        id: "code",
        role: "implementation",
        revision: "b".repeat(40),
        tree_digest: "c".repeat(64),
      },
    ],
    tasks: { active: [], completed: [], failed: [] },
  }
}
