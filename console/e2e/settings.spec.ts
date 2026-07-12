import { expect, test } from "@playwright/test"

const overview = {
  ok: true,
  project: { id: "catalog", name: "Catalog" },
  source_count: 1,
  latest_bundle: null,
  active_run: null,
  blockers: [],
  next_actions: ["start_run"],
}

const settings = {
  ok: true,
  configuration_digest: "a".repeat(64),
  definition: {
    schema_version: 1,
    project: { id: "catalog", name: "Catalog" },
    publication: { path: "published", bundle_name: null },
    sources: [
      { id: "code", role: "implementation", revision: "abc", remote: null },
    ],
    profile: {
      java_excluded_paths: null,
      priorities: { custom_obligation: "major" },
      dispositions: {},
    },
  },
  local_settings: {
    schema_version: 1,
    checkouts: { code: "/source" },
    models: {
      gateway_profile: "enterprise",
      default_model: "model-v1",
      role_overrides: { worker: "model-worker" },
      concurrency: 3,
      budgets: { total_tokens: 12000 },
    },
    ui: { compact_navigation: false },
  },
}

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.clear())
  await page.route("**/api/v1/overview", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overview),
    })
  )
})

test("edits shared and local settings by keyboard without dropping untouched data", async ({
  page,
}) => {
  let update: typeof settings | undefined
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(settings),
      })
      return
    }
    update = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...update,
        ok: true,
        configuration_digest: "b".repeat(64),
      }),
    })
  })

  await page.goto("/#token=settings")
  await page.getByRole("button", { name: "Settings" }).focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace settings" })
  ).toBeVisible()

  const name = page.getByLabel("Display name")
  await name.focus()
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.type("Catalog Platform")
  const bundle = page.getByLabel("Bundle name")
  await bundle.focus()
  await page.keyboard.type("Catalog Knowledge")
  await page
    .getByLabel("Obligation priorities")
    .fill("custom_obligation=supporting\nnumbered_requirement=major")
  await page.getByLabel("Disposition").nth(1).selectOption("excluded")
  await page.getByLabel("Reason").nth(1).fill("Handled by a separate source")
  const compact = page.getByRole("switch", { name: "Compact navigation" })
  await compact.focus()
  await page.keyboard.press("Space")
  await page.getByRole("button", { name: "Save settings" }).focus()
  await page.keyboard.press("Enter")

  await expect(page.getByRole("status")).toContainText("Settings saved")
  expect(update?.definition.project.name).toBe("Catalog Platform")
  expect(update?.definition.publication.bundle_name).toBe("Catalog Knowledge")
  expect(update?.definition.sources).toEqual(settings.definition.sources)
  expect(update?.definition.profile.priorities).toEqual({
    custom_obligation: "supporting",
    numbered_requirement: "major",
  })
  expect(update?.definition.profile.dispositions.supporting).toEqual({
    disposition: "excluded",
    reason: "Handled by a separate source",
  })
  expect(update?.local_settings.models).toEqual(settings.local_settings.models)
  expect(update?.local_settings.ui.compact_navigation).toBe(true)
})

test("shows semantic validation before persistence", async ({ page }) => {
  let putCount = 0
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "PUT") putCount += 1
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(settings),
    })
  })

  await page.goto("/#token=invalid")
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByLabel("Display name").fill("   ")
  await page.getByRole("button", { name: "Save settings" }).click()

  await expect(page.getByLabel("Display name")).toHaveAttribute(
    "aria-invalid",
    "true"
  )
  await expect(page.getByText("Display name is required.")).toBeVisible()
  expect(putCount).toBe(0)
})

test("explains stale edits and removed fields", async ({ page }) => {
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(settings),
      })
      return
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        errors: [
          "Workspace settings changed after they were loaded; refresh and try again",
        ],
      }),
    })
  })

  await page.goto("/#token=stale")
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("button", { name: "Save settings" }).click()
  await expect(page.getByRole("alert")).toContainText("refresh and try again")

  await page.route("**/api/v1/settings", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        errors: [
          "settings.toml: removed field 'models.api_key'; use a Gateway Profile credential reference",
        ],
      }),
    })
  )
  await page.getByRole("button", { name: "Reload settings" }).click()
  await expect(page.getByRole("alert")).toContainText(
    "use a Gateway Profile credential reference"
  )
})

test("rejects malformed Settings responses", async ({ page }) => {
  await page.route("**/api/v1/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...settings,
        definition: {
          ...settings.definition,
          profile: { ...settings.definition.profile, priorities: [] },
        },
      }),
    })
  )

  await page.goto("/#token=malformed-settings")
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByRole("alert")).toContainText(
    "invalid Settings response"
  )
})
