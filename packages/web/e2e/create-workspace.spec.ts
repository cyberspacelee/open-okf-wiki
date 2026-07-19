import { test, expect } from "@playwright/test";
import { uniqueWorkspaceRoot } from "./helpers";

test.describe("create workspace", () => {
  test("creates workspace with absolute root and lands on detail", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const name = `E2E Workspace ${Date.now()}`;

    await page.goto("/workspaces");
    await expect(page.getByTestId("workspaces-page")).toBeVisible();

    // Open create form (header Create or empty-state button)
    const createToggle = page.getByRole("button", { name: /^create( workspace)?$/i }).first();
    await createToggle.click();
    await expect(page.getByTestId("workspace-create-form")).toBeVisible();

    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();

    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("workspace-detail")).toContainText(name);
    await expect(page.getByTestId("workspace-detail")).toContainText(rootPath);
  });
});
