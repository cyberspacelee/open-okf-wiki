import { test, expect } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
} from "./helpers";

test.describe("session history restore", () => {
  test("reload keeps session messages; older thread stays writable", async ({
    page,
  }) => {
    test.setTimeout(120_000);
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
    // Refresh is not read-only history.
    await expect(page.getByTestId("session-readonly-banner")).toHaveCount(0);
    await expect(page.getByTestId("session-input")).toBeEnabled();

    // New session → older remains in switcher; both writable (Codex-class).
    await page.getByTestId("session-new").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible();
    await expect(page.getByTestId("session-readonly-banner")).toHaveCount(0);
    await expect(page.getByTestId("session-input")).toBeEnabled();

    const select = page.getByTestId("session-select");
    await expect(select).toBeVisible();

    // Switch to the other session via select (title · timestamp labels).
    await select.click();
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible({ timeout: 5_000 });
    const count = await options.count();
    if (count > 1) {
      await options.nth(1).click();
    } else {
      await page.keyboard.press("Escape");
    }

    await expect(page.getByTestId("session-input")).toBeEnabled({
      timeout: 10_000,
    });
    await expect(page.getByTestId("session-readonly-banner")).toHaveCount(0);
  });
});
