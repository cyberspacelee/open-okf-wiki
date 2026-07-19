import { test, expect } from "@playwright/test";
import { uniqueWorkspaceRoot } from "./helpers";

test.describe("workspace settings", () => {
  test("saves name and model id and persists after reload", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const originalName = `E2E Settings WS ${Date.now()}`;
    const updatedName = `${originalName} Renamed`;
    const updatedModel = "openai/e2e-model-id";

    await page.goto("/workspaces");
    await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
    await page.getByTestId("workspace-name-input").fill(originalName);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();

    await page.getByTestId("settings-name-input").fill(updatedName);
    await page.getByTestId("settings-model-input").fill(updatedModel);
    await page.getByTestId("settings-save").click();

    await expect(page.getByRole("status")).toContainText(/saved/i);

    await page.reload();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("settings-name-input")).toHaveValue(updatedName);
    await expect(page.getByTestId("settings-model-input")).toHaveValue(updatedModel);
  });
});
