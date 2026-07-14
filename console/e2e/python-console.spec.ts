import { expect, test, type Locator, type Page } from "@playwright/test"
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
type GatewayPayload = {
  model?: string
  messages?: Array<{
    role?: string
    content?: string | Array<{ text?: string }>
  }>
  tools?: Array<{ function?: { name?: string } }>
}
type ReleaseRunDetail = {
  source_set_digest: string
  sources: Array<{
    id: string
    role: string
    revision: string
  }>
  models: {
    profile: { id: string }
    assignments: Record<string, string>
  } | null
}
type ReleaseKnowledgeSnapshot = {
  selected: {
    kind: string
    run_id: string
    source_set_digest: string
  }
  pages: Array<{ path: string; title: string }>
}
type ReleaseKnowledgePage = {
  path: string
  title: string
  concept_id: string | null
  blocks: unknown[]
}
type ReleaseKnowledgeClaim = {
  id: string
  statement: string
  evidence: Array<{
    id: string
    source_id: string
    revision: string
    path: string
    start_line: number
    end_line: number
    digest: string
    excerpt: string | null
  }>
}
let queryFixture:
  | {
      conceptId: string
      claimId: string
      evidenceId: string
      sourceId: string
      sourcePath: string
      sourceText: string
      startLine: number
      endLine: number
    }
  | undefined

