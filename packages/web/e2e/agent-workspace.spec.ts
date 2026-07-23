/**
 * Agent Workspace operator surface (ADR 0030 / 0031).
 *
 * Beyond smoke: route + shell, session chrome, fixture wiki run → Work chip,
 * and work-unit drawer empty-state contract (waiting-for-events, never Thinking alone).
 *
 * E2E webServer always sets OKF_WIKI_AGENT_MODE=fixture (see playwright.config.ts).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
} from "./helpers";

/** Assert drawer empty-state is not mislabeled as model "Thinking" / 「思考中」. */
async function expectDrawerEmptyStateNotThinking(page: Page): Promise<void> {
  const drawer = page.getByTestId("work-unit-drawer");
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  const waiting = drawer.getByTestId("waiting-for-events");
  const waitingCount = await waiting.count();
  if (waitingCount > 0) {
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText(/Waiting for events|等待事件/i);
    // Waiting chip must not also claim "Thinking" / 「思考中」 as its label.
    await expect(waiting).not.toContainText(/Thinking|思考中/);
    return;
  }

  // Unit has body (text / tools / summary / fallback). Forbidden: sole empty label is Thinking.
  const text = (await drawer.innerText()).replace(/\s+/g, " ").trim();
  const thinkingOnly =
    /^(Thinking…?|思考中…?)$/i.test(text) ||
    /^(Thinking…?|思考中…?)\s*$/i.test(text);
  expect(
    thinkingOnly,
    `work-unit drawer empty state must not be Thinking/思考中 alone; got: ${JSON.stringify(text.slice(0, 200))}`,
  ).toBe(false);
}

test.describe("agent workspace operator surface (ADR 0031)", () => {
  test("route + shell render after workspace create", async ({ page }) => {
    const { name } = await createWorkspaceViaUi(page, "E2E Agent Shell");

    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-shell")).toBeVisible();
    await expect(page.getByTestId("agent-session-list")).toBeVisible();
    await expect(page.getByTestId("agent-composer")).toBeVisible();
    await expect(page.getByTestId("agent-start-wiki-run")).toBeVisible();
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

    // Newly created session is active.
    const active = page.locator(
      '[data-testid="agent-session-item"][data-active="true"]',
    );
    await expect(active).toHaveCount(1);

    // Select the other session if present.
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

  test("fixture wiki run shows Work chip; unit drawer is not Thinking-only empty", async ({
    page,
  }) => {
    await createWorkspaceViaUi(page, "E2E Agent Work Surface");
    const gitRepo = createTempGitRepo("agent-work");
    await addSourceViaUi(page, gitRepo, "worksrc");

    await page.getByTestId("workspace-subnav-agent").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await expect(page.getByTestId("agent-workspace-shell")).toBeVisible();
    await expect(page.getByTestId("agent-start-wiki-run")).toBeEnabled({
      timeout: 15_000,
    });

    await page.getByTestId("agent-start-wiki-run").click();

    // Fixture produce (OKF_WIKI_AGENT_MODE=fixture) emits parent-visible work_unit
    // injects that fold into a Work chip. Default planConfirm=false runs produce
    // before the publication gate — units should appear without a plan approve.
    // If a plan gate is configured, approve once so produce can continue.
    const workChip = page.getByTestId("work-run-chip");
    const workAgent = page.getByTestId("work-run-agent");
    const gateApprove = page.getByTestId("agent-gate-approve");

    await expect
      .poll(
        async () => {
          if ((await workAgent.count()) > 0) return "units";
          if ((await gateApprove.count()) > 0) return "gate";
          return "pending";
        },
        {
          timeout: 90_000,
          message: "expected work-run-agent or HITL gate after fixture wiki run",
        },
      )
      .not.toBe("pending");

    if ((await workAgent.count()) === 0 && (await gateApprove.count()) > 0) {
      await gateApprove.click();
    }

    await expect(workChip.first()).toBeVisible({ timeout: 90_000 });
    await expect(workAgent.first()).toBeVisible({ timeout: 30_000 });

    await workAgent.first().click();
    await expectDrawerEmptyStateNotThinking(page);
    await page.keyboard.press("Escape");
  });

  test("workspaces picker loads and can open agent workspace route", async ({
    page,
  }) => {
    await page.goto("/workspaces");
    await expect(page.locator("body")).toBeVisible();
    // Route exists even with empty list / unknown id.
    await page.goto("/w/nonexistent-id");
    await expect(page.locator("body")).toBeVisible();
  });
});
