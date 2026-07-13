import { expect, test, type Page } from "@playwright/test"

const EVIDENCE = `evidence:${"a".repeat(64)}`
const CLAIM = `claim:${"b".repeat(64)}`
const STABLE_CLAIM = `claim:${"c".repeat(64)}`
const CONCEPT = `concept:${"d".repeat(64)}`
const STABLE_CONCEPT = `concept:${"e".repeat(64)}`
const TARGET_CONCEPT = `concept:${"f".repeat(64)}`

const overview = {
  ok: true,
  project: { id: "catalog", name: "Catalog Platform" },
  source_count: 1,
  latest_bundle: null,
  active_run: null,
  blockers: [],
  next_actions: [],
}

const events = [
  replayEvent(
    1,
    "proposed",
    "verification_candidate",
    "candidate-1",
    null,
    "staged",
    "candidate-1"
  ),
  replayEvent(
    2,
    "verified",
    "verification_candidate",
    "candidate-1",
    "staged",
    "accepted",
    "candidate-1"
  ),
  replayEvent(3, "accepted", "claim", CLAIM, null, "supported", "candidate-1"),
  replayEvent(4, "accepted", "concept", CONCEPT, null, "active", "candidate-1"),
  replayEvent(
    5,
    "rejected",
    "verification_candidate",
    "candidate-2",
    "staged",
    "rejected",
    "candidate-2"
  ),
  replayEvent(6, "stale", "claim", CLAIM, "supported", "stale"),
  replayEvent(
    7,
    "published",
    "production_run",
    "run-1",
    "publishing",
    "published"
  ),
]

const oldUnit = impactUnit("file:changed", "a".repeat(40), "old.md", "1")
const newUnit = impactUnit("file:changed", "b".repeat(40), "old.md", "2")
const movedBefore = impactUnit("file:moved", "a".repeat(40), "before.md", "3")
const movedAfter = impactUnit("file:moved-new", "b".repeat(40), "after.md", "3")
const addedUnit = impactUnit("file:added", "b".repeat(40), "added.md", "4")
const removedUnit = impactUnit(
  "file:removed",
  "a".repeat(40),
  "removed.md",
  "5"
)

