/**
 * Agent Workspace operator surface (ADR 0030 / 0031 WP6).
 *
 * Route + shell, session chrome, and the sole Pi prompt surface.
 * Empty streaming uses waiting-for-events (never Thinking alone).
 *
 * E2E webServer always sets OKF_WIKI_AGENT_MODE=fixture (see playwright.config.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { addSourceViaUi, createTempGitRepo, createWorkspaceViaUi, setChecked } from "./helpers";

/** Assert empty streaming / waiting chrome is not mislabeled as model "Thinking". */
async function expectWaitingNotThinking(page: Page): Promise<void> {
  const waiting = page.getByTestId("waiting-for-events");
  if ((await waiting.count()) === 0) return;
  await expect(waiting.first()).toBeVisible();
  await expect(waiting.first()).toContainText(/Waiting for events|等待事件/i);
  await expect(waiting.first()).not.toContainText(/Thinking|思考中/);
}

test.describe("agent workspace operator surface (ADR 0032)", () => {
  test("route + shell render after workspace create", async ({ page }) => {
    const { name } = await createWorkspaceViaUi(page, "E2E Agent Shell");

    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-shell")).toBeVisible();
    await expect(page.getByTestId("agent-session-list")).toBeVisible();
    await expect(page.getByTestId("agent-composer")).toBeVisible();
    await expect(page.getByTestId("agent-start-wiki-run")).toHaveCount(0);
    await expect(page.getByTestId("agent-composer-mode")).toHaveCount(0);
    await expect(page.getByTestId("agent-context-panels")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-page")).toContainText(name);

    // Boot auto-creates a session when none exist.
    await expect(page.getByTestId("agent-session-item").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/w\/[^/?]+/);
    await expect(page.getByTestId("workspace-subnav-run")).toHaveCount(0);
  });

  test("legacy independent Run route is not an operator surface", async ({ page }) => {
    await createWorkspaceViaUi(page, "E2E Agent Only");
    const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
    expect(id).toBeTruthy();

    await page.goto(`/workspaces/${encodeURIComponent(id!)}/run`);

    await expect(page.getByTestId("workspace-run-page")).toHaveCount(0);
    await expect(page).toHaveURL(/\/workspaces$/);
  });

  test("can create and select an agent session", async ({ page }) => {
    await createWorkspaceViaUi(page, "E2E Agent Session");

    await expect(page.getByTestId("agent-session-list")).toBeVisible();
    const initial = page.getByTestId("agent-session-item");
    await expect(initial.first()).toBeVisible({ timeout: 15_000 });
    const before = await initial.count();

    await page.getByTestId("agent-session-new").click();
    await expect(page.getByTestId("agent-session-item")).toHaveCount(before + 1, {
      timeout: 15_000,
    });

    const active = page.locator('[data-testid="agent-session-item"][data-active="true"]');
    await expect(active).toHaveCount(1);

    const inactive = page.locator('[data-testid="agent-session-item"][data-active="false"]');
    if ((await inactive.count()) > 0) {
      await inactive.first().click();
      await expect(
        page.locator('[data-testid="agent-session-item"][data-active="true"]'),
      ).toHaveCount(1);
    }
  });

  test("prompt drives the genuine wiki_produce gates and publishes the Wiki", async ({ page }) => {
    test.setTimeout(120_000);
    const { name } = await createWorkspaceViaUi(page, "E2E Agent Produce");
    const source = createTempGitRepo("agent-produce");

    await addSourceViaUi(page, source, "appsrc");
    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await setChecked(page, "settings-plan-confirm", true);
    await page.getByTestId("settings-save").click();
    await expect(page.getByRole("status")).toBeVisible();

    await page.getByTestId("workspace-subnav-agent").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-session-item")).toHaveCount(1);

    const composerInput = page.getByTestId("agent-composer-input");
    const send = page.getByTestId("agent-send");
    const prompt = "Inspect the sources and produce the wiki.";
    await expect(composerInput).toBeEnabled({ timeout: 15_000 });
    await composerInput.fill(prompt);
    await expect(composerInput).toHaveValue(prompt);
    await expect(send).toBeEnabled();
    await send.click();

    const userMessage = page.locator('[data-testid="agent-message"][data-role="user"]');
    await expect(userMessage.last()).toContainText("Inspect the sources", { timeout: 15_000 });
    await expect(page.locator("[data-product-kind]")).toHaveCount(0);
    await expect(page.getByTestId("agent-start-wiki-run")).toHaveCount(0);

    const details = page.getByTestId("wiki-produce-details");
    await expect(details).toHaveAttribute("data-wiki-status", "awaiting_plan", {
      timeout: 45_000,
    });
    await expect(details).toContainText("overview.md");
    await page.reload();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(details).toHaveAttribute("data-wiki-status", "awaiting_plan", {
      timeout: 15_000,
    });
    await expect(details).toContainText("overview.md");
    await page.getByTestId("agent-gate-approve").click();

    await expect(details).toHaveAttribute("data-wiki-status", "awaiting_publication", {
      timeout: 45_000,
    });
    await page.reload();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(details).toHaveAttribute("data-wiki-status", "awaiting_publication", {
      timeout: 15_000,
    });
    await page.getByTestId("agent-gate-approve").click();

    await expect(details).toHaveAttribute("data-wiki-status", "published", {
      timeout: 45_000,
    });
    await expectWaitingNotThinking(page);

    await page.getByTestId("workspace-subnav-wiki").click();
    await expect(page.getByTestId("wiki-page")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("wiki-page-list").getByTestId("wiki-page-link").filter({
        hasText: "overview.md",
      }),
    ).toBeVisible();
    await expect(page.getByTestId("wiki-page-title")).toContainText(name);
    await expect(page.getByTestId("wiki-markdown")).toContainText("fixture mode");
  });

  test("workspaces picker loads and can open agent workspace route", async ({ page }) => {
    await page.goto("/workspaces");
    await expect(page.locator("body")).toBeVisible();
    await page.goto("/w/nonexistent-id");
    await expect(page.locator("body")).toBeVisible();
  });
});
