import { expect, test, type Page } from "@playwright/test"

const overview = {
  ok: true,
  project: { id: "catalog", name: "Catalog" },
  source_count: 1,
  latest_bundle: {
    run_id: "run-old",
    state: "published",
    updated_at: "2026-07-12T00:00:00Z",
    path: "published",
  },
  active_run: {
    run_id: "run-new",
    state: "review_required",
    updated_at: "2026-07-13T00:00:00Z",
  },
  blockers: [],
  next_actions: ["review_run"],
}

const identity = {
  kind: "staged",
  run_id: "run-new",
  source_set_digest: "source-set-new",
  state: "review_required",
}

const diffOptions = [
  {
    base: "previous",
    base_run_id: "run-older",
    target: "published",
    target_run_id: "run-old",
  },
  {
    base: "published",
    base_run_id: "run-old",
    target: "staged",
    target_run_id: "run-new",
  },
  {
    base: "previous",
    base_run_id: "run-old",
    target: "staged",
    target_run_id: "run-new",
  },
]

const source = `---
type: Guide
title: Safe reader
tags:
  - security
---

# Safe reader

<script>window.pwned = true</script>
`

const blocks = [
  {
    type: "heading",
    level: 1,
    id: "safe-reader",
    children: [{ type: "text", text: "Safe reader" }],
  },
  {
    type: "paragraph",
    children: [
      { type: "text", text: "Read the " },
      {
        type: "link",
        href: "details.md",
        external: false,
        page: "details.md",
        fragment: null,
        children: [{ type: "text", text: "details" }],
      },
      { type: "text", text: " and " },
      { type: "math", source: "x^2" },
      { type: "text", text: ". Jump to " },
      {
        type: "link",
        href: "#safe-reader",
        external: false,
        page: "guide.md",
        fragment: "safe-reader",
        children: [{ type: "text", text: "the heading" }],
      },
      { type: "text", text: "." },
    ],
  },
  {
    type: "list",
    ordered: false,
    start: 1,
    items: [
      {
        checked: true,
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text: "CommonMark task" }],
          },
        ],
      },
    ],
  },
  {
    type: "table",
    headers: [[{ type: "text", text: "Policy" }]],
    rows: [[[{ type: "text", text: "Strict CSP" }]]],
  },
  {
    type: "code",
    language: "python",
    source: "print('safe')\n",
    segments: [
      { kind: "name", text: "print" },
      { kind: "text", text: "(" },
      { kind: "string", text: "'safe'" },
      { kind: "text", text: ")\n" },
    ],
  },
  {
    type: "mermaid",
    direction: "LR",
    source: "flowchart LR\nA[Source] --> B[Claim]",
    error: null,
    nodes: [
      { id: "A", label: "Source" },
      { id: "B", label: "Claim" },
    ],
    edges: [{ from: "A", to: "B", label: null }],
  },
  { type: "claim", claim_id: `claim:${"a".repeat(64)}` },
  {
    type: "list",
    ordered: false,
    start: 1,
    items: [
      {
        checked: null,
        children: [
          {
            type: "paragraph",
            children: [
              { type: "claim", claim_id: `claim:${"a".repeat(64)}` },
              { type: "text", text: " — " },
              { type: "code", text: "repo://docs@revision/README.md#L1-L1" },
            ],
          },
        ],
      },
    ],
  },
]

test.beforeEach(async ({ page, context }) => {
  await context.addInitScript(() => sessionStorage.clear())
  await page.route("**/api/v1/overview", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overview),
    })
  )
  await page.route("**/api/v1/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        configuration_digest: "config",
        definition: {
          schema_version: 1,
          project: overview.project,
          publication: { path: "published", bundle_name: null },
          sources: [],
          profile: { priorities: {}, dispositions: {} },
        },
        local_settings: {
          schema_version: 1,
          checkouts: {},
          managed_checkouts: {},
          models: {
            gateway_profile: null,
            default_model: null,
            role_overrides: {},
            concurrency: 4,
            budgets: {},
          },
          ui: { compact_navigation: false },
        },
      }),
    })
  )
  await mockKnowledge(page)
})