const replay = {
  ok: true,
  run_id: "run-1",
  run_state: "published",
  lineage_run_ids: ["run-base", "run-1"],
  events,
  located_event_sequence: null,
  event_bounds: {
    limit: 50,
    offset: 0,
    previous_offset: null,
    next_offset: null,
    total: events.length,
    truncated: false,
  },
  impact: {
    mode: "incremental",
    fallback_reason: null,
    summary: {
      changes: { added: 1, changed: 1, moved: 1, removed: 1 },
      affected: { evidence: 1, claims: 1, concepts: 1, pages: 1 },
      stable: { evidence: 0, claims: 1, concepts: 1, pages: 1 },
    },
    nodes: [
      impactNode(
        "source-unit:changed:file:changed",
        "file:changed",
        "source_unit",
        "old.md",
        "changed",
        oldUnit,
        newUnit
      ),
      impactNode(
        "source-unit:moved:file:moved-new",
        "file:moved-new",
        "source_unit",
        "after.md",
        "moved",
        movedBefore,
        movedAfter
      ),
      impactNode(
        "source-unit:added:file:added",
        "file:added",
        "source_unit",
        "added.md",
        "added",
        null,
        addedUnit
      ),
      impactNode(
        "source-unit:removed:file:removed",
        "file:removed",
        "source_unit",
        "removed.md",
        "removed",
        removedUnit,
        null
      ),
      impactNode(EVIDENCE, EVIDENCE, "evidence", "old.md:3-4", "affected"),
      impactNode(
        CLAIM,
        CLAIM,
        "claim",
        "A Workspace represents one product.",
        "affected"
      ),
      impactNode(CONCEPT, CONCEPT, "concept", "Workspace", "affected"),
      impactNode(
        "page:concepts/workspace.md",
        "concepts/workspace.md",
        "page",
        "Workspace",
        "affected"
      ),
      impactNode(
        STABLE_CLAIM,
        STABLE_CLAIM,
        "claim",
        "The API remains stable.",
        "stable"
      ),
      impactNode(
        STABLE_CONCEPT,
        STABLE_CONCEPT,
        "concept",
        "Stable API",
        "stable"
      ),
      impactNode(
        "page:concepts/stable-api.md",
        "concepts/stable-api.md",
        "page",
        "Stable API",
        "stable"
      ),
    ],
    edges: [
      impactEdge("source-unit:changed:file:changed", "contains", EVIDENCE),
      impactEdge(EVIDENCE, "grounds", CLAIM),
      impactEdge(CLAIM, "forms", CONCEPT),
      impactEdge(CONCEPT, "renders", "page:concepts/workspace.md"),
    ],
    paths: [
      {
        id: [
          "source-unit:changed:file:changed",
          EVIDENCE,
          CLAIM,
          CONCEPT,
          "page:concepts/workspace.md",
        ].join("|"),
        source: impactPathItem(
          "source-unit:changed:file:changed",
          "file:changed",
          "source_unit",
          "old.md"
        ),
        evidence: impactPathItem(EVIDENCE, EVIDENCE, "evidence", "old.md:3-4"),
        claim: impactPathItem(
          CLAIM,
          CLAIM,
          "claim",
          "A Workspace represents one product."
        ),
        concept: impactPathItem(CONCEPT, CONCEPT, "concept", "Workspace"),
        page: impactPathItem(
          "page:concepts/workspace.md",
          "concepts/workspace.md",
          "page",
          "Workspace"
        ),
      },
    ],
    path_bounds: {
      limit: 50,
      offset: 0,
      previous_offset: null,
      next_offset: null,
      total: 1,
      truncated: false,
    },
    bounds: {
      limit: 100,
      offset: 0,
      previous_offset: null,
      next_offset: null,
      total_nodes: 11,
      total_edges: 4,
      truncated: false,
    },
  },
}

const locatedReplay = {
  ...replay,
  events: [
    replayEvent(
      51,
      "accepted",
      "concept",
      TARGET_CONCEPT,
      null,
      "active",
      "candidate-51"
    ),
    replayEvent(
      52,
      "published",
      "production_run",
      "run-1",
      "publishing",
      "published"
    ),
  ],
  located_event_sequence: 51,
  event_bounds: {
    limit: 50,
    offset: 50,
    previous_offset: 0,
    next_offset: null,
    total: 52,
    truncated: true,
  },
}

