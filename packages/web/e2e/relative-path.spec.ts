import { expect, test } from "@playwright/test";

test.describe("relative path rejected", () => {
  test("create with relative rootPath shows error banner", async ({ page }) => {
    await page.goto("/workspaces");
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    await expect(page.getByTestId("workspace-create-form")).toBeVisible();

    await page.getByTestId("workspace-name-input").fill("Relative Root WS");
    await page.getByTestId("workspace-root-input").fill("relative/not-absolute");
    await page.getByTestId("workspace-create-submit").click();

    await expect(page.getByTestId("error-banner")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("error-banner")).toContainText(/absolute|rootPath|400/i);
    // Should stay on workspaces page, not navigate away
    await expect(page.getByTestId("workspaces-page")).toBeVisible();
  });
});
