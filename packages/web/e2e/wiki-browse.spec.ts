import { expect, test } from "@playwright/test";
import { uniqueWorkspaceRoot } from "./helpers";

test.describe("wiki browse", () => {
  test("shows empty state when not published yet", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const name = `E2E Wiki Empty ${Date.now()}`;

    await page.goto("/workspaces");
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("workspace-subnav-wiki").click();
    await expect(page.getByTestId("wiki-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("wiki-empty")).toBeVisible();
  });
});
