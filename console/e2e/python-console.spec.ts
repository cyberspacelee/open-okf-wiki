import { expect, test } from "@playwright/test"
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(process.cwd(), "..")
let consoleProcess: ChildProcessWithoutNullStreams
let sessionUrl: string
let workspace: string

test.beforeAll(async () => {
  workspace = mkdtempSync(resolve(tmpdir(), "okf-wiki-console-"))
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
    { cwd: repoRoot, stdio: "pipe" }
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
})

test("loads the built Console through the real Python launcher", async ({
  page,
}) => {
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
  await page.getByRole("button", { name: "Settings" }).click()
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

  const localSettingsPath = join(workspace, ".okf-wiki", "settings.toml")
  writeFileSync(
    localSettingsPath,
    readFileSync(localSettingsPath, "utf-8").replace(
      "[models]\n",
      '[models]\napi_key = "removed-secret"\n'
    )
  )
  await page.getByRole("link", { name: "Overview" }).click()
  await page.getByRole("button", { name: "Settings" }).click()
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
