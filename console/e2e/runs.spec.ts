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
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
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
  await expect(page.getByText("Analysis Task Planned")).toBeVisible()
  await expect(page.getByText("Gateway snapshot")).toBeVisible()
  await expect(page.getByText("Enterprise Gateway")).toBeVisible()
  await expect(
    page.getByRole("definition").filter({ hasText: "model-verifier" })
  ).toBeVisible()
  const completedTasks = page
    .getByText("Completed Analysis Tasks", { exact: true })
    .locator("xpath=../..")
  await expect(completedTasks.getByText("README.md")).toBeVisible()
  await expect(
    completedTasks.getByText("obligation-1", { exact: true })
  ).toBeVisible()
  await expect(completedTasks.getByText("Compact receipt")).toBeVisible()
  const coverage = page
    .getByText("Coverage obligations", { exact: true })
    .locator("xpath=../..")
  await expect(coverage.getByText("Assigned")).toBeVisible()
  await expect(coverage.getByText("Covered").first()).toBeVisible()
  await expect(page.getByText("Operational audit")).toBeVisible()
  await expect(page.getByText("1,250 ms")).toBeVisible()
  await expect(page.getByRole("cell", { name: "Planner" })).toBeVisible()
  await expect(page.getByText("browser-secret")).toHaveCount(0)
  await expect(page.getByText("hidden chain of thought")).toHaveCount(0)
  await expect(page.getByText("Unknown state")).toHaveCount(0)
  expect(detailRequests).toBeGreaterThanOrEqual(3)
  expect(consoleErrors).toEqual([])

  await page.screenshot({
    path: "test-results/runs-semantic-desktop.png",
    fullPage: true,
  })

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
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(overflow.width).toBe(overflow.viewport)
  const auditScroller = page
    .getByText("Operational audit", { exact: true })
    .locator("xpath=../..")
    .locator('[data-slot="table-container"]')
  expect(
    await auditScroller.evaluate(
      (element) => element.scrollWidth - element.clientWidth
    )
  ).toBeGreaterThan(0)
  await auditScroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth
  })
  await expect(
    auditScroller.getByRole("columnheader", { name: "Failures" })
  ).toBeVisible()
  await page.screenshot({
    path: "test-results/runs-mobile.png",
    fullPage: true,
  })
})

test("defaults verified Workspaces to Gateway Semantic and preserves explicit fixtures", async ({
  page,
}) => {
  const startedWith: unknown[] = []
  const startedRuns = new Map<string, unknown>()
  await mockShell(page)
  await page.route("**/api/v1/sources", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        configuration_digest: "configuration-1",
        retained_managed: [],
        sources: [source()],
      }),
    })
  })
  await page.route("**/api/v1/workspace/preflight", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        configuration_digest: "configuration-1",
        source_set_digest: "source-set-1",
        sources: [
          {
            id: "code",
            role: "implementation",
            revision_policy: "follow_branch",
            revision: "main",
            local_commit: "b".repeat(40),
            remote_commit: "b".repeat(40),
            exact_commit: "b".repeat(40),
            tree_digest: "c".repeat(64),
          },
        ],
      }),
    })
  })
  await page.route("**/api/v1/workspace/run-snapshot", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, models: models() }),
    })
  })
  await page.route("**/api/v1/runs", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>
      startedWith.push(payload)
      const runId = `run-started-${startedWith.length}`
      const fixture =
        payload.fixture === "success" || payload.fixture === "failure"
          ? payload.fixture
          : null
      const started = {
        ...detail("preparing"),
        run_id: runId,
        execution: fixture
          ? {
              mode: "deterministic_fixture",
              requested_outcome: fixture,
            }
          : { mode: "gateway_semantic" },
        models: fixture ? null : models(),
      }
      startedRuns.set(runId, started)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(started),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runs: [] }),
    })
  })
  await page.route("**/api/v1/runs/run-started-*", async (route) => {
    const runId = new URL(route.request().url()).pathname.split("/").at(-1)!
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(startedRuns.get(runId)),
    })
  })

  await page.goto("/?view=sources#token=sources-token")

  const preflight = page
    .getByText("Next Run Source Set", { exact: true })
    .locator("xpath=../..")
  await expect(preflight.getByText("Enterprise Gateway")).toBeVisible()
  await expect(
    preflight.getByRole("button", { name: "Gateway Semantic" })
  ).toHaveAttribute("aria-pressed", "true")

  await preflight.getByRole("button", { name: "Start Run" }).click()
  await expect
    .poll(() => startedWith[0])
    .toEqual({
      configuration_digest: "configuration-1",
      source_set_digest: "source-set-1",
    })

  await page.getByRole("button", { name: "Sources" }).click()
  await expect(
    preflight.getByRole("button", { name: "Gateway Semantic" })
  ).toHaveAttribute("aria-pressed", "true")

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    preflight.getByRole("button", { name: "Gateway Semantic" })
  ).toBeVisible()
  const sourceOverflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(sourceOverflow.width).toBe(sourceOverflow.viewport)
  await page.screenshot({
    path: "test-results/sources-semantic-mobile.png",
    fullPage: true,
  })

  await preflight.getByRole("button", { name: "Controlled Failure" }).click()
  await preflight.getByRole("button", { name: "Start Run" }).click()
  await expect
    .poll(() => startedWith[1])
    .toEqual({
      configuration_digest: "configuration-1",
      source_set_digest: "source-set-1",
      fixture: "failure",
    })
})