test.beforeAll(async () => {
  workspace = mkdtempSync(resolve(tmpdir(), "okf-wiki-console-"))
  linkedSource = createGitSource("okf-wiki-linked-")
  managedOrigin = createGitSource("okf-wiki-origin-")
  gatewayServer = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const payload = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as GatewayPayload)
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
      const query = queryGatewayResponse(payload)
      if (query) {
        setTimeout(() => send(query), 30)
        return
      }
      const semanticRun = semanticRunGatewayResponse(payload)
      if (semanticRun) {
        setTimeout(() => send(semanticRun), 30)
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

function queryGatewayResponse(payload: GatewayPayload | null) {
  const names = (payload?.tools ?? []).flatMap((tool) =>
    tool.function?.name ? [tool.function.name] : []
  )
  if (!payload || !queryFixture) return null
  const serialized = JSON.stringify(payload.messages)
  const investigationTools = ["list_paths", "search_text", "read_text"]
  if (investigationTools.every((name) => names.includes(name))) {
    const output = names.find((name) => !investigationTools.includes(name))
    if (!output) throw new Error("Source Investigation output tool is missing")
    const returns = (payload.messages ?? []).filter(
      (message) => message.role === "tool"
    ).length
    const name = returns === 0 ? "read_text" : output
    const args =
      returns === 0
        ? {
            source_id: queryFixture.sourceId,
            path: queryFixture.sourcePath,
            start_line: queryFixture.startLine,
            end_line: queryFixture.endLine,
          }
        : {
            segments: [
              {
                kind: "fact",
                text: queryFixture.sourceText,
                citations: [
                  {
                    source_id: queryFixture.sourceId,
                    path: queryFixture.sourcePath,
                    start_line: queryFixture.startLine,
                    end_line: queryFixture.endLine,
                  },
                ],
              },
            ],
          }
    return gatewayToolResponse(
      payload.model,
      name,
      args,
      `investigation-${returns}`
    )
  }
  if (!names.includes("renderable_claims")) return null
  const output = names.find(
    (name) =>
      ![
        "find_concepts",
        "renderable_claims",
        "get_claim",
        "read_evidence",
      ].includes(name)
  )
  if (!output) throw new Error("Query output tool is missing")
  const returns = (payload.messages ?? []).filter(
    (message) => message.role === "tool"
  ).length
  const bundle = serialized.includes('\\"scope\\": \\"bundle\\"')
  let name: string
  let args: object
  if (serialized.includes("Which source-only detail remains provisional?")) {
    name = output
    args = { segments: [{ kind: "insufficient_support" }] }
  } else if (bundle && returns === 0) {
    name = "find_concepts"
    args = { query: "Source" }
  } else if ((bundle && returns === 1) || (!bundle && returns === 0)) {
    name = "renderable_claims"
    args = { concept_id: queryFixture.conceptId }
  } else if ((bundle && returns === 2) || (!bundle && returns === 1)) {
    name = "read_evidence"
    args = {
      claim_id: queryFixture.claimId,
      evidence_id: queryFixture.evidenceId,
    }
  } else {
    name = output
    args = {
      segments: [
        {
          kind: "fact",
          claim_ids: [queryFixture.claimId],
          evidence_ids: [queryFixture.evidenceId],
        },
      ],
    }
  }
  return gatewayToolResponse(payload.model, name, args, `query-${returns}`)
}

function semanticRunGatewayResponse(payload: GatewayPayload | null) {
  if (!payload) return null
  const message = gatewayMessageText(payload)
  const sourceTools = new Set(["list_paths", "search_text", "read_text"])
  const output = (payload.tools ?? [])
    .flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
    .find((name) => !sourceTools.has(name))

  if (message.includes('"prioritized_obligations"')) {
    if (!output) throw new Error("Planner output tool is missing")
    const summary = JSON.parse(message) as {
      prioritized_obligations?: Array<{
        id: string
        source_id: string
        path: string
      }>
      remaining_budgets?: { worker?: object }
    }
    const obligation = summary.prioritized_obligations?.[0]
    const budgets = summary.remaining_budgets?.worker
    if (!obligation || !budgets)
      throw new Error("Planner summary is missing an obligation or budgets")
    return gatewayToolResponse(
      payload.model,
      output,
      {
        tasks: [
          {
            obligation_ids: [obligation.id],
            source_id: obligation.source_id,
            allowed_paths: [obligation.path],
            agent_role: "extraction",
            allowed_tools: [...sourceTools],
            prompt: "Extract the assigned source-grounded obligation.",
            budgets,
          },
        ],
      },
      `semantic-planner-${obligation.id}`
    )
  }

  const assignmentMarker = "Task assignment: "
  if (message.includes(assignmentMarker)) {
    if (!output) throw new Error("Worker output tool is missing")
    const assignment = JSON.parse(
      message.slice(message.indexOf(assignmentMarker) + assignmentMarker.length)
    ) as {
      task_id: string
      obligation_ids: string[]
      source_id: string
      revision: string
      allowed_paths: string[]
    }
    const path = assignment.allowed_paths[0]
    if (!path) throw new Error("Worker assignment has no allowed path")
    const checkout =
      assignment.source_id === "code"
        ? join(workspace, "sources", "code")
        : linkedSource
    const source = execFileSync(
      "git",
      ["show", `${assignment.revision}:${path}`],
      { cwd: checkout, encoding: "utf-8" }
    )
    const lines = source.split(/\r?\n/)
    let lineIndex = lines.length - 1
    while (lineIndex > 0 && !lines[lineIndex].trim()) lineIndex -= 1
    const text = lines[lineIndex]
    const evidenceId = `evidence:${assignment.task_id}`
    const claimId = `claim:${assignment.task_id}`
    const conceptId = `concept:${assignment.task_id}`
    return gatewayToolResponse(
      payload.model,
      output,
      {
        task_id: assignment.task_id,
        obligation_ids: assignment.obligation_ids,
        evidence: [
          {
            id: evidenceId,
            source_id: assignment.source_id,
            path,
            revision: assignment.revision,
            start_line: lineIndex + 1,
            end_line: lineIndex + 1,
            digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
          },
        ],
        claims: [{ id: claimId, text, evidence_ids: [evidenceId] }],
        concepts: [
          {
            id: conceptId,
            name: "Deterministic source knowledge",
            description: text,
            claim_ids: [claimId],
          },
        ],
        relations: [],
        dispositions: [
          {
            obligation_id: assignment.obligation_ids[0],
            disposition: "covered",
            reason: "The fixed Source Snapshot supports the Claim.",
            evidence_ids: [evidenceId],
          },
        ],
      },
      `semantic-worker-${assignment.task_id}`
    )
  }

  if (message.includes('"perspective"') && message.includes('"target"')) {
    if (!output) throw new Error("Verifier output tool is missing")
    const prompt = JSON.parse(message) as {
      perspective?: string
      target?: { candidate_id?: string }
      evidence?: Array<{ id?: string }>
    }
    const perspective = prompt.perspective
    const targetId = prompt.target?.candidate_id
    const evidenceId = prompt.evidence?.[0]?.id
    if (!perspective || !targetId || !evidenceId)
      throw new Error("Verifier prompt is missing its bounded target")
    return gatewayToolResponse(
      payload.model,
      output,
      {
        target_id: targetId,
        perspective,
        verdict: "pass",
        severity: "info",
        evidence: [evidenceId],
        rationale: "The fixed Source Snapshot supports the candidate.",
      },
      `semantic-verifier-${perspective}`
    )
  }

  return null
}

function gatewayMessageText(payload: GatewayPayload) {
  const content = payload.messages?.at(-1)?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
}

function gatewayToolResponse(
  model: string | undefined,
  name: string,
  args: object,
  id: string
) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `${id}-call`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function firstClaimId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const claimId = firstClaimId(item)
      if (claimId) return claimId
    }
    return null
  }
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (record.type === "claim" && typeof record.claim_id === "string")
    return record.claim_id
  for (const item of Object.values(record)) {
    const claimId = firstClaimId(item)
    if (claimId) return claimId
  }
  return null
}

async function expectDesktopViewport(
  page: Page,
  width: number,
  height: number
) {
  await page.setViewportSize({ width, height })
  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }))
  expect(page.viewportSize()).toEqual({ width, height })
  expect(layout.content).toBe(layout.viewport)
}

