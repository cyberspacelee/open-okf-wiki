import { expect, test, type Page } from "@playwright/test"

const runId = "run-new"
const digest = "source-set-new"
const conceptId = `concept:${"c".repeat(64)}`
const claimId = `claim:${"a".repeat(64)}`
const evidenceId = `evidence:${"b".repeat(64)}`

test.beforeEach(async ({ page }) => {
  await mockWorkspace(page, conceptId)
})

test("asks both fixed scopes, shows exact citations, and clears the session on reload", async ({
  page,
}) => {
  const requests: Array<Record<string, unknown>> = []
  await page.route("**/api/v1/knowledge/query", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    requests.push(body)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(answer(String(body.scope))),
    })
  })

  await page.goto("/?view=knowledge#token=query")
  await page.getByRole("button", { name: "Ask accepted knowledge" }).click()

  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("button", { name: "Current page" })
  ).toHaveAttribute("aria-pressed", "true")
  await dialog.getByLabel("Ask a question").fill("How are answers grounded?")
  await dialog.getByRole("button", { name: "Ask", exact: true }).click()

  await expect(
    dialog.getByText("Accepted answers use exact evidence.")
  ).toBeVisible()
  await expect(dialog.getByText(claimId, { exact: true })).toBeVisible()
  await expect(dialog.getByText(evidenceId, { exact: true })).toBeVisible()
  await expect(dialog.getByText("query-model", { exact: true })).toBeVisible()
  await expect(dialog.getByText(`Run ${runId}`, { exact: true })).toBeVisible()
  await expect(
    dialog.getByText(`Source Set ${digest}`, { exact: true })
  ).toBeVisible()
  await expect(dialog.getByText(/Query content is not persisted/)).toBeVisible()
  expect(requests[0]).toEqual({
    question: "How are answers grounded?",
    bundle: "staged",
    run_id: runId,
    source_set_digest: digest,
    scope: "concept",
    page: "concepts/query.md",
  })

  await dialog.getByRole("button", { name: "Complete bundle" }).click()
  await dialog
    .getByLabel("Ask a question")
    .fill("Can a query mutate knowledge?")
  await dialog.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(
    dialog.getByText("Complete bundle", { exact: true }).last()
  ).toBeVisible()
  expect(requests[1]).toEqual({
    question: "Can a query mutate knowledge?",
    bundle: "staged",
    run_id: runId,
    source_set_digest: digest,
    scope: "bundle",
  })

  await page.reload()
  await page.getByRole("button", { name: "Ask accepted knowledge" }).click()
  await expect(
    page.getByRole("dialog").getByText("Grounded answers only")
  ).toBeVisible()
  await expect(page.getByText("How are answers grounded?")).toHaveCount(0)
  await expect(page.getByText("Can a query mutate knowledge?")).toHaveCount(0)
})

test("defaults non-Concept pages to complete Bundle scope", async ({
  page,
}) => {
  await page.unroute("**/api/v1/knowledge?*")
  await page.unroute("**/api/v1/knowledge/page?*")
  await mockKnowledgeSnapshot(page, null)
  await mockKnowledgePage(page, null, "index.md")
  let request: Record<string, unknown> | undefined
  await page.route("**/api/v1/knowledge/query", async (route) => {
    request = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(answer("bundle")),
    })
  })

  await page.goto("/?view=knowledge&page=index.md#token=index-query")
  await page.getByRole("button", { name: "Ask accepted knowledge" }).click()
  const dialog = page.getByRole("dialog")

  await expect(
    dialog.getByRole("button", { name: "Current page" })
  ).toBeDisabled()
  await expect(
    dialog.getByRole("button", { name: "Complete bundle" })
  ).toHaveAttribute("aria-pressed", "true")
  await dialog.getByLabel("Ask a question").fill("What is accepted?")
  await dialog.getByRole("button", { name: "Ask", exact: true }).click()
  await expect(
    dialog.getByText("Accepted answers use exact evidence.")
  ).toBeVisible()
  expect(request).toEqual({
    question: "What is accepted?",
    bundle: "staged",
    run_id: runId,
    source_set_digest: digest,
    scope: "bundle",
  })
})