test("renders and navigates the Bundle without executing generated content", async ({
  page,
}) => {
  const externalRequests: string[] = []
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1")
      externalRequests.push(request.url())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  await page.goto("/#token=knowledge")
  await page.getByRole("button", { name: "Knowledge" }).click()

  await expect(
    page.getByRole("heading", { level: 1, name: "Knowledge" })
  ).toBeVisible()
  await expect(page.getByText("Run run-new")).toBeVisible()
  await expect(page.getByText(/Source Set source-set/)).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Safe reader", exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: "Completed task" })
  ).toBeChecked()
  await expect(page.getByRole("cell", { name: "Strict CSP" })).toBeVisible()
  await expect(page.getByText("print", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("img", {
      name: "Mermaid flowchart. Nodes: Source, Claim. Relations: Source → Claim.",
    })
  ).toContainText("Source")
  await expect(page.getByLabel("Mathematical notation: x^2")).toContainText(
    "x2"
  )
  await expect(page.getByRole("alert")).toContainText("Raw HTML was omitted.")
  await expect(page.getByRole("alert")).toContainText(
    "Broken internal link: missing.md"
  )
  await expect(
    page.locator("script").filter({ hasText: "window.pwned" })
  ).toHaveCount(0)
  await expect(page.locator("iframe")).toHaveCount(0)
  expect(
    await page.evaluate(() => (window as Window & { pwned?: boolean }).pwned)
  ).toBeUndefined()
  await page.getByRole("link", { name: "the heading" }).click()
  await expect(page.locator("#safe-reader")).toBeFocused()

  await page.getByRole("link", { name: "details" }).click()
  await expect(
    page.getByRole("heading", { name: "Details" }).first()
  ).toBeVisible()
  await page.getByRole("button", { name: "Safe reader" }).click()

  await page.getByLabel("Search Knowledge Bundle").fill("strict")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Search results" })
  ).toContainText("Strict CSP")

  await page.getByRole("button", { name: "View accepted Claim" }).click()
  await expect(page.getByRole("dialog")).toContainText(
    "Credentials stay outside the Workspace."
  )
  await expect(page.getByRole("dialog")).toContainText("README.md#L1-L1")
  await page.getByRole("button", { name: "Close" }).click()
  await page.getByRole("button", { name: "Claim aaaaaaaa" }).click()
  await expect(page.getByRole("dialog")).toContainText(
    "Credentials stay outside the Workspace."
  )
  await page.getByRole("button", { name: "Close" }).click()

  await page.getByRole("button", { name: "Source", exact: true }).click()
  await expect(page.getByLabel("Generated Markdown source")).toContainText(
    "<script>window.pwned"
  )
  await page.getByRole("button", { name: "Diff", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Published → Staged" })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("table", { name: "unified page diff" })
  ).toContainText("Old text")
  await page.getByRole("button", { name: "Previous → Staged" }).click()
  await expect(page.getByText("Run run-old → Run run-new")).toBeVisible()
  await page.getByRole("button", { name: "Split" }).click()
  await expect(
    page.getByRole("table", { name: "split page diff" })
  ).toBeVisible()

  await page.getByRole("button", { name: "Published", exact: true }).click()
  await expect(page.getByText("Run run-old", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Published guide" })
  ).toBeVisible()
  await page.screenshot({
    path: "test-results/knowledge-desktop.png",
    fullPage: true,
  })

  expect(externalRequests).toEqual([])
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test("keeps reader controls usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/?view=knowledge#token=mobile-knowledge")

  await expect(
    page.getByRole("heading", { level: 1, name: "Knowledge" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Source", exact: true }).focus()
  await expect(
    page.getByRole("button", { name: "Source", exact: true })
  ).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByLabel("Generated Markdown source")).toBeVisible()
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(overflow.width).toBe(overflow.viewport)
  await page.screenshot({
    path: "test-results/knowledge-mobile.png",
    fullPage: true,
  })
})

test("turns malformed and missing reader responses into retryable errors", async ({
  page,
}) => {
  let validSnapshot = false
  let pageAttempts = 0
  await page.unroute("**/api/v1/knowledge?*")
  await page.route("**/api/v1/knowledge*", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/v1/knowledge")
      return route.fallback()
    if (validSnapshot) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshotPayload(false)),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, bundles: [] }),
    })
  })
  await page.route("**/api/v1/knowledge/page?*", async (route) => {
    if (pageAttempts++ > 0) return route.fallback()
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        errors: ["Bundle page does not exist: guide.md"],
      }),
    })
  })

  await page.goto("/?view=knowledge#token=retry-reader")
  await expect(
    page.getByText("invalid Knowledge navigation response")
  ).toBeVisible()
  validSnapshot = true
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(
    page.getByText("Bundle page does not exist: guide.md")
  ).toBeVisible()
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(
    page.getByRole("heading", { name: "Safe reader", exact: true }).first()
  ).toBeVisible()
  await expect(page.getByLabel("Loading Knowledge page")).toHaveCount(0)
})