async function contrastRatio(locator: Locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas color sampling is unavailable")
    const sample = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
      return [red, green, blue, alpha] as const
    }
    const layers: Array<readonly [number, number, number, number]> = []
    let current: Element | null = element
    while (current) {
      const background = sample(getComputedStyle(current).backgroundColor)
      if (background[3] > 0) layers.push(background)
      current = current.parentElement
    }
    let backdrop = [255, 255, 255]
    for (const [red, green, blue, alphaByte] of layers.reverse()) {
      const alpha = alphaByte / 255
      backdrop = [
        red * alpha + backdrop[0] * (1 - alpha),
        green * alpha + backdrop[1] * (1 - alpha),
        blue * alpha + backdrop[2] * (1 - alpha),
      ]
    }
    const [red, green, blue, alphaByte] = sample(
      getComputedStyle(element).color
    )
    const alpha = alphaByte / 255
    const foreground = [
      red * alpha + backdrop[0] * (1 - alpha),
      green * alpha + backdrop[1] * (1 - alpha),
      blue * alpha + backdrop[2] * (1 - alpha),
    ]
    const luminance = (rgb: number[]) =>
      rgb
        .map((channel) => channel / 255)
        .map((channel) =>
          channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4
        )
        .reduce(
          (total, channel, index) =>
            total + channel * [0.2126, 0.7152, 0.0722][index],
          0
        )
    const foregroundLuminance = luminance(foreground)
    const backgroundLuminance = luminance(backdrop)
    return (
      (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    )
  })
}

async function publicKnowledgeState(
  page: Page,
  origin: string,
  token: string,
  runId: string,
  pagePath: string,
  claimId: string
) {
  const headers = { Authorization: `Bearer ${token}` }
  const navigationQuery = new URLSearchParams({
    bundle: "published",
    run_id: runId,
  })
  const pageQuery = new URLSearchParams({
    bundle: "published",
    run_id: runId,
    path: pagePath,
  })
  const claimQuery = new URLSearchParams({
    bundle: "published",
    run_id: runId,
  })
  const responses = await Promise.all([
    page.request.get(`${origin}/api/v1/knowledge?${navigationQuery}`, {
      headers,
    }),
    page.request.get(`${origin}/api/v1/knowledge/page?${pageQuery}`, {
      headers,
    }),
    page.request.get(
      `${origin}/api/v1/knowledge/claims/${encodeURIComponent(claimId)}?${claimQuery}`,
      { headers }
    ),
  ])
  for (const response of responses) expect(response.ok()).toBe(true)
  const [navigation, knowledgePage, claim] = await Promise.all(
    responses.map((response) => response.json())
  )
  return { navigation, page: knowledgePage, claim }
}

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
  test.setTimeout(60_000)
  await page.goto(sessionUrl)
  await page.getByRole("link", { name: "Connections" }).click()
  await expect(
    page.getByRole("heading", { level: 1, name: "Connections" })
  ).toBeVisible()

  await page.getByLabel("Profile name").fill("Enterprise Gateway")
  await page.getByLabel("Profile ID").fill("enterprise")
  await page.getByLabel("Gateway ID").fill("corp-openai")
  await page.getByLabel("OpenAI-compatible base URL").fill(gatewayUrl)
  await page
    .getByLabel("Optional non-secret headers")
    .fill("X-Tenant=browser-tenant")
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
  await page
    .getByLabel("Optional non-secret headers")
    .fill("X-Tenant=browser-tenant")
  await page.getByLabel("Credential").fill("invalid-browser-secret")
  const invalidCredentialResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/gateway-profiles"
  )
  await page.getByRole("button", { name: "Save profile" }).click()
  expect((await invalidCredentialResponse).status()).toBe(200)
  await expect(page.getByText("Not tested")).toBeVisible()

  await expect(page.getByRole("button", { name: "Save profile" })).toBeEnabled()
  await page.getByLabel("Profile name").fill("Enterprise Gateway")
  await page.getByLabel("Profile ID").fill("enterprise")
  await page.getByLabel("Gateway ID").fill("corp-openai")
  await page.getByLabel("OpenAI-compatible base URL").fill(gatewayUrl)
  await page
    .getByLabel("Optional non-secret headers")
    .fill("X-Tenant=browser-tenant")
  await page.getByLabel("Credential").fill("browser-secret")
  const restoredProfileResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/gateway-profiles"
  )
  await page.getByRole("button", { name: "Save profile" }).focus()
  await page.keyboard.press("Enter")
  expect((await restoredProfileResponse).status()).toBe(200)
  await expect(page.getByLabel("Credential")).toHaveValue("")
  for (const model of ["model-a", "model-b"]) {
    await page.getByLabel("Capability test model").fill(model)
    const restoredTestResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/test")
    )
    await page.getByRole("button", { name: "Test" }).focus()
    await page.keyboard.press("Enter")
    expect((await restoredTestResponse).status()).toBe(200)
  }
  await page.getByRole("button", { name: "Save Workspace selection" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Workspace selection completed.")).toBeVisible()
})

