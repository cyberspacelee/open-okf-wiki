import { test, expect } from "@playwright/test";

test.describe("doctor / global settings", () => {
  test("shows doctor panel and health ok after check", async ({ page }) => {
    await page.goto("/settings");

    await expect(page.getByTestId("global-settings-page")).toBeVisible();
    await expect(page.getByTestId("doctor-panel")).toBeVisible();
    // Exact badge text — avoid substring "ok" matching "not ok".
    await expect(page.getByTestId("doctor-status")).toHaveText("ok");

    await expect(page.getByTestId("health-panel")).toBeVisible();
    await page.getByRole("button", { name: /run health check/i }).click();
    await expect(page.getByTestId("health-status")).toHaveText(/^ok · /);

    await page.getByTestId("doctor-refresh").click();
    await expect(page.getByTestId("doctor-panel")).toBeVisible();
    await expect(page.getByTestId("doctor-status")).toHaveText("ok");
  });
});