test("shows controlled semantic failures without exposing hidden input", async ({
  page,
}) => {
  await mockShell(page)
  const failed = {
    ...detail("failed"),
    actionable_errors: [
      "Gateway request timed out. Check the selected profile and retry.",
    ],
  }
  await page.route("**/api/v1/runs/run-active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(failed),
    })
  })
  await page.route("**/api/v1/runs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runs: [failed] }),
    })
  })

  await page.goto("/?view=runs&run=run-active#token=failed-token")

  await expect(page.getByRole("alert")).toContainText(
    "Gateway request timed out"
  )
  await expect(page.getByText("hidden chain of thought")).toHaveCount(0)
  await expect(page.getByText("browser-secret")).toHaveCount(0)
})

test("recovers and cancels from persisted operator controls", async ({
  page,
}) => {
  await mockShell(page)
  let current = {
    ...detail("exploring"),
    diagnostics: {
      ...detail("exploring").diagnostics,
      classification: "interrupted",
    },
    operations: {
      can_cancel: true,
      can_recover: true,
      recover_reason: null,
    },
  }
  const actions: string[] = []
  await page.route("**/api/v1/runs/run-active/*", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1)!
    actions.push(action)
    current =
      action === "recover"
        ? {
            ...detail("review_required"),
            diagnostics: {
              ...detail("review_required").diagnostics,
              review_blockers: ["Human approval is required"],
            },
          }
        : {
            ...detail("cancelled"),
            outcome: "cancelled",
          }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    })
  })
  await page.route("**/api/v1/runs/run-active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(current),
    })
  })
  await page.route("**/api/v1/runs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runs: [summary(current.state)] }),
    })
  })

  await page.goto("/?view=runs&run=run-active#token=operations-token")

  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Recover Run" }).click()
  await expect(page.getByText("Review blockers")).toBeVisible()
  await expect(page.getByText("Human approval is required")).toBeVisible()

  await page.getByRole("button", { name: "Cancel Run" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog.getByText("Cancel this Production Run?")).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel Run" }).click()
  await expect(
    page.getByText("Cancelled", { exact: true }).first()
  ).toBeVisible()
  expect(actions).toEqual(["recover", "cancel"])

  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(overflow.width).toBe(overflow.viewport)
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

test("uses authoritative legacy state when no phase event is available", async ({
  page,
}) => {
  await mockShell(page)
  const legacy = {
    ...detail("exploring"),
    execution: { mode: "legacy", requested_outcome: null },
    events: [],
  }
  await page.route("**/api/v1/runs/run-active", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(legacy),
    })
  })
  await page.route("**/api/v1/runs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, runs: [legacy] }),
    })
  })

  await page.goto("/?view=runs&run=run-active#token=legacy-token")

  await expect(page.locator('[aria-current="step"]')).toHaveText("Exploring")
})

