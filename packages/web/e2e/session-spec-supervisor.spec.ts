import { test, expect } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
} from "./helpers";

/**
 * Fixture-mode Session path: Spec plan card → produce → publish.
 * Asserts plan-gate still works after WikiRunSpec / supervisor-tree refactor (ADR 0028).
 */
test.describe("session Spec + supervisor shell", () => {
  test("plan Spec card, approve, produce, publish", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await createWorkspaceViaUi(page, "E2E Spec Supervisor");
    const gitRepo = createTempGitRepo("spec-src");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-overview").click();
    await expect(page.getByTestId("workspace-detail")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("workspace-detail")).toContainText(
      /Supervisor tree|监督者树/i,
    );

    await page.getByTestId("workspace-subnav-session").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("session-input").fill("generate a wiki plan");
    await page.getByTestId("session-send").click();

    await expect(page.getByTestId("session-plan-card").first()).toBeVisible({
      timeout: 45_000,
    });
    // Spec-oriented plan markdown (audience / pages).
    await expect(
      page
        .getByTestId("session-plan-card")
        .first()
        .getByText(/Proposed wiki Spec|Pages|Audience|overview\.md/i)
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("session-choice-approve")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("session-choice-approve").click();

    // Fixture produce emits phase strip, pages queue, sources, defects.
    await expect(page.getByTestId("session-run-phase-strip").first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("session-pages-queue").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("session-defects-card").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("session-sources-panel").first()).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText(/Publish the staged wiki/i).first()).toBeVisible({
      timeout: 90_000,
    });
    await page.getByTestId("session-choice-approve").click();
    await expect(
      page
        .getByText(/Published Wiki|published|atomically|completed/i)
        .or(page.getByTestId("session-status").filter({ hasText: /completed/i }))
        .first(),
    ).toBeVisible({
      timeout: 90_000,
    });
  });
});
