import { test, expect } from "@playwright/test";
import { chooseOption, uniqueWorkspaceRoot } from "./helpers";

test.describe("workspace settings", () => {
  test("selects configured model from dropdown and persists", async ({ page }) => {
    // 1. Create two models in Settings
    await page.goto("/settings");
    await page.getByTestId("model-add").click();
    await page.getByTestId("model-name-input").fill("Alpha Model");
    await page.getByTestId("model-id-input").fill("openai/alpha-model");
    await page.getByTestId("model-base-url").fill("https://alpha.example/v1");
    await page.getByTestId("model-save").click();
    await expect(page.getByTestId("settings-status")).toContainText(/model added/i);

    await page.getByTestId("model-add").click();
    await page.getByTestId("model-name-input").fill("Beta Model");
    await page.getByTestId("model-id-input").fill("openai/beta-model");
    await page.getByTestId("model-base-url").fill("https://beta.example/v1");
    await page.getByTestId("model-save").click();
    await expect(page.getByTestId("settings-status")).toContainText(/model added/i);

    // 2. Create workspace selecting Beta
    const rootPath = uniqueWorkspaceRoot();
    const originalName = `E2E Settings WS ${Date.now()}`;
    const updatedName = `${originalName} Renamed`;

    await page.goto("/workspaces");
    await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
    await page.getByTestId("workspace-name-input").fill(originalName);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await chooseOption(page, "model-profile-select", /Beta Model/);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("workspace-detail")).toContainText("openai/beta-model");

    // 3. Switch to Alpha in workspace settings
    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.getByTestId("settings-name-input").fill(updatedName);
    await chooseOption(page, "settings-model-select", /Alpha Model/);
    await page.getByTestId("settings-save").click();
    await expect(page.getByRole("status")).toContainText(/saved/i);

    await page.reload();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("settings-name-input")).toHaveValue(updatedName);
    await expect(page.getByTestId("settings-model-input")).toHaveValue("openai/alpha-model");

    // Adaptive/reviewer toggles removed (ADR 0028); plan confirm remains.
    await expect(page.getByTestId("settings-adaptive")).toHaveCount(0);
    await expect(page.getByTestId("settings-reviewer")).toHaveCount(0);
    await expect(page.getByTestId("settings-plan-confirm")).toBeVisible();
  });
});