test("clears the old page and Claim while a new snapshot is loading", async ({
  page,
}) => {
  let releaseSnapshot = () => undefined
  const snapshotPending = new Promise<void>((resolve) => {
    releaseSnapshot = resolve
  })
  let releaseClaim = () => undefined
  const claimPending = new Promise<void>((resolve) => {
    releaseClaim = resolve
  })
  await page.unroute("**/api/v1/knowledge?*")
  await page.route("**/api/v1/knowledge?*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== "/api/v1/knowledge") return route.fallback()
    const published = url.searchParams.get("bundle") === "published"
    if (published) await snapshotPending
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshotPayload(published)),
    })
  })
  await page.unroute("**/api/v1/knowledge/claims/*")
  await page.route("**/api/v1/knowledge/claims/*", async (route) => {
    await claimPending
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(claimPayload()),
    }).catch(() => undefined)
  })

  await page.goto("/?view=knowledge#token=identity-race")
  await expect(
    page.getByRole("heading", { name: "Safe reader", exact: true }).first()
  ).toBeVisible()
  await page.getByRole("button", { name: "View accepted Claim" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Close" }).click()

  await page.getByRole("button", { name: "Published", exact: true }).click()
  await expect(page.getByLabel("Loading Knowledge Bundle")).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Safe reader", exact: true })
  ).toHaveCount(0)

  releaseClaim()
  releaseSnapshot()
  await expect(
    page.getByRole("heading", { name: "Published guide" }).first()
  ).toBeVisible()
})

test("drops a search response from the previous snapshot", async ({ page }) => {
  let searchStarted = () => undefined
  const started = new Promise<void>((resolve) => {
    searchStarted = resolve
  })
  let releaseSearch = () => undefined
  const searchPending = new Promise<void>((resolve) => {
    releaseSearch = resolve
  })
  await page.unroute("**/api/v1/knowledge/search?*")
  await page.route("**/api/v1/knowledge/search?*", async (route) => {
    searchStarted()
    await searchPending
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        results: [
          { path: "guide.md", title: "Old search", excerpt: "stale-result" },
        ],
      }),
    }).catch(() => undefined)
  })

  await page.goto("/?view=knowledge#token=search-race")
  await page.getByLabel("Search Knowledge Bundle").fill("stale")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await started
  await page.getByRole("button", { name: "Published", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Published guide" }).first()
  ).toBeVisible()
  releaseSearch()
  await expect(page.getByText("stale-result")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Search results" })).toHaveCount(0)
})

test("rejects page, diff, and Claim responses for another requested identity", async ({
  page,
}) => {
  let firstPage = true
  await page.route("**/api/v1/knowledge/page?*", async (route) => {
    if (!firstPage) return route.fallback()
    firstPage = false
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        ...identity,
        path: "other.md",
        title: "Other page",
        source,
        metadata: {},
        blocks,
        outline: [],
        backlinks: [],
        diagnostics: [],
      }),
    })
  })
  await page.route("**/api/v1/knowledge/diff?*", (route) => {
    const payload = diffPayload(new URL(route.request().url()))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...payload, path: "other.md" }),
    })
  })
  await page.route("**/api/v1/knowledge/claims/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...claimPayload(),
        id: `claim:${"f".repeat(64)}`,
      }),
    })
  )

  await page.goto("/?view=knowledge#token=response-identity")
  await expect(page.getByText("invalid Knowledge page response")).toBeVisible()
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(
    page.getByRole("heading", { name: "Safe reader", exact: true }).first()
  ).toBeVisible()

  await page.getByRole("button", { name: "Diff", exact: true }).click()
  await expect(page.getByText("invalid Knowledge diff response")).toBeVisible()
  await page.getByRole("button", { name: "Rendered" }).click()
  await page.getByRole("button", { name: "View accepted Claim" }).click()
  await expect(page.getByRole("dialog")).toContainText(
    "invalid Accepted Claim response"
  )
})

