import { test, expect } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
} from "./helpers";

test.describe("session history restore", () => {
  test("reload keeps latest session messages; switcher shows older thread", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await createWorkspaceViaUi(page, "E2E SessionHistory");
    const gitRepo = createTempGitRepo("hist-src");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-session").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("session-input").fill("generate a wiki plan");
    await page.getByTestId("session-send").click();
    await expect(page.getByTestId("session-plan-card").first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByTestId("session-message-text").first()).toBeVisible();

    // URL should carry sessionId for refresh restore
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sessionId"))
      .toBeTruthy();

    await page.reload();
    await expect(page.getByTestId("session-chat-page")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("session-plan-card").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("session-message-text").first()).toBeVisible();

    // New session → older remains in switcher as read-only history
    await page.getByTestId("session-new").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible();
    await expect(page.getByTestId("session-readonly-banner")).toHaveCount(0);

    // Switch back via select if multiple sessions
    const select = page.getByTestId("session-select");
    await expect(select).toBeVisible();
  });
});