test("completes the real multi-source release journey accessibly", async ({
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
  if (!token) throw new Error("Python Console did not provide a session token")

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
  const settingsStatus = page.getByRole("status")
  await expect(settingsStatus).toContainText("Settings saved")
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
  external.definition.profile.dispositions.major = {
    disposition: "open",
    reason: null,
  }
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
  await expectDesktopViewport(page, 1024, 768)
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
  writeFileSync(
    join(managedOrigin, "RELEASE.md"),
    "# Requirements\n\nSecurity credential handling MUST remain deterministic.\n"
  )
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
  const provenanceResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/concepts"
  )
  await page.getByRole("button", { name: "Concepts" }).click()
  const provenanceApi = await provenanceResponse
  expect(provenanceApi.status()).toBe(200)
  await expect(
    page.getByRole("heading", { level: 1, name: "Concept provenance" })
  ).toBeVisible()
  await expect(
    page.getByText("Source Unit", { exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByText("Evidence Reference", { exact: true }).first()
  ).toBeVisible()
  const definingNode = page.locator('button[aria-label*="defining"]').first()
  await definingNode.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("region", { name: "Node details" })
  ).toContainText("fixture:")
  await page.screenshot({
    path: "test-results/concepts-desktop-real.png",
    fullPage: true,
  })
  const replayResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/replay"
  )
  await page.getByRole("button", { name: "Replay history" }).click()
  expect((await replayResponse).status()).toBe(200)
  await expect(
    page.getByRole("heading", { level: 1, name: "Concept and impact replay" })
  ).toBeVisible()
  const replayKeyboard = page.getByRole("region", {
    name: "Replay keyboard controls",
  })
  await replayKeyboard.focus()
  await replayKeyboard.press("ArrowRight")
  const replayStatus = page.getByRole("status", {
    name: "Current replay event status",
  })
  await expect(replayStatus).toContainText(/Verified|Accepted/)
  await expect(replayStatus).toHaveAttribute("aria-live", "polite")
  await page.screenshot({
    path: "test-results/replay-desktop-real.png",
    fullPage: true,
  })
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(
    await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
  ).toBe(true)
  await expect(
    page.getByRole("heading", { name: "Ordered replay (reduced motion)" })
  ).toBeVisible()
  expect(
    await page.getByTestId("reduced-replay-event").count()
  ).toBeGreaterThan(0)
  await page.setViewportSize({ width: 390, height: 844 })
  const replayOverflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(replayOverflow.width).toBe(replayOverflow.viewport)
  const replayPagination = page.getByRole("button", {
    name: /^(Previous|Next) (history|path|impact) page$/,
  })
  for (let index = 0; index < (await replayPagination.count()); index += 1) {
    const button = replayPagination.nth(index)
    if (!(await button.isVisible())) continue
    const bounds = await button.boundingBox()
    const layout = await button.evaluate((element) => {
      const footer = element.closest('[data-slot="card-footer"]')
      const card = element.closest('[data-slot="card"]')
      const rect = (target: Element | null) => {
        const value = target?.getBoundingClientRect()
        return value
          ? { left: value.left, right: value.right, width: value.width }
          : null
      }
      return {
        label: element.textContent?.trim(),
        button: rect(element),
        footer: rect(footer),
        card: rect(card),
      }
    })
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(
      bounds!.x + bounds!.width,
      JSON.stringify(layout)
    ).toBeLessThanOrEqual(replayOverflow.viewport)
  }
  await page.screenshot({
    path: "test-results/replay-mobile-reduced-real.png",
    fullPage: true,
  })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole("button", { name: "Back to Concepts" }).click()
  await expect(
    page.getByRole("heading", { level: 1, name: "Concept provenance" })
  ).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  const conceptsMobileSidebar = page.locator(
    '[data-slot="sidebar"][data-mobile="true"]'
  )
  await conceptsMobileSidebar.getByRole("button", { name: "Concepts" }).click()
  await expect(conceptsMobileSidebar).toHaveCount(0)
  const conceptsOverflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
  }))
  expect(conceptsOverflow.width).toBe(conceptsOverflow.viewport)
  await page.screenshot({
    path: "test-results/concepts-mobile-real.png",
    fullPage: true,
  })
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
  const cancelRunTrigger = page
    .getByRole("button", { name: "Cancel Run" })
    .and(page.locator('[aria-haspopup="dialog"]'))
  await cancelRunTrigger.focus()
  await page.keyboard.press("Enter")
  const cancelDialog = page.getByRole("alertdialog")
  await expect(
    cancelDialog.getByText("Cancel this Production Run?")
  ).toBeVisible()
  await expect(cancelDialog).toHaveAccessibleName("Cancel this Production Run?")
  await page.keyboard.press("Escape")
  await expect(cancelRunTrigger).toBeFocused()
  await page.keyboard.press("Enter")
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

  await page.getByRole("button", { name: "Sources" }).focus()
  await page.keyboard.press("Enter")
  await expect(preflightCard).toBeVisible()
  await expect(
    preflightCard.getByRole("button", { name: "Gateway Semantic" })
  ).toHaveAttribute("aria-pressed", "true")
  const readerRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/runs"
  )
  await preflightCard.getByRole("button", { name: "Start Run" }).focus()
  await page.keyboard.press("Enter")
  expect((await readerRunResponse).status()).toBe(200)
  await expect(page.locator('[aria-current="step"]')).toHaveText(
    "Review Required"
  )
  const readerRunId = new URL(page.url()).searchParams.get("run")!
  const readerRunResponseDetail = await page.request.get(
    `${origin}/api/v1/runs/${readerRunId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  expect(readerRunResponseDetail.ok()).toBe(true)
  const readerRun = (await readerRunResponseDetail.json()) as ReleaseRunDetail
  expect(readerRun.sources.map((source) => source.role).sort()).toEqual([
    "documentation",
    "implementation",
  ])
  expect(readerRun.models?.profile.id).toBe("enterprise")
  expect(readerRun.models?.assignments.planner).toBe("model-a")
  expect(readerRun.models?.assignments.verifier).toBe("model-b")

  await page.getByRole("button", { name: "Review", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { level: 1, name: "Review & publish" })
  ).toBeVisible()
  await expectDesktopViewport(page, 1440, 900)
  await expect(page.getByTestId("review-digest")).toHaveText(/[0-9a-f]{64}/)
  const bundleDetailsTrigger = page
    .getByRole("row", { name: /overview\.md Added/ })
    .getByRole("button", { name: "Details" })
  await bundleDetailsTrigger.focus()
  await page.keyboard.press("Enter")
  const bundleDetailsDialog = page.getByRole("dialog")
  await expect(bundleDetailsDialog).toHaveAccessibleName(
    "Generated Bundle detail"
  )
  await expect(bundleDetailsDialog).toContainText(
    "Overview of the fixed source revision."
  )
  await page.keyboard.press("Escape")
  await expect(bundleDetailsTrigger).toBeFocused()

  const approveTrigger = page.getByRole("button", {
    name: "Approve & publish",
  })
  await approveTrigger.focus()
  await page.keyboard.press("Enter")
  const publishDialog = page.getByRole("alertdialog")
  await expect(publishDialog).toHaveAccessibleName("Approve & publish?")
  const cancelPublication = publishDialog.getByRole("button", {
    name: "Cancel",
  })
  const confirmPublication = publishDialog.getByRole("button", {
    name: "Confirm publication",
  })
  await expect(cancelPublication).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(confirmPublication).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(cancelPublication).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(confirmPublication).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(approveTrigger).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(cancelPublication).toBeFocused()
  const approvalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/decision")
  )
  await page.keyboard.press("Tab")
  await expect(confirmPublication).toBeFocused()
  await page.keyboard.press("Enter")
  expect((await approvalResponse).status()).toBe(200)
  await expect(page.getByRole("alert")).toContainText("published atomically")
  expect(existsSync(join(workspace, "published", "overview.md"))).toBe(true)

  const initialKnowledgeResponsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/knowledge"
  )
  const knowledgeTrigger = page.getByRole("button", {
    name: "Knowledge",
    exact: true,
  })
  await knowledgeTrigger.focus()
  await page.keyboard.press("Enter")
  const initialKnowledgeResponse = await initialKnowledgeResponsePromise
  let knowledgeSnapshot: ReleaseKnowledgeSnapshot
  if (initialKnowledgeResponse.ok()) {
    knowledgeSnapshot =
      (await initialKnowledgeResponse.json()) as ReleaseKnowledgeSnapshot
  } else {
    await expect(
      page.getByText("No staged Knowledge Bundle", { exact: true })
    ).toBeVisible()
    const publishedKnowledgeResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/knowledge" &&
        new URL(response.url()).searchParams.get("bundle") === "published"
    )
    const tryPublished = page.getByRole("button", { name: "Try published" })
    await tryPublished.focus()
    await page.keyboard.press("Enter")
    knowledgeSnapshot = (await (
      await publishedKnowledgeResponse
    ).json()) as ReleaseKnowledgeSnapshot
  }
  expect(knowledgeSnapshot.selected.kind).toBe("published")
  expect(knowledgeSnapshot.selected.run_id).toBe(readerRunId)
  expect(knowledgeSnapshot.selected.source_set_digest).toBe(
    readerRun.source_set_digest
  )
  await expect(
    page.getByRole("heading", { level: 1, name: "Knowledge" })
  ).toBeVisible()
  await expectDesktopViewport(page, 1920, 1080)

  const conceptPage = knowledgeSnapshot.pages.find(
    (item) =>
      item.path.startsWith("concepts/") && !item.path.endsWith("/index.md")
  )
  if (!conceptPage) throw new Error("Published Bundle has no Concept page")
  const readerPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname === "/api/v1/knowledge/page" &&
      url.searchParams.get("path") === conceptPage.path
    )
  })
  const conceptPageTrigger = page
    .getByRole("navigation", { name: "Knowledge pages" })
    .getByRole("button", { name: conceptPage.title, exact: true })
  await conceptPageTrigger.focus()
  await page.keyboard.press("Enter")
  const readerPagePayload = (await (
    await readerPageResponse
  ).json()) as ReleaseKnowledgePage
  expect(readerPagePayload.path).toBe(conceptPage.path)
  if (!readerPagePayload.concept_id)
    throw new Error("Published Concept page has no Concept identity")
  const conceptId = readerPagePayload.concept_id
  const claimId = firstClaimId(readerPagePayload.blocks)
  if (!claimId) throw new Error("Published Concept page has no Claim marker")
  await expect(
    page.getByRole("heading", { name: conceptPage.title, exact: true }).first()
  ).toBeVisible()
  await expect(conceptPageTrigger).toHaveAttribute("aria-current", "page")
  expect(
    await contrastRatio(
      page.getByRole("heading", { level: 1, name: "Knowledge" })
    )
  ).toBeGreaterThanOrEqual(3)
  expect(
    await contrastRatio(
      page.getByRole("button", { name: "Ask accepted knowledge" })
    )
  ).toBeGreaterThanOrEqual(4.5)

  const claimResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith("/api/v1/knowledge/claims/")
  )
  const claimSheetTrigger = page
    .getByRole("button", { name: "View accepted Claim" })
    .first()
  await claimSheetTrigger.focus()
  await page.keyboard.press("Enter")
  const readerClaim = (await (
    await claimResponse
  ).json()) as ReleaseKnowledgeClaim
  expect(readerClaim.id).toBe(claimId)
  const claimSheet = page.getByRole("dialog")
  await expect(claimSheet).toHaveAccessibleName("Accepted Claim")
  await expect(claimSheet).toContainText(readerClaim.statement)
  const evidence = readerClaim.evidence[0]
  if (!evidence?.excerpt)
    throw new Error("Published Claim has no resolved Evidence excerpt")
  const readerSource = readerRun.sources.find(
    (source) => source.id === evidence.source_id
  )
  if (!readerSource)
    throw new Error("Published Claim Evidence is outside the fixed Source Set")
  expect(evidence.revision).toBe(readerSource.revision)
  await page.keyboard.press("Escape")
  await expect(claimSheetTrigger).toBeFocused()

  const evidenceText = evidence.excerpt
  const evidenceId = evidence.id
  const evidenceDigest = evidence.digest
  const readerPagePath = conceptPage.path
  const readerPage = join(workspace, "published", readerPagePath)
  expect(existsSync(readerPage)).toBe(true)
  queryFixture = {
    conceptId,
    claimId,
    evidenceId,
    sourceId: evidence.source_id,
    sourcePath: evidence.path,
    sourceText: evidenceText,
    startLine: evidence.start_line,
    endLine: evidence.end_line,
  }
  const publicKnowledgeBeforeQuery = await publicKnowledgeState(
    page,
    origin,
    token,
    readerRunId,
    readerPagePath,
    claimId
  )
  const persistenceBeforeQuery = authoritativePersistenceState(
    readerRunId,
    readerPage
  )
  const askKnowledgeTrigger = page.getByRole("button", {
    name: "Ask accepted knowledge",
  })
  await askKnowledgeTrigger.focus()
  await page.keyboard.press("Enter")
  let queryDialog = page.getByRole("dialog")
  await expect(queryDialog).toHaveAccessibleName("Ask accepted knowledge")
  await page.keyboard.press("Escape")
  await expect(askKnowledgeTrigger).toBeFocused()
  await page.keyboard.press("Enter")
  queryDialog = page.getByRole("dialog")
  await expect(
    queryDialog.getByRole("button", { name: "Current page" })
  ).toHaveAttribute("aria-pressed", "true")
  const conceptQueryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/knowledge/query"
  )
  await queryDialog
    .getByLabel("Ask a question")
    .fill("What accepted knowledge is on this page?")
  await queryDialog.getByRole("button", { name: "Ask", exact: true }).focus()
  await page.keyboard.press("Enter")
  const conceptResponse = await conceptQueryResponse
  expect(conceptResponse.status()).toBe(200)
  expect(conceptResponse.request().postDataJSON()).toMatchObject({
    scope: "concept",
    page: readerPagePath,
    concept_id: conceptId,
  })
  await expect(
    queryDialog.getByText(readerClaim.statement, { exact: true })
  ).toBeVisible()
  await expect(queryDialog.getByText(claimId, { exact: true })).toBeVisible()
  await expect(queryDialog.getByText(evidenceId, { exact: true })).toBeVisible()
  await expect(queryDialog.getByText("model-a", { exact: true })).toBeVisible()
  await expect(
    queryDialog.getByText(`Run ${readerRunId}`, { exact: true })
  ).toBeVisible()
  await expect(
    queryDialog.getByText(`Source Set ${readerRun.source_set_digest}`, {
      exact: true,
    })
  ).toBeVisible()
  await expect(
    queryDialog.getByText(`Page ${readerPagePath}`, { exact: true })
  ).toBeVisible()

  await queryDialog.getByRole("button", { name: "Complete bundle" }).focus()
  await page.keyboard.press("Enter")
  const bundleQueryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/knowledge/query"
  )
  await queryDialog
    .getByLabel("Ask a question")
    .fill("What accepted knowledge is in the complete bundle?")
  await queryDialog.getByRole("button", { name: "Ask", exact: true }).focus()
  await page.keyboard.press("Enter")
  expect((await bundleQueryResponse).status()).toBe(200)
  await expect(
    queryDialog.getByText("Complete bundle", { exact: true }).last()
  ).toBeVisible()
  expect(
    await publicKnowledgeState(
      page,
      origin,
      token,
      readerRunId,
      readerPagePath,
      claimId
    )
  ).toEqual(publicKnowledgeBeforeQuery)
  expect(authoritativePersistenceState(readerRunId, readerPage)).toBe(
    persistenceBeforeQuery
  )
  const queryAudit = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps({'columns':[row[1] for row in c.execute('pragma table_info(query_audit)')],'rows':c.execute('select * from query_audit order by rowid').fetchall()}))",
      join(workspace, ".okf-wiki", "runs.db"),
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  )
  expect(JSON.parse(queryAudit).columns).toEqual([
    "id",
    "model",
    "usage_json",
    "latency_ms",
    "outcome",
    "cited_claim_ids_json",
    "cited_evidence_ids_json",
  ])
  expect(JSON.parse(queryAudit).rows).toHaveLength(2)
  expect(queryAudit).not.toContain("What accepted knowledge")
  expect(queryAudit).not.toContain(readerClaim.statement)

  const investigationQuestion = "Which source-only detail remains provisional?"
  let sourceInvestigationPosts = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/source-investigations"
    )
      sourceInvestigationPosts += 1
  })
  const unsupportedQueryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/knowledge/query"
  )
  await queryDialog.getByLabel("Ask a question").fill(investigationQuestion)
  await queryDialog.getByRole("button", { name: "Ask", exact: true }).focus()
  await page.keyboard.press("Enter")
  expect((await unsupportedQueryResponse).status()).toBe(200)
  await expect(
    queryDialog.getByText(
      "Accepted knowledge does not contain enough support for this part of the question."
    )
  ).toBeVisible()
  const publicKnowledgeBeforeInvestigation = await publicKnowledgeState(
    page,
    origin,
    token,
    readerRunId,
    readerPagePath,
    claimId
  )
  const persistenceBeforeInvestigation = authoritativePersistenceState(
    readerRunId,
    readerPage
  )
  await queryDialog.getByRole("button", { name: "Investigate source" }).focus()
  await page.keyboard.press("Enter")
  const investigationDialog = page.getByRole("dialog")
  await expect(investigationDialog).toHaveAccessibleName(
    "Investigate fixed sources"
  )
  await expect(
    investigationDialog.getByRole("heading", {
      name: "Investigate fixed sources",
    })
  ).toBeVisible()
  await expect(
    investigationDialog.getByLabel("Source investigation question")
  ).toHaveValue(investigationQuestion)
  expect(sourceInvestigationPosts).toBe(0)

  const sourceInvestigationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/source-investigations"
  )
  await investigationDialog
    .getByRole("button", { name: "Investigate fixed sources", exact: true })
    .focus()
  await page.keyboard.press("Enter")
  const investigationResponse = await sourceInvestigationResponse
  expect(investigationResponse.status()).toBe(200)
  expect(investigationResponse.request().postDataJSON()).toEqual({
    question: investigationQuestion,
    run_id: readerRunId,
    source_set_digest: readerRun.source_set_digest,
  })
  await expect(
    investigationDialog.getByText(evidenceText, { exact: true })
  ).toBeVisible()
  await expect(
    investigationDialog.getByText(
      `${readerSource.id}@${readerSource.revision}/${evidence.path}#L${evidence.start_line}-L${evidence.end_line}`,
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    investigationDialog.getByText(evidenceDigest, { exact: true })
  ).toBeVisible()
  await expect(
    investigationDialog
      .getByText("Provisional · not part of Knowledge Bundle", {
        exact: true,
      })
      .first()
  ).toBeVisible()
  await expect(
    investigationDialog.getByText(`Run ${readerRunId}`, { exact: true }).first()
  ).toBeVisible()
  await expect(
    investigationDialog
      .getByText(`Source Set ${readerRun.source_set_digest}`, { exact: true })
      .first()
  ).toBeVisible()
  await expect(
    investigationDialog.getByText("model-a", { exact: true })
  ).toBeVisible()
  await expect(
    investigationDialog.getByText(
      `Source ${readerSource.id}@${readerSource.revision}`,
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    investigationDialog.getByText(/Investigation content is not persisted/)
  ).toBeVisible()
  await expect(
    investigationDialog.getByRole("button", { name: /accept/i })
  ).toHaveCount(0)
  expect(sourceInvestigationPosts).toBe(1)
  expect(
    await publicKnowledgeState(
      page,
      origin,
      token,
      readerRunId,
      readerPagePath,
      claimId
    )
  ).toEqual(publicKnowledgeBeforeInvestigation)
  expect(authoritativePersistenceState(readerRunId, readerPage)).toBe(
    persistenceBeforeInvestigation
  )

  const investigationAudit = execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps({'columns':[row[1] for row in c.execute('pragma table_info(source_investigation_audit)')],'rows':c.execute('select * from source_investigation_audit order by rowid').fetchall()}))",
      join(workspace, ".okf-wiki", "runs.db"),
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  )
  const parsedInvestigationAudit = JSON.parse(investigationAudit)
  expect(parsedInvestigationAudit.columns).toEqual([
    "id",
    "run_id",
    "source_set_digest",
    "model",
    "usage_json",
    "latency_ms",
    "outcome",
    "source_ids_json",
    "citations_json",
  ])
  expect(parsedInvestigationAudit.rows).toHaveLength(1)
  expect(parsedInvestigationAudit.rows[0].slice(1, 4)).toEqual([
    readerRunId,
    readerRun.source_set_digest,
    "model-a",
  ])
  expect(parsedInvestigationAudit.rows[0][6]).toBe("answered")
  expect(JSON.parse(parsedInvestigationAudit.rows[0][7])).toEqual(
    readerRun.sources.map((source: { id: string }) => source.id).sort()
  )
  expect(JSON.parse(parsedInvestigationAudit.rows[0][8])).toEqual([
    {
      source_id: evidence.source_id,
      revision: evidence.revision,
      path: evidence.path,
      start_line: evidence.start_line,
      end_line: evidence.end_line,
      digest: evidenceDigest,
    },
  ])
  expect(investigationAudit).not.toContain(investigationQuestion)
  expect(investigationAudit).not.toContain(evidenceText)
  await page.screenshot({
    path: "test-results/source-investigation-desktop-real.png",
    fullPage: true,
  })
  const closeInvestigation = investigationDialog.getByRole("button", {
    name: "Close",
  })
  await closeInvestigation.focus()
  await page.keyboard.press("Enter")
  await expect(investigationDialog).toHaveCount(0)

  await page.reload()
  await expect(
    page.getByRole("heading", { name: conceptPage.title, exact: true }).first()
  ).toBeVisible()
  await expectDesktopViewport(page, 1920, 1080)
  await askKnowledgeTrigger.focus()
  await page.keyboard.press("Enter")
  queryDialog = page.getByRole("dialog")
  await expect(queryDialog).toHaveAccessibleName("Ask accepted knowledge")
  await expect(
    queryDialog.getByText("What accepted knowledge is on this page?")
  ).toHaveCount(0)
  await expect(
    queryDialog.getByText("What accepted knowledge is in the complete bundle?")
  ).toHaveCount(0)
  const closeQuery = queryDialog.getByRole("button", { name: "Close" })
  await closeQuery.focus()
  await page.keyboard.press("Enter")
  await expect(askKnowledgeTrigger).toBeFocused()

  await context.setOffline(true)
  const sourceMode = page.getByRole("button", { name: "Source", exact: true })
  await sourceMode.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByLabel("Generated Markdown source")).toContainText(
    readerClaim.statement
  )
  await expect(page.getByLabel("Generated Markdown source")).toContainText(
    claimId
  )
  const renderedMode = page.getByRole("button", {
    name: "Rendered",
    exact: true,
  })
  await renderedMode.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: conceptPage.title, exact: true }).first()
  ).toBeVisible()
  await context.setOffline(false)

  await expectDesktopViewport(page, 1024, 768)
  const sourcesTrigger = page.getByRole("button", {
    name: "Sources",
    exact: true,
  })
  await sourcesTrigger.focus()
  await page.keyboard.press("Enter")
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

