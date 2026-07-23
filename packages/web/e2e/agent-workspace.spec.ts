/**
 * Agent Workspace operator surface (ADR 0030 / 0031 UI cut).
 *
 * Route + shell, session chrome, fixture wiki run → Work block,
 * unit row empty-state contract (waiting-for-events, never Thinking alone).
 *
 * E2E webServer always sets OKF_WIKI_AGENT_MODE=fixture (see playwright.config.ts).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
} from "./helpers";

/** Assert unit expand empty-state is not mislabeled as model "Thinking" / 「思考中」. */
async function expectUnitEmptyStateNotThinking(page: Page): Promise<void> {
  const row = page.getByTestId("work-unit-row").first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  const waiting = page.getByTestId("waiting-for-events");
  const waitingCount = await waiting.count();
  if (waitingCount > 0) {
    await expect(waiting.first()).toBeVisible();
    await expect(waiting.first()).toContainText(/Waiting for events|等待事件/i);
    await expect(waiting.first()).not.toContainText(/Thinking|思考中/);
    return;
  }

  const text = (await row.innerText()).replace(/\s+/g, " ").trim();
  const thinkingOnly =
    /^(Thinking…?|思考中…?|Reasoning…?|推理中…?)$/i.test(text);
  expect(
    thinkingOnly,
    `work-unit empty state must not be Thinking/Reasoning alone; got: ${JSON.stringify(text.slice(0, 200))}`,
  ).toBe(false);
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

    const active = page.locator(
      '[data-testid="agent-session-item"][data-active="true"]',
    );
    await expect(active).toHaveCount(1);

    const inactive = page.locator(
      '[data-testid="agent-session-item"][data-active="false"]',
    );
    if ((await inactive.count()) > 0) {
      await inactive.first().click();
      await expect(
        page.locator('[data-testid="agent-session-item"][data-active="true"]'),
      ).toHaveCount(1);
    }
  });

  test("fixture wiki run shows Work block; unit row is not Thinking-only empty", async ({
    page,
  }) => {
    await createWorkspaceViaUi(page, "E2E Agent Work Surface");
    const gitRepo = createTempGitRepo("agent-work");
    await addSourceViaUi(page, gitRepo, "worksrc");

    await page.getByTestId("workspace-subnav-agent").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-shell")).toBeVisible();

    await startWikiRunFromComposer(page);

    const workBlock = page.getByTestId("work-block");
    const workUnit = page.getByTestId("work-unit-row");
    const gateApprove = page.getByTestId("agent-gate-approve");

    await expect
      .poll(
        async () => {
          if ((await workUnit.count()) > 0) return "units";
          if ((await gateApprove.count()) > 0) return "gate";
          return "pending";
        },
        {
          timeout: 90_000,
          message: "expected work-unit-row or HITL gate after fixture wiki run",
        },
      )
      .not.toBe("pending");

    if ((await workUnit.count()) === 0 && (await gateApprove.count()) > 0) {
      await gateApprove.click();
    }

    await expect(workBlock.first()).toBeVisible({ timeout: 90_000 });
    await expect(workUnit.first()).toBeVisible({ timeout: 30_000 });

    await workUnit.first().click();
    await expectUnitEmptyStateNotThinking(page);
  });

  test("workspaces picker loads and can open agent workspace route", async ({
    page,
  }) => {
    await page.goto("/workspaces");
    await expect(page.locator("body")).toBeVisible();
    await page.goto("/w/nonexistent-id");
    await expect(page.locator("body")).toBeVisible();
  });
});