test("plays, scrubs, steps and jumps through persisted replay and impact", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await mockReplay(page)
  await page.goto("/?view=replay#token=replay")

  await expect(
    page.getByRole("heading", { name: "Concept and impact replay" })
  ).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("listitem")
  ).toHaveCount(8)
  await expect(
    page.getByRole("button", { name: "Replay", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Concepts", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect(
    page.getByText("Proposed", { exact: true }).first()
  ).toBeVisible()

  await page.getByRole("button", { name: "Next event" }).click()
  await expect(page.getByRole("status")).toContainText("Verified")

  await page.getByLabel("Jump within page to event").selectOption("3")
  await expect(page.getByRole("status")).toContainText("Accepted · Workspace")
  await expect(
    page.getByRole("article", { name: "Current replay event" })
  ).toBeFocused()

  await page.getByLabel("Jump within page to entity").selectOption(CLAIM)
  await expect(page.getByRole("status")).toContainText(
    "Accepted · A Workspace represents one product."
  )

  await page.getByRole("slider", { name: "Replay position" }).press("End")
  await expect(page.getByRole("status")).toContainText("Published")

  await page.getByRole("button", { name: "Previous event" }).click()
  await page.getByRole("button", { name: "Play replay" }).click()
  await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("Published", {
    timeout: 3_000,
  })

  for (const label of ["Changed", "Moved", "Added", "Removed"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
  }
  await expect(
    page.getByText("Affected knowledge", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Stable knowledge", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("The API remains stable.")).toBeVisible()
  await expect(page.getByText("Affected propagation paths")).toBeVisible()

  await page.getByLabel("Event sequence").fill("51")
  await page.getByLabel("Event sequence").press("Enter")
  await expect(page.getByRole("status")).toContainText(
    `Accepted · ${TARGET_CONCEPT}`
  )
  await expect(
    page.getByRole("button", { name: "Previous history page" }).first()
  ).toBeEnabled()
  expect(errors).toEqual([])
})

test("supports keyboard replay and reduced-motion ordered equivalence", async ({
  page,
}) => {
  await mockReplay(page)
  await page.goto("/?view=replay#token=replay")

  const keyboard = page.getByRole("region", {
    name: "Replay keyboard controls",
  })
  await keyboard.focus()
  await keyboard.press("ArrowRight")
  await expect(page.getByRole("status")).toContainText("Verified")
  await keyboard.press("End")
  await expect(page.getByRole("status")).toContainText("Published")
  await keyboard.press("Home")
  await expect(page.getByRole("status")).toContainText("Proposed")

  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(
    page.getByRole("heading", { name: "Ordered replay (reduced motion)" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Play replay" })).toBeHidden()
  await page.getByLabel("Entity identity").fill(TARGET_CONCEPT)
  await page.getByLabel("Entity identity").press("Enter")
  await expect(page.getByTestId("reduced-replay-event")).toHaveCount(2)
  await expect(page.getByTestId("reduced-replay-event").first()).toContainText(
    "Accepted"
  )
  await expect(page.getByTestId("reduced-replay-event").last()).toContainText(
    "Published"
  )
  await expect(
    page.getByRole("button", { name: "Previous history page" })
  ).toBeVisible()
})

test("does not promise stable knowledge during a full-analysis fallback", async ({
  page,
}) => {
  await mockOverview(page)
  await page.route("**/api/v1/replay**", async (route) => {
    const fullReplay = structuredClone(replay)
    fullReplay.impact.mode = "full"
    fullReplay.impact.fallback_reason = "Source Unit relocation is ambiguous"
    fullReplay.impact.summary.affected = {
      evidence: 1,
      claims: 2,
      concepts: 2,
      pages: 2,
    }
    fullReplay.impact.summary.stable = {
      evidence: 0,
      claims: 0,
      concepts: 0,
      pages: 0,
    }
    for (const node of fullReplay.impact.nodes) {
      if (node.status === "stable") node.status = "affected"
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fullReplay),
    })
  })
  await page.goto("/?view=replay#token=fallback")

  await expect(
    page.getByRole("heading", { name: "Source impact" })
  ).toBeVisible()
  await expect(page.getByRole("alert")).toContainText(
    "Source Unit relocation is ambiguous"
  )
  await expect(
    page.getByText(/Full analysis marks downstream knowledge affected/)
  ).toBeVisible()
  await expect(
    page.getByText("Stable boundary unavailable", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText(/Unaffected knowledge remains stable/)
  ).toHaveCount(0)
})

test("rejects malformed replay ordering and impact identities", async ({
  page,
}) => {
  await mockOverview(page)
  for (const kind of [
    "sequence",
    "candidate identity",
    "claim identity",
    "published identity",
    "edge semantics",
    "path semantics",
    "fallback stability",
  ]) {
    await test.step(kind, async () => {
      await page.unroute("**/api/v1/replay**")
      await page.route("**/api/v1/replay**", async (route) => {
        const malformed = structuredClone(replay)
        if (kind === "sequence") malformed.events[1].sequence = 1
        else if (kind === "candidate identity")
          malformed.events[0].candidate_id = "candidate-changed"
        else if (kind === "claim identity")
          malformed.events[2].entity_id = "claim:missing"
        else if (kind === "published identity")
          malformed.events[6].entity_id = "run-other"
        else if (kind === "edge semantics")
          malformed.impact.edges[0] = impactEdge(EVIDENCE, "contains", CLAIM)
        else if (kind === "fallback stability") {
          malformed.impact.mode = "full"
          malformed.impact.fallback_reason =
            "Fallback cannot preserve stability"
        } else malformed.impact.paths[0].claim.type = "concept"
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(malformed),
        })
      })
      await page.goto(
        `/?view=replay&invalid=${encodeURIComponent(kind)}#token=invalid`
      )
      await expect(page.getByRole("alert")).toContainText(
        "invalid replay response"
      )
    })
  }
})

test("opens replay from Concepts and returns without adding primary navigation", async ({
  page,
}) => {
  await mockOverview(page)
  await mockConcepts(page)
  await mockReplayRoute(page)
  await page.goto("/?view=concepts#token=contextual")

  await page.getByRole("button", { name: "Replay history" }).click()
  await expect(page).toHaveURL(/view=replay&run=run-1/)
  await expect(
    page.getByRole("heading", { name: "Concept and impact replay" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Back to Concepts" }).click()
  await expect(page).toHaveURL(/view=concepts/)
  await expect(
    page.getByRole("button", { name: "Replay history" })
  ).toBeVisible()
})

async function mockReplay(page: Page) {
  await mockOverview(page)
  await mockReplayRoute(page)
}

async function mockReplayRoute(page: Page) {
  await page.route("**/api/v1/replay**", async (route) => {
    const url = new URL(route.request().url())
    const located =
      url.searchParams.get("event_sequence") === "51" ||
      url.searchParams.get("entity_id") === TARGET_CONCEPT
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(located ? locatedReplay : replay),
    })
  })
}

async function mockConcepts(page: Page) {
  await page.route("**/api/v1/concepts**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        run_id: "run-1",
        run_state: "published",
        selected_concept_id: null,
        concepts: [],
        nodes: [],
        edges: [],
        bounds: {
          limit: 100,
          offset: 0,
          previous_offset: null,
          next_offset: null,
          total_nodes: 0,
          total_edges: 0,
          filtered_total_nodes: 0,
          filtered_total_edges: 0,
          truncated: false,
        },
      }),
    })
  })
}