async function mockKnowledge(page: Page) {
  await page.route("**/api/v1/knowledge?*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== "/api/v1/knowledge") return route.fallback()
    const published = url.searchParams.get("bundle") === "published"
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshotPayload(published)),
    })
  })
  await page.route("**/api/v1/knowledge/page?*", async (route) => {
    const url = new URL(route.request().url())
    const published = url.searchParams.get("bundle") === "published"
    expect(url.searchParams.get("run_id")).toBe(
      published ? "run-old" : "run-new"
    )
    const path = url.searchParams.get("path")
    const details = path === "details.md"
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        ...(published
          ? {
              kind: "published",
              run_id: "run-old",
              source_set_digest: "source-set-old",
              state: "published",
            }
          : identity),
        path,
        title: details
          ? "Details"
          : published
            ? "Published guide"
            : "Safe reader",
        source: published ? "# Published guide\n\nOld text.\n" : source,
        metadata: published
          ? {}
          : { type: "Guide", title: "Safe reader", tags: ["security"] },
        blocks: details
          ? [
              {
                type: "heading",
                level: 1,
                id: "details",
                children: [{ type: "text", text: "Details" }],
              },
            ]
          : published
            ? [
                {
                  type: "heading",
                  level: 1,
                  id: "published-guide",
                  children: [{ type: "text", text: "Published guide" }],
                },
              ]
            : blocks,
        outline: details
          ? [{ level: 1, text: "Details", id: "details" }]
          : [
              {
                level: 1,
                text: published ? "Published guide" : "Safe reader",
                id: published ? "published-guide" : "safe-reader",
              },
            ],
        backlinks: details ? ["guide.md"] : [],
        diagnostics:
          published || details
            ? []
            : ["Raw HTML was omitted.", "Broken internal link: missing.md"],
      }),
    })
  })
  await page.route("**/api/v1/knowledge/search?*", (route) => {
    expect(new URL(route.request().url()).searchParams.get("run_id")).toBe(
      "run-new"
    )
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        results: [
          { path: "guide.md", title: "Safe reader", excerpt: "Strict CSP" },
        ],
      }),
    })
  })
  await page.route("**/api/v1/knowledge/diff?*", (route) => {
    const url = new URL(route.request().url())
    const option = diffOptions.find(
      (item) =>
        item.base === url.searchParams.get("base") &&
        item.target === url.searchParams.get("target")
    )
    expect(url.searchParams.get("base_run_id")).toBe(option?.base_run_id)
    expect(url.searchParams.get("target_run_id")).toBe(option?.target_run_id)
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(diffPayload(url)),
    })
  })
  await page.route("**/api/v1/knowledge/claims/*", (route) => {
    expect(new URL(route.request().url()).searchParams.get("run_id")).toBe(
      "run-new"
    )
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(claimPayload()),
    })
  })
}

function snapshotPayload(published: boolean) {
  return {
    ok: true,
    bundles: [
      identity,
      {
        kind: "published",
        run_id: "run-old",
        source_set_digest: "source-set-old",
        state: "published",
      },
    ],
    selected: published
      ? {
          kind: "published",
          run_id: "run-old",
          source_set_digest: "source-set-old",
          state: "published",
        }
      : identity,
    default_page: "guide.md",
    diff_options: diffOptions,
    pages: [
      {
        path: "guide.md",
        title: published ? "Published guide" : "Safe reader",
        backlinks: [],
      },
      { path: "details.md", title: "Details", backlinks: ["guide.md"] },
    ],
  }
}

function diffPayload(url: URL) {
  const base = url.searchParams.get("base")
  const baseRunId = url.searchParams.get("base_run_id")
  const target = url.searchParams.get("target")
  return {
    ok: true,
    path: "guide.md",
    page_change: "changed",
    base: {
      kind: base,
      run_id: baseRunId,
      source_set_digest:
        baseRunId === "run-older" ? "source-set-older" : "source-set-old",
      state: "published",
    },
    target:
      target === "published"
        ? {
            kind: "published",
            run_id: "run-old",
            source_set_digest: "source-set-old",
            state: "published",
          }
        : identity,
    lines: [
      {
        kind: "changed",
        left: "Old text",
        left_number: 1,
        right: "Safe reader",
        right_number: 1,
      },
      {
        kind: "added",
        left: null,
        left_number: null,
        right: "Strict CSP",
        right_number: 2,
      },
    ],
  }
}

function claimPayload() {
  return {
    ok: true,
    id: `claim:${"a".repeat(64)}`,
    subject: "Gateway",
    predicate: "stores credentials",
    statement: "Credentials stay outside the Workspace.",
    modality: "asserted",
    conditions: [],
    epistemic_status: "supported",
    conflicts_with: [],
    supersedes: [],
    evidence: [
      {
        id: `evidence:${"b".repeat(64)}`,
        source_id: "docs",
        revision: "1".repeat(40),
        path: "README.md",
        start_line: 1,
        end_line: 1,
        digest: `sha256:${"c".repeat(64)}`,
        evidence_kind: "source_span",
        authority: "authoritative",
        excerpt: "Credentials stay outside the Workspace.",
        error: null,
      },
    ],
  }
}
