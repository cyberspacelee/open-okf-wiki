import { expect, test, type Page } from "@playwright/test"

const populatedOverview = {
  ok: true,
  project: { id: "catalog-platform", name: "Catalog Platform" },
  source_count: 4,
  latest_bundle: {
    run_id: "run-2026-07-13",
    state: "published",
    updated_at: "2026-07-13T08:30:00Z",
    path: "bundle/catalog-platform",
  },
  active_run: {
    run_id: "run-2026-07-14",
    state: "verifying",
    updated_at: "2026-07-13T09:10:00Z",
  },
  blockers: ["Gateway profile needs a successful capability check."],
  next_actions: ["review_run"],
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => sessionStorage.clear())
})

test("captures the fragment token, clears it, and renders authoritative overview data", async ({
  page,
}) => {
  const externalRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1") {
      externalRequests.push(request.url())
    }
  })
  await page.setViewportSize({ width: 1440, height: 1024 })
  await mockOverview(page, populatedOverview, 200, (authorization) => {
    expect(authorization).toBe("Bearer browser-secret")
  })

  await page.goto("/#token=browser-secret")

  await expect(page).toHaveURL("http://127.0.0.1:4173/")
  await expect(
    page.getByRole("heading", { level: 1, name: "Catalog Platform" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Source health" })
  ).toBeVisible()
  await expect(page.getByText("run-2026-07-14")).toBeVisible()
  await expect(
    page.getByText("Gateway profile needs a successful capability check.")
  ).toBeVisible()
  await expect(page.getByText("Review the pending run")).toBeVisible()
  await expect(
    page.getByText("Verifying", { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Start run" })).toBeDisabled()
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await expect(page.getByRole("button", { name: "Sources" })).toBeDisabled()
  await expect(
    page.evaluate(() => sessionStorage.getItem("okf-wiki-console-token"))
  ).resolves.toBe("browser-secret")
  expect(externalRequests).toEqual([])

  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  })
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sources" })).toBeDisabled()
  await page.screenshot({
    path: "test-results/overview-mobile-menu.png",
    fullPage: true,
  })
})

test("uses the fragment token when session storage is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled")
    }
    Storage.prototype.getItem = () => {
      throw new DOMException("Storage disabled")
    }
  })
  await mockOverview(page, populatedOverview, 200, (authorization) => {
    expect(authorization).toBe("Bearer transient-secret")
  })

  await page.goto("/#token=transient-secret")

  await expect(page).toHaveURL("http://127.0.0.1:4173/")
  await expect(
    page.getByRole("heading", { level: 1, name: "Catalog Platform" })
  ).toBeVisible()
})

test("clears unrelated fragments before reporting a missing session", async ({
  page,
}) => {
  await page.goto("/#section=overview")
  await expect(page).toHaveURL("http://127.0.0.1:4173/")
  await expect(page.getByText("Secure session required")).toBeVisible()
})

for (const [state, label] of [
  ["checking", "Checking"],
  ["publishing", "Publishing"],
] as const) {
  test(`shows exact ${state} run state on the rail and badge`, async ({
    page,
  }) => {
    await mockOverview(page, {
      ...populatedOverview,
      active_run: { ...populatedOverview.active_run, state },
    })

    await page.goto(`/#token=${state}`)
    const flow = page.getByRole("region", { name: "Production flow" })
    await expect(flow.getByText(label, { exact: true })).toHaveCount(2)
  })
}

test("shows an accessible loading state", async ({ page }) => {
  await page.route("**/api/v1/overview", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(populatedOverview),
    })
  })

  await page.goto("/#token=loading")
  await expect(
    page.getByRole("main", { name: "Loading workspace overview" })
  ).toHaveAttribute("aria-busy", "true")
  await expect(page.getByRole("status")).toHaveText("Loading workspace")
})

test("shows the empty source state", async ({ page }) => {
  await mockOverview(page, {
    ...populatedOverview,
    source_count: 0,
    latest_bundle: null,
    active_run: null,
    blockers: [],
    next_actions: ["configure_sources"],
  })

  await page.goto("/#token=empty")
  await expect(page.getByText("No sources configured")).toBeVisible()
  await expect(page.getByText("No active run")).toBeVisible()
  await expect(
    page.getByText("No knowledge bundle has been produced.")
  ).toBeVisible()
  await expect(page.getByText("Configure sources")).toBeVisible()
})

test("shows actionable invalid Workspace feedback for 400", async ({
  page,
}) => {
  await mockOverview(
    page,
    { ok: false, errors: ["workspace.toml is missing project.name"] },
    400
  )
  await page.goto("/#token=invalid")

  await expect(page.getByRole("alert")).toContainText(
    "Workspace configuration needs attention"
  )
  await expect(page.getByRole("alert")).toContainText(
    "workspace.toml is missing project.name"
  )
})

test("shows server feedback for failed responses", async ({ page }) => {
  await mockOverview(page, { message: "Unable to inspect Workspace" }, 500)
  await page.goto("/#token=server")
  await expect(page.getByRole("alert")).toContainText(
    "Workspace Console unavailable"
  )
  await expect(page.getByRole("alert")).toContainText(
    "Unable to inspect Workspace"
  )
})

test("rejects a malformed Overview response", async ({ page }) => {
  await mockOverview(page, { ok: true, project: { id: "bad", name: "Bad" } })
  await page.goto("/#token=malformed")
  await expect(page.getByRole("alert")).toContainText(
    "invalid Overview response"
  )
})

test("requires a launcher-provided session", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Secure session required")).toBeVisible()
})

async function mockOverview(
  page: Page,
  body: unknown,
  status = 200,
  inspectAuthorization?: (value: string | undefined) => void
) {
  await page.route("**/api/v1/overview", async (route) => {
    inspectAuthorization?.(route.request().headers().authorization)
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
}
