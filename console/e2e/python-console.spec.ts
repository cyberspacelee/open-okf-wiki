import { expect, test } from "@playwright/test"
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(process.cwd(), "..")
const maxSourceId = `docs-${"x".repeat(123)}`
const longBranch = `release/${"x".repeat(96)}`
let consoleProcess: ChildProcessWithoutNullStreams
let sessionUrl: string
let workspace: string
let gatewayServer: Server
let gatewayUrl: string
let rejectModelA = false
let linkedSource: string
let managedOrigin: string

test.beforeAll(async () => {
  workspace = mkdtempSync(resolve(tmpdir(), "okf-wiki-console-"))
  linkedSource = createGitSource("okf-wiki-linked-")
  managedOrigin = createGitSource("okf-wiki-origin-")
  gatewayServer = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const payload = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : null
      const send = (body: unknown, status = 200) => {
        const content = JSON.stringify(body)
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(content),
        })
        response.end(content)
      }
      if (request.url === "/v1/models") {
        if (request.headers.authorization !== "Bearer browser-secret") {
          send({ error: { message: "unauthorized" } }, 401)
          return
        }
        send({ data: [{ id: "model-a" }, { id: "model-b" }] })
        return
      }
      if (request.method === "GET") {
        send({ error: { message: "not found" } }, 404)
        return
      }
      if (rejectModelA && payload?.model === "model-a") {
        send({ error: { message: "gateway down" } }, 503)
        return
      }
      setTimeout(
        () =>
          send({
            choices: [
              {
                message: payload?.tools
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: { name: "okf_probe", arguments: "{}" },
                        },
                      ],
                    }
                  : { role: "assistant", content: '{"ok":true}' },
              },
            ],
            usage: {
              prompt_tokens: 2,
              completion_tokens: 1,
              total_tokens: 3,
            },
          }),
        30
      )
    })
  })
  await new Promise<void>((resolveListen) =>
    gatewayServer.listen(0, "127.0.0.1", resolveListen)
  )
  const address = gatewayServer.address()
  if (!address || typeof address === "string")
    throw new Error("Gateway did not start")
  gatewayUrl = `http://127.0.0.1:${address.port}/v1`
  execFileSync(
    "uv",
    [
      "run",
      "okf-wiki",
      "workspace",
      "init",
      "catalog-platform",
      "--name",
      "Catalog Platform",
      "--root",
      workspace,
    ],
    { cwd: repoRoot, stdio: "pipe" }
  )

  consoleProcess = spawn(
    "uv",
    ["run", "okf-wiki", "workspace", "console", workspace, "--no-open"],
    {
      cwd: repoRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        OKF_WIKI_CONFIG_HOME: resolve(workspace, "machine"),
      },
    }
  )
  sessionUrl = await readSessionUrl(consoleProcess)
})

test.afterAll(async () => {
  if (consoleProcess?.exitCode === null) {
    consoleProcess.kill("SIGTERM")
    await Promise.race([
      once(consoleProcess, "exit"),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ])
    if (consoleProcess.exitCode === null) consoleProcess.kill("SIGKILL")
  }
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  if (linkedSource) rmSync(linkedSource, { recursive: true, force: true })
  if (managedOrigin) rmSync(managedOrigin, { recursive: true, force: true })
  if (gatewayServer) {
    await new Promise<void>((resolveClose) =>
      gatewayServer.close(() => resolveClose())
    )
  }
})

