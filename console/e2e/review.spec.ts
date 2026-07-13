import { expect, test, type Page } from "@playwright/test"

const claim = {
  id: "claim:catalog-security",
  statement: "Credential handling remains deterministic.",
  epistemic_status: "supported",
  evidence: [
    {
      id: "evidence:catalog-security",
      source_id: "code",
      revision: "a".repeat(40),
      path: "README.md",
      start_line: 3,
      end_line: 3,
      digest: `sha256:${"b".repeat(64)}`,
      evidence_kind: "source_span",
      authority: "source_snapshot",
    },
  ],
}

function review(digest = "c".repeat(64)) {
  const emptyChanges = {
    changed: [],
    removed: [],
    stale: [],
    disputed: [],
    merged: [],
    split: [],
    excluded: [],
  }
  return {
    ok: true,
    run_id: "run-review",
    project_id: "catalog",
    state: "review_required",
    source_set_digest: "d".repeat(64),
    authoritative_digest: digest,
    coverage: {
      total: 2,
      major: 1,
      supporting: 1,
      covered: 1,
      deferred: 1,
      excluded: 0,
      by_source: {
        code: { total: 2, dispositions: { covered: 1, deferred: 1 } },
      },
      by_role: {
        implementation: {
          total: 2,
          dispositions: { covered: 1, deferred: 1 },
        },
      },
      by_priority: {
        major: { total: 1, dispositions: { covered: 1 } },
        supporting: { total: 1, dispositions: { deferred: 1 } },
      },
    },
    coverage_obligations: [
      {
        id: "obligation:supporting",
        source: "code",
        role: "implementation",
        path: "README.md",
        kind: "table",
        priority: "supporting",
        disposition: "deferred",
        reason: "Low-value detail is deferred for the next Run.",
        span: { start_line: 5, end_line: 7 },
      },
    ],
    knowledge_changes: {
      claims: { added: [claim], ...emptyChanges },
      concepts: {
        added: [
          {
            id: "concept:catalog-security",
            canonical_name: "Catalog Security",
            description: "Credential handling rules.",
            status: "active",
            page: "concepts/catalog-security.md",
          },
        ],
        ...emptyChanges,
      },
    },
    verification_findings: [
      {
        candidate_id: "candidate:one",
        perspective: "evidence_entailment",
        severity: "info",
        verdict: "pass",
        blocking: false,
        rationale: "The fixed excerpt supports the Claim.",
        evidence: ["evidence:catalog-security"],
        evidence_reference_ids: ["evidence:catalog-security"],
      },
    ],
    evidence_references: claim.evidence,
    bundle_diff: {
      added: ["concepts/catalog-security.md"],
      changed: ["overview.md"],
      removed: [],
    },
  }
}

test("reviews evidence and Bundle changes, refreshes stale digest, and approves", async ({
  page,
}) => {
  const decisions: unknown[] = []
  let stale = true
  const errors: string[] = []
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("409 (Conflict)")
    )
      errors.push(message.text())
  })
  await mockShell(page)
  await page.route("**/api/v1/reviews/run-review", async (route) => {
    await json(route, review())
  })
  await page.route("**/api/v1/reviews/run-review/evidence/*", async (route) => {
    await json(route, {
      ok: true,
      ...claim.evidence[0],
      requested_end_line: 3,
      text: "Credential handling MUST remain deterministic.",
      truncated: false,
    })
  })
  await page.route("**/api/v1/reviews/run-review/bundle/*", async (route) => {
    await json(route, {
      ok: true,
      path: "concepts/catalog-security.md",
      status: "added",
      published: null,
      staged: "# Catalog Security\n\nGenerated from accepted Claims.",
    })
  })
  await page.route("**/api/v1/reviews/run-review/decision", async (route) => {
    decisions.push(route.request().postDataJSON())
    if (stale) {
      stale = false
      await json(
        route,
        {
          ok: false,
          errors: ["Review changed; refresh and decide against the new digest"],
          review: review("e".repeat(64)),
        },
        409
      )
      return
    }
    await json(route, {
      ok: true,
      decision: "approved",
      run_id: "run-review",
      state: "published",
    })
  })

  await page.goto("/?view=review&run=run-review#token=review-token")

  await expect(
    page.getByRole("heading", { level: 1, name: "Review & publish" })
  ).toBeVisible()
  await expect(page.getByTestId("review-digest")).toHaveText("c".repeat(64))
  await expect(page.getByText("Deferred 1").first()).toBeVisible()
  await page.getByRole("tab", { name: "Priority" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("cell", { name: "Major" })).toBeVisible()
  await expect(
    page.getByText("Credential handling remains deterministic.")
  ).toBeVisible()
  await expect(page.getByRole("textbox")).toHaveCount(0)

  await page
    .getByRole("button", { name: "Evidence README.md:3" })
    .first()
    .click()
  await expect(page.getByRole("dialog")).toContainText(
    "Credential handling MUST remain deterministic."
  )
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Severity" }).click()
  await expect(page.getByRole("heading", { name: "Info" })).toBeVisible()

  await page
    .getByRole("row", { name: /concepts\/catalog-security\.md Added/ })
    .getByRole("button", { name: "Details" })
    .click()
  await expect(page.getByRole("dialog")).toContainText(
    "Generated from accepted Claims."
  )
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Approve & publish" }).click()
  await page.getByRole("button", { name: "Confirm publication" }).click()
  await expect(page.getByRole("alert")).toContainText("refresh and decide")
  await expect(page.getByTestId("review-digest")).toHaveText("e".repeat(64))
  await expect(decisions[0]).toEqual({
    decision: "approve",
    expected_digest: "c".repeat(64),
  })

  await page.getByRole("button", { name: "Approve & publish" }).click()
  await page.getByRole("button", { name: "Confirm publication" }).click()
  await expect(page.getByRole("alert")).toContainText("published atomically")
  await expect(decisions[1]).toEqual({
    decision: "approve",
    expected_digest: "e".repeat(64),
  })
  expect(errors).toEqual([])

  await page.screenshot({
    path: "test-results/review-desktop.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(overflow.width).toBe(overflow.viewport)
  await page.screenshot({
    path: "test-results/review-mobile.png",
    fullPage: true,
  })
})

test("rejects a Review Required Run without exposing edit controls", async ({
  page,
}) => {
  await mockShell(page)
  await page.route("**/api/v1/reviews/run-review", async (route) => {
    await json(route, review())
  })
  await page.route("**/api/v1/reviews/run-review/decision", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      decision: "reject",
      expected_digest: "c".repeat(64),
    })
    await json(route, {
      ok: true,
      decision: "rejected",
      run_id: "run-review",
      state: "exploring",
    })
  })

  await page.goto("/?view=review&run=run-review#token=review-token")
  await page.getByRole("button", { name: "Reject changes" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Confirm rejection" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("alert")).toContainText("returned to Exploring")
  await expect(page.getByRole("textbox")).toHaveCount(0)
})

async function mockShell(page: Page) {
  await page.route("**/api/v1/overview", async (route) => {
    await json(route, {
      ok: true,
      project: { id: "catalog", name: "Catalog" },
      source_count: 1,
      latest_bundle: null,
      active_run: {
        run_id: "run-review",
        state: "review_required",
        updated_at: "2026-07-13T09:00:00Z",
      },
      blockers: [],
      next_actions: ["review_run"],
    })
  })
  await page.route("**/api/v1/settings", async (route) => {
    await json(route, {
      ok: true,
      local_settings: { ui: { compact_navigation: false } },
    })
  })
}

async function json(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: unknown,
  status = 200
) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  })
}