function authoritativePersistenceState(runId: string, pagePath: string) {
  return execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      `import hashlib,json,os,pathlib,sqlite3,sys
database,run_id,page_path=sys.argv[1:]
c=sqlite3.connect(database)
excluded={"schema_migrations","query_audit","source_investigation_audit"}
tables=[row[0] for row in c.execute("select name from sqlite_master where type='table' order by name") if not row[0].startswith("sqlite_") and row[0] not in excluded]
row=c.execute("select state,source_set_json,coverage_json,error,staging_dir,publish_dir from runs where id=?",(run_id,)).fetchone()
assert row
def tree(root):
    root=pathlib.Path(root)
    return {path.relative_to(root).as_posix():({"symlink":os.readlink(path)} if path.is_symlink() else {"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}) for path in sorted(root.rglob("*")) if path.is_file() or path.is_symlink()}
staging=pathlib.Path(row[4])
published=pathlib.Path(row[5])
payload={"run":row[:4],"tables":{table:c.execute(f'select * from "{table}" order by rowid').fetchall() for table in tables},"page":hashlib.sha256(pathlib.Path(page_path).read_bytes()).hexdigest(),"staged":{"target":str(staging.resolve()),"tree":tree(staging)},"published":{"link":os.readlink(published) if published.is_symlink() else None,"target":str(published.resolve()),"tree":tree(published.resolve())}}
print(json.dumps(payload,sort_keys=True))`,
      join(workspace, ".okf-wiki", "runs.db"),
      runId,
      pagePath,
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  ).trim()
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