test("configures, tests, and selects a Gateway Profile through Connections", async ({
  page,
}) => {
  await page.goto(sessionUrl)
  await page.getByRole("link", { name: "Connections" }).click()
  await expect(
    page.getByRole("heading", { level: 1, name: "Connections" })
  ).toBeVisible()

  await page.getByLabel("Profile name").fill("Enterprise Gateway")
  await page.getByLabel("Profile ID").fill("enterprise")
  await page.getByLabel("Gateway ID").fill("corp-openai")
  await page.getByLabel("OpenAI-compatible base URL").fill(gatewayUrl)
  await page.getByLabel("Optional non-secret headers").fill("X-Tenant=docs")
  await page.getByLabel("Credential").fill("browser-secret")
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/gateway-profiles"
  )
  await page.getByRole("button", { name: "Save profile" }).click()
  expect((await saveResponse).status()).toBe(200)
  await expect(
    page.getByRole("cell", { name: "Enterprise Gateway" })
  ).toBeVisible()
  await expect(page.getByLabel("Credential")).toHaveValue("")

  await page.getByLabel("Profile name").fill("Rejected Update")
  await page.getByLabel("Profile ID").fill("enterprise")
  await page.getByLabel("Gateway ID").fill("corp-openai")
  await page.getByLabel("OpenAI-compatible base URL").fill(gatewayUrl)
  await page
    .getByLabel("Optional non-secret headers")
    .fill("Authorization=Bearer forbidden")
  await page.getByLabel("Credential").fill("keep-on-failure")
  const rejectedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/gateway-profiles"
  )
  await page.getByRole("button", { name: "Save profile" }).click()
  expect((await rejectedResponse).status()).toBe(400)
  await expect(page.getByLabel("Credential")).toHaveValue("keep-on-failure")

  await page.getByLabel("Default model").fill("model-a")
  await page.getByLabel("Concurrency").fill("2")
  await page.getByLabel("Total token budget").fill("5000")
  await page.getByRole("button", { name: "Advanced role overrides" }).click()
  await page.getByLabel("Verifier").fill("model-b")

  await page.getByLabel("Capability test model").fill("model-a")
  const defaultTestResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/test")
  )
  await page.getByRole("button", { name: "Test" }).click()
  expect((await defaultTestResponse).status()).toBe(200)
  await expect(page.getByText("Verified")).toBeVisible()

  await page.getByLabel("Capability test model").fill("model-b")
  const overrideTestResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/test")
  )
  await page.getByRole("button", { name: "Test" }).click()
  expect((await overrideTestResponse).status()).toBe(200)
  await expect(page.getByText("Verified")).toBeVisible()

  await page.getByRole("button", { name: "Save Workspace selection" }).click()
  await expect(page.getByText("Workspace selection completed.")).toBeVisible()

  await page.getByLabel("Capability test model").fill("model-a")
  await expect(page.getByText("Verified")).toBeVisible()
  rejectModelA = true
  const failedTestResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/test")
  )
  await page.getByRole("button", { name: "Test" }).click()
  expect((await failedTestResponse).status()).toBe(400)
  await expect(page.getByRole("alert")).toContainText("Gateway service failed")
  await expect(page.getByText("Not tested")).toBeVisible()
  rejectModelA = false

  await page.getByLabel("Profile name").fill("Enterprise Gateway")
  await page.getByLabel("Profile ID").fill("enterprise")
  await page.getByLabel("Gateway ID").fill("corp-openai")
  await page.getByLabel("OpenAI-compatible base URL").fill(gatewayUrl)
  await page.getByLabel("Optional non-secret headers").fill("X-Tenant=docs")
  await page.getByLabel("Credential").fill("invalid-browser-secret")
  await page.getByRole("button", { name: "Save profile" }).click()
  await expect(page.getByText("Not tested")).toBeVisible()
})

