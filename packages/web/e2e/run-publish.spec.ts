import { test, expect } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
} from "./helpers";

/**
 * Run console is read-mostly (ADR 0026). Human publish HITL lives on Session.
 * Headless start still creates a job log; gates point operators to Session.
 */
test.describe("run console (logs only)", () => {
  test("headless start shows logs and Session gate hint, no publish buttons", async ({
    page,
  }) => {
    await createWorkspaceViaUi(page, "E2E Run Logs");
    const gitRepo = createTempGitRepo("pub-src");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-run").click();
    await expect(page.getByTestId("run-page")).toBeVisible();

    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 45_000 },
    );

    await expect(page.getByTestId("run-event-log")).toBeVisible();
    await expect(page.getByTestId("run-pages-list")).toContainText("overview.md");
    await expect(page.getByTestId("run-session-gate-hint")).toBeVisible();
    await expect(page.getByTestId("run-open-session-gate")).toBeVisible();
    // No human HITL on Run
    await expect(page.getByTestId("run-approve")).toHaveCount(0);
    await expect(page.getByTestId("run-deny")).toHaveCount(0);
    await expect(page.getByTestId("run-publish-actions")).toHaveCount(0);
  });

  test("Session path publishes end-to-end", async ({ page }) => {
    await createWorkspaceViaUi(page, "E2E Pub Session");
    const gitRepo = createTempGitRepo("pub-sess");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-session").click();
    await page.getByTestId("session-input").fill("generate a wiki plan");
    await page.getByTestId("session-send").click();
    await expect(page.getByTestId("session-choice-approve")).toBeVisible({
      timeout: 45_000,
    });
    await page.getByTestId("session-choice-approve").click();
    await expect(page.getByText(/Publish the staged wiki/i).first()).toBeVisible({
      timeout: 90_000,
    });
    await page.getByTestId("session-choice-approve").click();
    await expect(page.getByText(/Published Wiki|published/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });
});
