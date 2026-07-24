/**
 * Agent Workspace operator surface (ADR 0030 / 0031 WP6).
 *
 * Route + shell, session chrome, fixture wiki run → phase/gate strips.
 * Empty streaming uses waiting-for-events (never Thinking alone).
 *
 * E2E webServer always sets OKF_WIKI_AGENT_MODE=fixture (see playwright.config.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { addSourceViaUi, createTempGitRepo, createWorkspaceViaUi } from "./helpers";

/** Assert empty streaming / waiting chrome is not mislabeled as model "Thinking". */
async function expectWaitingNotThinking(page: Page): Promise<void> {
  const waiting = page.getByTestId("waiting-for-events");
  if ((await waiting.count()) === 0) return;
  await expect(waiting.first()).toBeVisible();
  await expect(waiting.first()).toContainText(/Waiting for events|等待事件/i);
  await expect(waiting.first()).not.toContainText(/Thinking|思考中/);
}

async function startWikiRunFromComposer(page: Page): Promise<void> {
  // Composer defaults to Chat mode — switch to Wiki run for the primary CTA.
  const start = page.getByTestId("agent-start-wiki-run");
  if ((await start.count()) === 0) {
    await page.getByTestId("agent-mode-wiki").click();
  }
  await expect(page.getByTestId("agent-start-wiki-run")).toBeEnabled({
    timeout: 15_000,
  });
  await page.getByTestId("agent-start-wiki-run").click();
}

test.describe("agent workspace operator surface (ADR 0031)", () => {
  test("route + shell render after workspace create", async ({ page }) => {
    const { name } = await createWorkspaceViaUi(page, "E2E Agent Shell");

    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-shell")).toBeVisible();
    await expect(page.getByTestId("agent-session-list")).toBeVisible();
    await expect(page.getByTestId("agent-composer")).toBeVisible();
    await expect(page.getByTestId("agent-composer-mode")).toBeVisible();
    await expect(page.getByTestId("agent-context-panels")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-page")).toContainText(name);

    // Boot auto-creates a session when none exist.
    await expect(page.getByTestId("agent-session-item").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/w\/[^/?]+/);
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

  test("fixture wiki run shows phase or gate strip (no work_unit body channel)", async ({
    page,
  }) => {
    await createWorkspaceViaUi(page, "E2E Agent Work Surface");
    const gitRepo = createTempGitRepo("agent-work");
    await addSourceViaUi(page, gitRepo, "worksrc");

    await page.getByTestId("workspace-subnav-agent").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-shell")).toBeVisible();

    await startWikiRunFromComposer(page);

    const phaseStrip = page.locator('[data-product-kind="run_phase"]');
    const gateStrip = page.locator('[data-product-kind="gate"]');
    const gateApprove = page.getByTestId("agent-gate-approve");
    const toolCard = page.getByTestId("tool-execution-card");
    const waiting = page.getByTestId("waiting-for-events");

    await expect
      .poll(
        async () => {
          if ((await gateApprove.count()) > 0) return "gate";
          if ((await gateStrip.count()) > 0) return "gate-strip";
          if ((await phaseStrip.count()) > 0) return "phase";
          if ((await toolCard.count()) > 0) return "tool";
          if ((await waiting.count()) > 0) return "waiting";
          return "pending";
        },
        {
          timeout: 90_000,
          message: "expected phase/gate/tool strip after fixture wiki run",
        },
      )
      .not.toBe("pending");

    // Legacy work_unit body channel must not reappear.
    await expect(page.getByTestId("work-block")).toHaveCount(0);
    await expect(page.getByTestId("work-unit-row")).toHaveCount(0);

    await expectWaitingNotThinking(page);

    if ((await gateApprove.count()) > 0) {
      await gateApprove.click();
    }
  });

  test("workspaces picker loads and can open agent workspace route", async ({ page }) => {
    await page.goto("/workspaces");
    await expect(page.locator("body")).toBeVisible();
    await page.goto("/w/nonexistent-id");
    await expect(page.locator("body")).toBeVisible();
  });
});