test("shows insufficient support without inventing citations", async ({
  page,
}) => {
  await page.route("**/api/v1/knowledge/query", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...answer("concept"),
        outcome: "insufficient_support",
        segments: [
          {
            kind: "insufficient_support",
            text: "The accepted Knowledge Bundle has insufficient support for this question.",
            claim_ids: [],
            evidence_ids: [],
            citations: [],
          },
        ],
      }),
    })
  )

  await page.goto("/?view=knowledge#token=unsupported-query")
  await page.getByRole("button", { name: "Ask accepted knowledge" }).click()
  const dialog = page.getByRole("dialog")
  await dialog
    .getByLabel("Ask a question")
    .fill("What does the Bundle not establish?")
  await dialog.getByRole("button", { name: "Ask", exact: true }).click()

  await expect(
    dialog.getByText(
      "The accepted Knowledge Bundle has insufficient support for this question."
    )
  ).toBeVisible()
  await expect(dialog.getByText(claimId, { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(evidenceId, { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(/^Claim /)).toHaveCount(0)
  await expect(dialog.getByText(/^Evidence /)).toHaveCount(0)
})

test("rejects malformed Query Agent responses at the browser boundary", async ({
  page,
}) => {
  const malformed = [
    { source_set_digest: "wrong-digest" },
    {
      segments: [
        {
          ...answer("concept").segments[0],
          claim_ids: ["claim:invalid"],
        },
      ],
    },
    {
      segments: [
        {
          ...answer("concept").segments[0],
          claim_ids: [claimId, claimId],
        },
      ],
    },
    {
      segments: Array.from({ length: 9 }, () => answer("concept").segments[0]),
    },
    {
      usage: {
        requests: 1,
        tool_calls: 2,
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 31,
      },
    },
    {
      segments: [
        {
          ...answer("concept").segments[0],
          citations: [
            {
              ...answer("concept").segments[0].citations[0],
              evidence: [
                {
                  ...answer("concept").segments[0].citations[0].evidence[0],
                  path: "../secret",
                },
              ],
            },
          ],
        },
      ],
    },
    { scope: "bundle", concept_id: null },
  ]
  let response = 0
  await page.route("**/api/v1/knowledge/query", async (route) => {
    const mutation = malformed[response++]
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...answer("concept"), ...mutation }),
    })
  })

  await page.goto("/?view=knowledge#token=malformed-query")
  await page.getByRole("button", { name: "Ask accepted knowledge" }).click()
  const dialog = page.getByRole("dialog")
  for (let index = 0; index < malformed.length; index += 1) {
    await dialog.getByLabel("Ask a question").fill(`Question ${index}`)
    await dialog.getByRole("button", { name: "Ask", exact: true }).click()
    await expect(
      dialog.getByText("invalid Knowledge Query response", { exact: false })
    ).toHaveCount(index + 1)
  }
})

function answer(scope: string) {
  return {
    ok: true,
    query_id: "4".repeat(32),
    outcome: "answered",
    run_id: runId,
    source_set_digest: digest,
    model: "query-model",
    scope,
    concept_id: scope === "concept" ? conceptId : null,
    segments: [
      {
        kind: "fact",
        text: "Accepted answers use exact evidence.",
        claim_ids: [claimId],
        evidence_ids: [evidenceId],
        citations: [
          {
            claim_id: claimId,
            evidence: [
              {
                id: evidenceId,
                source_id: "docs",
                revision: "1".repeat(40),
                path: "README.md",
                start_line: 1,
                end_line: 1,
              },
            ],
          },
        ],
      },
    ],
    usage: {
      requests: 3,
      tool_calls: 2,
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
    },
    latency_ms: 25,
    error: null,
    data_egress:
      "The question and exact Evidence are sent to the selected Gateway Profile. Query content is not persisted.",
  }
}

async function mockWorkspace(page: Page, pageConceptId: string | null) {
  await page.route("**/api/v1/overview", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        project: { id: "catalog", name: "Catalog" },
        source_count: 1,
        latest_bundle: null,
        active_run: null,
        blockers: [],
        next_actions: [],
      }),
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
          project: { id: "catalog", name: "Catalog" },
          publication: { path: "published", bundle_name: null },
          sources: [],
          profile: { priorities: {}, dispositions: {} },
        },
        local_settings: {
          schema_version: 1,
          checkouts: {},
          managed_checkouts: {},
          models: {
            gateway_profile: "query",
            default_model: "query-model",
            role_overrides: { query: "query-model" },
            concurrency: 1,
            budgets: {},
          },
          ui: { compact_navigation: false },
        },
      }),
    })
  )
  await mockKnowledgeSnapshot(page, pageConceptId)
  await mockKnowledgePage(
    page,
    pageConceptId,
    pageConceptId ? "concepts/query.md" : "index.md"
  )
}

async function mockKnowledgeSnapshot(page: Page, pageConceptId: string | null) {
  await page.route("**/api/v1/knowledge?*", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/v1/knowledge")
      return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        bundles: [
          {
            kind: "staged",
            run_id: runId,
            source_set_digest: digest,
            state: "review_required",
          },
        ],
        selected: {
          kind: "staged",
          run_id: runId,
          source_set_digest: digest,
          state: "review_required",
        },
        default_page: pageConceptId ? "concepts/query.md" : "index.md",
        diff_options: [],
        pages: [
          {
            path: pageConceptId ? "concepts/query.md" : "index.md",
            title: pageConceptId ? "Query Agent" : "Index",
            backlinks: [],
          },
        ],
      }),
    })
  })
}

async function mockKnowledgePage(
  page: Page,
  pageConceptId: string | null,
  path: string
) {
  await page.route("**/api/v1/knowledge/page?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        kind: "staged",
        run_id: runId,
        source_set_digest: digest,
        state: "review_required",
        path,
        title: pageConceptId ? "Query Agent" : "Index",
        concept_id: pageConceptId,
        source: pageConceptId ? "# Query Agent\n" : "# Index\n",
        metadata: {},
        blocks: [
          {
            type: "heading",
            level: 1,
            id: pageConceptId ? "query-agent" : "index",
            children: [
              { type: "text", text: pageConceptId ? "Query Agent" : "Index" },
            ],
          },
        ],
        outline: [
          {
            level: 1,
            text: pageConceptId ? "Query Agent" : "Index",
            id: pageConceptId ? "query-agent" : "index",
          },
        ],
        backlinks: [],
        diagnostics: [],
      }),
    })
  )
}