test("loads the built Console through the real Python launcher", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000)
  const externalRequests: string[] = []
  const consoleErrors: string[] = []
  const origin = new URL(sessionUrl).origin
  const token = new URLSearchParams(new URL(sessionUrl).hash.slice(1)).get(
    "token"
  )

  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) {
      externalRequests.push(request.url())
    }
  })
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  const overviewResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/overview"
  )
  const shellResponse = await page.goto(sessionUrl)
  const apiResponse = await overviewResponse

  expect(shellResponse?.status()).toBe(200)
  expect(shellResponse?.headers()["content-security-policy"]).toContain(
    "default-src 'none'"
  )
  expect(apiResponse.status()).toBe(200)
  expect(apiResponse.request().headers()["authorization"]).toBe(
    `Bearer ${token}`
  )
  await expect(page).toHaveTitle("Workspace Console")
  await expect(page).toHaveURL(`${origin}/`)
  await expect(
    page.getByRole("heading", { level: 1, name: "Catalog Platform" })
  ).toBeVisible()
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await expect(page.getByText("No Sources are configured")).toBeVisible()

  await page.getByRole("button", { name: "Settings" }).focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { level: 1, name: "Workspace settings" })
  ).toBeVisible()
  const displayName = page.getByLabel("Display name")
  await displayName.fill("   ")
  await page.getByRole("button", { name: "Save settings" }).click()
  await expect(displayName).toHaveAttribute("aria-invalid", "true")
  await expect(page.getByText("Display name is required.")).toBeVisible()

  await displayName.focus()
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.type("Catalog Settings E2E")
  await page.getByRole("switch", { name: "Compact navigation" }).focus()
  await page.keyboard.press("Space")
  await page.getByRole("button", { name: "Save settings" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("status")).toContainText("Settings saved")
  await expect(
    page.locator('[data-slot="sidebar"][data-state="collapsed"]')
  ).toBeVisible()

  const persisted = JSON.parse(
    execFileSync(
      "uv",
      ["run", "okf-wiki", "workspace", "settings", workspace],
      { cwd: repoRoot, encoding: "utf-8" }
    )
  )
  expect(persisted.definition.project.name).toBe("Catalog Settings E2E")
  expect(persisted.local_settings.ui.compact_navigation).toBe(true)

  const settingsReload = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/settings" &&
      response.request().method() === "GET"
  )
  await page.reload()
  await settingsReload
  await expect(
    page.locator('[data-slot="sidebar"][data-state="collapsed"]')
  ).toBeVisible()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(displayName).toHaveValue("Catalog Settings E2E")

  const external = JSON.parse(
    execFileSync(
      "uv",
      ["run", "okf-wiki", "workspace", "settings", workspace],
      { cwd: repoRoot, encoding: "utf-8" }
    )
  )
  delete external.ok
  external.definition.project.name = "External Settings Update"
  external.definition.sources = [
    {
      id: "code",
      role: "implementation",
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: managedOrigin,
        encoding: "utf-8",
      }).trim(),
      remote: managedOrigin,
    },
    {
      id: maxSourceId,
      role: "documentation",
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: linkedSource,
        encoding: "utf-8",
      }).trim(),
      remote: null,
    },
  ]
  const externalPayload = join(workspace, ".okf-wiki", "external-update.json")
  writeFileSync(externalPayload, JSON.stringify(external))
  execFileSync(
    "uv",
    [
      "run",
      "okf-wiki",
      "workspace",
      "update-settings",
      externalPayload,
      workspace,
    ],
    { cwd: repoRoot, stdio: "pipe" }
  )

  await page.getByLabel("Publication target").fill("stale-target")
  await page.getByRole("button", { name: "Save settings" }).click()
  await expect(page.getByRole("alert")).toContainText("refresh and try again")
  await page.getByRole("button", { name: "Reload settings" }).click()
  await expect(displayName).toHaveValue("External Settings Update")

  await page.getByRole("button", { name: "Sources" }).focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { level: 1, name: "Sources" })
  ).toBeVisible()
  const configuredSources = page
    .getByText("Configured Sources", { exact: true })
    .locator("xpath=../..")
  const managedRow = configuredSources
    .getByRole("row")
    .filter({ has: page.getByText("code", { exact: true }) })
  const linkedRow = configuredSources
    .getByRole("row")
    .filter({ has: page.getByText(maxSourceId, { exact: true }) })
  await expect(managedRow).toContainText("Checkout not bound")
  await expect(linkedRow).toContainText("Checkout not bound")
  await expect(
    managedRow.getByRole("button", { name: "Remove code configuration" })
  ).toBeVisible()
  await managedRow.getByRole("button", { name: "Clone" }).click()
  await expect(managedRow).toContainText("managed")
  await expect(managedRow).toContainText("Clean")
  const managedCheckout = join(workspace, "sources", "code")
  const managedBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd: managedCheckout,
    encoding: "utf-8",
  }).trim()
  execFileSync("git", ["switch", "-c", longBranch], { cwd: managedOrigin })
  writeFileSync(join(managedOrigin, "RELEASE.md"), "release branch\n")
  execFileSync("git", ["add", "RELEASE.md"], { cwd: managedOrigin })
  execFileSync("git", ["commit", "-qm", "release branch"], {
    cwd: managedOrigin,
  })
  const releaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: managedOrigin,
    encoding: "utf-8",
  }).trim()
  execFileSync("git", ["switch", managedBranch], { cwd: managedOrigin })
  execFileSync(
    "git",
    [
      "fetch",
      "-q",
      "origin",
      `${longBranch}:refs/remotes/origin/${longBranch}`,
    ],
    { cwd: managedCheckout }
  )
  execFileSync("git", ["branch", longBranch, `origin/${longBranch}`], {
    cwd: managedCheckout,
  })
  await linkedRow.getByRole("button", { name: "Link below" }).click()
  await expect(page.getByLabel("Source ID").nth(1)).toBeDisabled()
  await expect(page.getByLabel("Source ID").nth(1)).toHaveValue(maxSourceId)
  await expect(
    page.getByLabel("Source ID").nth(1).locator("xpath=..")
  ).toHaveAttribute("data-disabled", "true")
  await page.getByLabel("Local checkout path").fill(linkedSource)
  await page.getByRole("button", { name: "Bind checkout" }).click()
  await expect(linkedRow).toContainText("linked")
  expect(existsSync(linkedSource)).toBe(true)

  const revisionPolicies = page
    .getByText("Revision Policies", { exact: true })
    .locator("xpath=../..")
  const managedPolicy = revisionPolicies.getByRole("group", {
    name: "code · Implementation",
  })
  const linkedPolicy = revisionPolicies.getByRole("group", {
    name: `${maxSourceId} · Documentation`,
  })
  await managedPolicy.getByRole("button", { name: "Follow Branch" }).click()
  await managedPolicy.getByLabel("Branch").fill(longBranch)
  await managedPolicy.getByRole("button", { name: "Save policy" }).click()
  await expect(managedPolicy).toContainText("Follow Branch")
  await expect(managedPolicy).toContainText(releaseCommit)
  await managedPolicy.getByLabel("Branch").fill(managedBranch)
  await managedPolicy.getByRole("button", { name: "Save policy" }).click()
  writeFileSync(join(managedOrigin, "REMOTE.md"), "remote update\n")
  execFileSync("git", ["add", "REMOTE.md"], { cwd: managedOrigin })
  execFileSync("git", ["commit", "-qm", "remote update"], {
    cwd: managedOrigin,
  })
  const pulledCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: managedOrigin,
    encoding: "utf-8",
  }).trim()
  await managedRow.getByRole("button", { name: "Pull" }).click()
  await expect(managedRow).toContainText(pulledCommit)
  await managedPolicy.getByLabel("Branch").fill(longBranch)
  await managedPolicy.getByRole("button", { name: "Save policy" }).click()

  const linkedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: linkedSource,
    encoding: "utf-8",
  }).trim()
  await linkedPolicy.getByRole("button", { name: "Pinned Commit" }).click()
  await linkedPolicy.getByLabel("Commit").fill(linkedCommit)
  await linkedPolicy.getByRole("button", { name: "Save policy" }).click()
  const preflightCard = page
    .getByText("Next Run Source Set", { exact: true })
    .locator("xpath=../..")
  await expect(preflightCard).toContainText(releaseCommit)
  await expect(preflightCard).toContainText(linkedCommit)
  await expect(preflightCard).toContainText("Local commit")
  await expect(preflightCard).toContainText("Remote commit")
  await expect(preflightCard).toContainText("Source Set")
  const preflightTable = preflightCard.getByRole("table")
  await expect(preflightTable.getByRole("columnheader")).toHaveText([
    "Source",
    "Policy",
    "Local commit",
    "Remote commit",
    "Exact commit",
    "Tree digest",
  ])
  await expect(preflightCard).toContainText(maxSourceId)
  await expect(preflightCard).toContainText(longBranch)
  const preflightRows = preflightTable.locator("tbody tr")
  const rowCellBounds = await preflightRows.evaluateAll((rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll("td")).map((cell) => {
        const bounds = cell.getBoundingClientRect()
        return { left: bounds.left, right: bounds.right }
      })
    )
  )
  expect(
    rowCellBounds.every((cellBounds) =>
      cellBounds.every(
        (bounds, index) =>
          index === cellBounds.length - 1 ||
          bounds.right <= cellBounds[index + 1].left + 1
      )
    )
  ).toBe(true)
  const preflightCells = preflightTable.getByRole("cell")
  const cellMetrics = await preflightCells.evaluateAll((cells) =>
    cells.map((cell) => ({
      clientWidth: cell.clientWidth,
      scrollWidth: cell.scrollWidth,
      whiteSpace: getComputedStyle(cell).whiteSpace,
    }))
  )
  expect(
    cellMetrics.every(
      ({ clientWidth, scrollWidth, whiteSpace }) =>
        whiteSpace !== "nowrap" && scrollWidth <= clientWidth
    )
  ).toBe(true)

  await preflightCard
    .getByRole("button", { name: "Controlled Failure" })
    .click()
  const failedRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/runs"
  )
  await preflightCard.getByRole("button", { name: "Start Run" }).click()
  expect((await failedRunResponse).status()).toBe(200)
  await expect(page).toHaveURL(/\?view=runs&run=[0-9a-f]{32}$/)
  await expect(page.getByRole("alert")).toContainText(
    "Deterministic failure fixture stopped during Exploring"
  )
  await expect(page.locator('[aria-current="step"]')).toHaveText("Exploring")

  await page.getByRole("button", { name: "Sources" }).click()
  await expect(preflightCard).toBeVisible()
  await preflightCard.getByRole("button", { name: "Review Required" }).click()
  const successfulRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/runs"
  )
  await preflightCard.getByRole("button", { name: "Start Run" }).click()
  expect((await successfulRunResponse).status()).toBe(200)
  await expect(page.locator('[aria-current="step"]')).toHaveText("Preparing")
  await expect(page.locator('[aria-current="step"]')).toHaveText("Verifying")
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  const successfulRunUrl = page.url()
  await page.screenshot({
    path: "test-results/runs-desktop.png",
    fullPage: true,
  })
  await page.reload()
  await expect(page).toHaveURL(successfulRunUrl)
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  const runsMobileSidebar = page.locator(
    '[data-slot="sidebar"][data-mobile="true"]'
  )
  await runsMobileSidebar.getByRole("button", { name: "Runs" }).click()
  await expect(runsMobileSidebar).toHaveCount(0)
  await expect(
    page.getByText("Exact Source Set", { exact: true })
  ).toBeVisible()
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  const runsOverflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(runsOverflow.width).toBe(runsOverflow.viewport)
  await page.getByRole("button", { name: "Cancel Run" }).click()
  const cancelDialog = page.getByRole("alertdialog")
  await expect(
    cancelDialog.getByText("Cancel this Production Run?")
  ).toBeVisible()
  const cancelResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/cancel")
  )
  await cancelDialog.getByRole("button", { name: "Cancel Run" }).click()
  expect((await cancelResponse).status()).toBe(200)
  await expect(page.getByText("Terminal", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Cancelled", { exact: true }).first()
  ).toBeVisible()
  await page.screenshot({
    path: "test-results/runs-mobile-real.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 1280, height: 720 })

  await page.getByRole("button", { name: "Sources" }).click()
  await expect(preflightCard).toBeVisible()
  await preflightCard.getByRole("button", { name: "Review Required" }).click()
  const readerRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/runs"
  )
  await preflightCard.getByRole("button", { name: "Start Run" }).click()
  expect((await readerRunResponse).status()).toBe(200)
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  const readerRunId = new URL(page.url()).searchParams.get("run")!
  const readerSourceSet = JSON.parse(
    execFileSync(
      "uv",
      [
        "run",
        "python",
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select source_set_json from runs where id=?',(sys.argv[2],)).fetchone()[0])",
        join(workspace, ".okf-wiki", "runs.db"),
        readerRunId,
      ],
      { cwd: repoRoot, encoding: "utf-8" }
    )
  )
  const readerSource = readerSourceSet.sources[0]
  const evidenceText = execFileSync(
    "git",
    ["show", `${readerSource.revision}:README.md`],
    { cwd: readerSource.repository, encoding: "utf-8" }
  ).trimEnd()
  const claimId = `claim:${"a".repeat(64)}`
  const evidenceId = `evidence:${"b".repeat(64)}`
  const evidenceDigest = `sha256:${createHash("sha256").update(evidenceText).digest("hex")}`
  execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('insert into accepted_evidence values (?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],sys.argv[5],sys.argv[6],'README.md','fixture:readme',1,1,sys.argv[7],'source_span','authoritative')); c.execute('insert into accepted_claims values (?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[4],'Source','documents','Source knowledge.','asserted','[]','supported')); c.execute('insert into claim_evidence values (?,?,?)',(sys.argv[2],sys.argv[4],sys.argv[3])); c.commit()",
      join(workspace, ".okf-wiki", "runs.db"),
      readerRunId,
      evidenceId,
      claimId,
      readerSource.id,
      readerSource.revision,
      evidenceDigest,
    ],
    { cwd: repoRoot, stdio: "pipe" }
  )
  const readerPage = join(
    workspace,
    ".okf-wiki",
    "runs",
    readerRunId,
    "staging",
    "guides",
    "secure-reader.md"
  )
  writeFileSync(
    join(
      workspace,
      ".okf-wiki",
      "runs",
      readerRunId,
      "staging",
      "guides",
      "pixel.png"
    ),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  )
  writeFileSync(
    readerPage,
    `---
type: Guide
id: secure-reader
title: Secure reader fixture
---

# Secure reader fixture

- [x] Parsed task

| Boundary | State |
| --- | --- |
| CSP | strict |

\`\`\`python
print("safe")
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Source] --> B[Claim]
  A[Source] --> C[Bundle]
\`\`\`

Math $x^2$ renders locally.

![Pixel](pixel.png)

Accepted knowledge is source grounded.

<!-- claims: ${claimId} -->

# Citations

* \`${claimId}\` — \`repo://${readerSource.id}@${readerSource.revision}/README.md#L1-L1\`

<script>window.readerPwned = true</script>

[Unsafe](javascript:alert(1))
`
  )

  await page.getByRole("button", { name: "Knowledge" }).click()
  await page.getByRole("button", { name: "Secure reader fixture" }).click()
  await expect(
    page.getByRole("heading", { name: "Secure reader fixture" }).first()
  ).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: "Completed task" })
  ).toBeChecked()
  await expect(page.getByRole("cell", { name: "strict" })).toBeVisible()
  await expect(
    page.getByRole("img", {
      name: "Mermaid flowchart. Nodes: Source, Claim, Bundle. Relations: Source → Claim; Source → Bundle.",
    })
  ).toContainText("Bundle")
  await expect(page.getByLabel("Mathematical notation: x^2")).toContainText(
    "x2"
  )
  await expect(page.getByRole("img", { name: "Pixel" })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Raw HTML was omitted")
  await expect(page.getByRole("alert")).toContainText(
    "Unsafe URL was omitted: javascript:alert(1)"
  )
  expect(
    await page.evaluate(
      () => (window as Window & { readerPwned?: boolean }).readerPwned
    )
  ).toBeUndefined()
  await page.getByRole("button", { name: "View accepted Claim" }).click()
  await expect(page.getByRole("dialog")).toContainText("Evidence excerpts")
  await expect(page.getByRole("dialog").locator("pre")).not.toBeEmpty()
  await page.getByRole("button", { name: "Close" }).click()
  await page.getByRole("button", { name: "Claim aaaaaaaa" }).click()
  await expect(page.getByRole("dialog")).toContainText("README.md#L1-L1")
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    evidenceText
  )
  await page.getByRole("button", { name: "Close" }).click()

  await context.setOffline(true)
  await page.getByRole("button", { name: "Source", exact: true }).click()
  await expect(page.getByLabel("Generated Markdown source")).toContainText(
    "<script>window.readerPwned"
  )
  await page.getByRole("button", { name: "Rendered" }).click()
  await expect(page.getByLabel("Mathematical notation: x^2")).toContainText(
    "x2"
  )
  await page
    .getByRole("navigation", { name: "On this page" })
    .getByRole("link", { name: "Secure reader fixture" })
    .click()
  await expect(page).toHaveURL(/#secure-reader-fixture$/)
  await page.screenshot({
    path: "test-results/knowledge-desktop-real.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  const knowledgeOverflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(knowledgeOverflow.width).toBe(knowledgeOverflow.viewport)
  await page.screenshot({
    path: "test-results/knowledge-mobile-real.png",
    fullPage: true,
  })

  await context.setOffline(false)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole("button", { name: "Runs", exact: true }).click()
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  await page.getByRole("button", { name: "Cancel Run" }).click()
  const readerCancelDialog = page.getByRole("alertdialog")
  const readerCancelResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/cancel")
  )
  await readerCancelDialog.getByRole("button", { name: "Cancel Run" }).click()
  expect((await readerCancelResponse).status()).toBe(200)

  await page.getByRole("button", { name: "Sources" }).click()
  await expect(preflightCard).toBeVisible()
  await preflightCard.getByRole("button", { name: "Review Required" }).click()
  const reviewRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/runs"
  )
  await preflightCard.getByRole("button", { name: "Start Run" }).click()
  expect((await reviewRunResponse).status()).toBe(200)
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  await page.getByRole("button", { name: "Review", exact: true }).click()
  await expect(
    page.getByRole("heading", { level: 1, name: "Review & publish" })
  ).toBeVisible()
  await expect(page.getByTestId("review-digest")).toHaveText(/[0-9a-f]{64}/)
  await page
    .getByRole("row", { name: /overview\.md Added/ })
    .getByRole("button", { name: "Details" })
    .click()
  await expect(page.getByRole("dialog")).toContainText(
    "Overview of the fixed source revision."
  )
  await page.keyboard.press("Escape")
  const approvalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/decision")
  )
  await page.getByRole("button", { name: "Approve & publish" }).click()
  await page.getByRole("button", { name: "Confirm publication" }).click()
  expect((await approvalResponse).status()).toBe(200)
  await expect(page.getByRole("alert")).toContainText("published atomically")
  expect(existsSync(join(workspace, "published", "overview.md"))).toBe(true)

  await page.getByRole("button", { name: "Sources" }).click()
  await expect(preflightCard).toBeVisible()

  await page.screenshot({
    path: "test-results/sources-desktop.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  const sidebarTrigger = page.getByRole("button", { name: "Toggle Sidebar" })
  await expect(sidebarTrigger).toBeVisible()
  await sidebarTrigger.click()
  const mobileSidebar = page.locator(
    '[data-slot="sidebar"][data-mobile="true"]'
  )
  await expect(mobileSidebar).toBeVisible()
  await mobileSidebar.getByRole("button", { name: "Sources" }).click()
  await expect(mobileSidebar).toHaveCount(0)
  await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0)
  const pageOverflow = await page.evaluate(() => ({
    body: document.body.style.overflow,
    document: document.documentElement.style.overflow,
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(pageOverflow.body).not.toBe("hidden")
  expect(pageOverflow.document).not.toBe("hidden")
  expect(pageOverflow.width).toBe(pageOverflow.viewport)
  const preflightScroller = preflightCard.locator(
    '[data-slot="table-container"]'
  )
  const scrollRange = await preflightScroller.evaluate(
    (element) => element.scrollWidth - element.clientWidth
  )
  expect(scrollRange).toBeGreaterThan(0)
  await preflightScroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth
  })
  const treeDigestIsHorizontallyVisible = await preflightRows
    .first()
    .getByRole("cell")
    .nth(5)
    .evaluate((cell) => {
      const container = cell.closest('[data-slot="table-container"]')
      if (!container) return false
      const cellBounds = cell.getBoundingClientRect()
      const containerBounds = container.getBoundingClientRect()
      return (
        cellBounds.left >= containerBounds.left - 1 &&
        cellBounds.right <= containerBounds.right + 1
      )
    })
  expect(treeDigestIsHorizontallyVisible).toBe(true)
  await preflightScroller.evaluate((element) => {
    element.scrollLeft = 0
  })
  await page.screenshot({
    path: "test-results/sources-mobile.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 1280, height: 720 })

  await managedRow.getByRole("button", { name: "Remove" }).click()
  await expect(
    page.getByText("Retained managed checkouts", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Delete checkout" }).click()
  const deleteDialog = page.getByRole("alertdialog")
  const confirmation = deleteDialog.getByLabel("Source ID confirmation")
  await confirmation.fill("wrong")
  await expect(
    deleteDialog.getByRole("button", { name: "Delete checkout" })
  ).toBeDisabled()
  await confirmation.fill("code")
  await deleteDialog.getByRole("button", { name: "Delete checkout" }).click()
  await expect(
    page.getByText("Retained managed checkouts", { exact: true })
  ).toBeHidden()
  expect(existsSync(join(workspace, "sources", "code"))).toBe(false)

  writeFileSync(join(linkedSource, "untracked.txt"), "local change\n")
  await page.getByRole("button", { name: "Refresh status" }).click()
  await expect(linkedRow).toContainText("Dirty")
  await linkedRow.getByRole("button", { name: "Pull" }).click()
  await expect(page.getByRole("alert")).toContainText("Pull blocked")
  await linkedRow.getByRole("button", { name: "Remove" }).click()
  await expect(linkedRow).toBeHidden()
  expect(existsSync(linkedSource)).toBe(true)

  await page.getByLabel("Source ID").nth(0).fill("../escape")
  await page.getByLabel("Git remote").fill(managedOrigin)
  await page.getByRole("button", { name: "Clone Source" }).click()
  await expect(page.getByRole("alert")).toContainText("Invalid Source id")
  expect(existsSync(join(workspace, "escape"))).toBe(false)

  const localSettingsPath = join(workspace, ".okf-wiki", "settings.toml")
  writeFileSync(
    localSettingsPath,
    readFileSync(localSettingsPath, "utf-8").replace(
      "[models]\n",
      '[models]\napi_key = "removed-secret"\n'
    )
  )
  await page.getByRole("link", { name: "Overview" }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText(
    "use a Gateway Profile credential reference"
  )
  await expect(page.getByRole("alert")).not.toContainText("removed-secret")
  expect(externalRequests).toEqual([])
  expect(
    consoleErrors.every(
      (message) =>
        message.includes("409 (Conflict)") ||
        message.includes("400 (Bad Request)")
    )
  ).toBe(true)
})

function createGitSource(prefix: string) {
  const path = mkdtempSync(resolve(tmpdir(), prefix))
  execFileSync("git", ["init", "-q"], { cwd: path })
  execFileSync("git", ["config", "user.name", "Playwright"], { cwd: path })
  execFileSync("git", ["config", "user.email", "playwright@example.com"], {
    cwd: path,
  })
  writeFileSync(join(path, "README.md"), "Source knowledge.\n")
  execFileSync("git", ["add", "README.md"], { cwd: path })
  execFileSync("git", ["commit", "-qm", "source"], { cwd: path })
  return path
}

function readSessionUrl(process: ChildProcessWithoutNullStreams) {
  return new Promise<string>((resolveUrl, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      reject(new Error(`Console did not start: ${stderr || stdout}`))
    }, 10_000)

    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    process.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      const line = stdout.split("\n").find((candidate) => candidate.trim())
      if (!line) return

      try {
        const payload: unknown = JSON.parse(line)
        if (
          typeof payload === "object" &&
          payload !== null &&
          "session_url" in payload &&
          typeof payload.session_url === "string"
        ) {
          clearTimeout(timeout)
          resolveUrl(payload.session_url)
        }
      } catch {
        // Wait for a complete JSON line.
      }
    })
    process.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`Console exited with ${code}: ${stderr || stdout}`))
    })
  })
}