async function mockOverview(page: Page) {
  await page.route("**/api/v1/overview", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overview),
    })
  })
}

function replayEvent(
  sequence: number,
  stage: string,
  entityType: string,
  entityId: string,
  previousState: string | null,
  state: string,
  candidateId: string | null = null
) {
  return {
    run_id: "run-1",
    sequence,
    occurred_at: `2026-07-13T00:${String(Math.floor(sequence / 60)).padStart(2, "0")}:${String(sequence % 60).padStart(2, "0")}+00:00`,
    stage,
    entity_type: entityType,
    entity_id: entityId,
    entity_label:
      entityId === CLAIM
        ? "A Workspace represents one product."
        : entityId === CONCEPT
          ? "Workspace"
          : entityId,
    previous_state: previousState,
    state,
    candidate_id: candidateId,
  }
}

function impactUnit(
  id: string,
  revision: string,
  path: string,
  digestCharacter: string
) {
  return {
    id,
    source_id: "docs",
    revision,
    path,
    kind: "file",
    digest: `sha256:${digestCharacter.repeat(64)}`,
    label: null,
  }
}

function impactNode(
  id: string,
  entityId: string,
  type: string,
  label: string,
  status: string,
  before: ReturnType<typeof impactUnit> | null = null,
  after: ReturnType<typeof impactUnit> | null = null
) {
  return { id, entity_id: entityId, type, label, status, before, after }
}

function impactEdge(source: string, relation: string, target: string) {
  return { id: `${source}|${relation}|${target}`, source, relation, target }
}

function impactPathItem(
  id: string,
  entityId: string,
  type: string,
  label: string
) {
  return { id, entity_id: entityId, type, label }
}