async function mockShell(page: Page) {
  await page.route("**/api/v1/overview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overview),
    })
  })
  await page.route("**/api/v1/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        configuration_digest: "settings-1",
        definition: {
          schema_version: 1,
          project: { id: "catalog", name: "Catalog" },
          publication: { path: "published", bundle_name: null },
          sources: [],
          profile: {
            java_excluded_paths: null,
            priorities: {},
            dispositions: {},
          },
        },
        local_settings: {
          schema_version: 1,
          checkouts: {},
          managed_checkouts: {},
          models: {},
          ui: { compact_navigation: false },
        },
      }),
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
    execution: { mode: "gateway_semantic" },
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
  const terminal = ["published", "failed", "cancelled"].includes(state)
  const reviewBlocked = state === "review_required"
  return {
    ok: true,
    ...summary(state),
    project_id: "catalog",
    actionable_errors: [],
    audit: {
      failures: 0,
      latency_ms: 1250,
      models: ["model-planner", "model-worker", "model-verifier"],
      retries: 1,
      tokens: 450,
      tool_calls: 3,
      by_role_model: [
        {
          role: "planner",
          model: "model-planner",
          calls: 1,
          failures: 0,
          latency_ms: 250,
          retries: 0,
          tokens: 100,
          tool_calls: 0,
        },
        {
          role: "worker",
          model: "model-worker",
          calls: 1,
          failures: 0,
          latency_ms: 700,
          retries: 1,
          tokens: 250,
          tool_calls: 3,
        },
        {
          role: "verifier",
          model: "model-verifier",
          calls: 1,
          failures: 0,
          latency_ms: 300,
          retries: 0,
          tokens: 100,
          tool_calls: 0,
        },
      ],
    },
    diagnostics: {
      active_tasks: state === "exploring" ? 1 : 0,
      budgets: {
        replans: { remaining: 2, used: 0 },
        task_slots: { remaining: 3, used: state === "exploring" ? 1 : 0 },
      },
      classification: terminal
        ? "terminal"
        : reviewBlocked
          ? "review_blocked"
          : "active",
      failed_tasks: 0,
      review_blockers: [],
      staging: {
        exists: [
          "rendering",
          "checking",
          "review_required",
          "published",
        ].includes(state),
        path: "/workspace/.okf-wiki/runs/run-active/staging",
      },
      terminal_outcome: terminal ? state : null,
    },
    operations: {
      can_cancel: !terminal,
      can_recover: false,
      recover_reason: reviewBlocked
        ? "Production Run is waiting for review, not recovery"
        : terminal
          ? `${state} Production Runs are terminal`
          : "Run Worker is still active",
    },
    coverage_obligations: [
      {
        id: "obligation-1",
        priority: "major",
        disposition: "covered",
        source: "code",
        role: "implementation",
        state_changes: [
          {
            sequence: 21,
            previous_state: "open",
            state: "assigned",
            occurred_at: "2026-07-13T09:00:07Z",
            entity_type: "coverage_obligation",
            entity_id: "obligation-1",
          },
          {
            sequence: 22,
            previous_state: "assigned",
            state: "covered",
            occurred_at: "2026-07-13T09:00:08Z",
            entity_type: "coverage_obligation",
            entity_id: "obligation-1",
          },
        ],
      },
    ],
    events: all.slice(0, limit + 1).map((eventState, index) => ({
      sequence: index + 1,
      previous_state: index ? all[index - 1] : null,
      state: eventState,
      occurred_at: `2026-07-13T09:00:0${index}Z`,
    })),
    entity_events: [
      {
        sequence: 20,
        previous_state: null,
        state: "planned",
        occurred_at: "2026-07-13T09:00:06Z",
        entity_type: "analysis_task",
        entity_id: "task-fixture",
      },
    ],
    sources: [
      {
        id: "code",
        role: "implementation",
        revision: "b".repeat(40),
        tree_digest: "c".repeat(64),
      },
    ],
    models: {
      ...models(),
      credential: "browser-secret",
    },
    tasks: {
      active: [],
      completed: [
        {
          id: "task-fixture",
          state: "accepted",
          obligation_ids: ["obligation-1"],
          source_id: "code",
          path_scope: ["README.md"],
          agent_role: "extraction",
          budgets: { total_tokens_limit: 60000, tool_calls_limit: 20 },
          receipt: {
            accepted_ids: ["obligation-1"],
            unresolved_ids: [],
            warnings: [],
          },
          hidden_reasoning: "hidden chain of thought",
        },
      ],
      failed: [],
    },
  }
}

function models() {
  return {
    profile: {
      id: "enterprise",
      name: "Enterprise Gateway",
      gateway_id: "corp-openai",
      base_url: "http://127.0.0.1:8765/v1",
      header_names: ["X-Tenant"],
      revision: 3,
      registered: true,
    },
    default_model: "model-worker",
    assignments: {
      planner: "model-planner",
      worker: "model-worker",
      verifier: "model-verifier",
      renderer: "model-worker",
      query: "model-worker",
    },
    concurrency: 2,
    budgets: { total_tokens: 5000 },
    runtime_limits: { per_agent_call_total_tokens: 5000 },
    capabilities: {
      "model-planner": { structured_output: true },
      "model-worker": { tool_calling: true },
      "model-verifier": { structured_output: true },
    },
  }
}

function source() {
  return {
    id: "code",
    role: "implementation",
    revision: "main",
    revision_policy: "follow_branch",
    ownership: "linked",
    checkout: "/workspace/code",
    remote: null,
    branch: "main",
    commit: "b".repeat(40),
    local_commit: "b".repeat(40),
    remote_commit: null,
    dirty: false,
    ahead: null,
    behind: null,
    error: null,
  }
}
