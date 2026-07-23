import { expect, test } from "@playwright/test";
import { createTempGitRepo, uniqueWorkspaceRoot } from "./helpers";

test.describe("add git source", () => {
  test("adds a local git checkout as a source", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const gitRepo = createTempGitRepo("app");
    const sourceId = "appsrc";
    const name = `E2E Source WS ${Date.now()}`;

    // Create workspace via UI
    await page.goto("/workspaces");
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible({ timeout: 20_000 });

    // Navigate to sources
    await page.getByTestId("workspace-subnav-sources").click();
    await expect(page.getByTestId("sources-page")).toBeVisible();

    await page.getByTestId("source-path-input").fill(gitRepo);
    await page.getByTestId("source-id-input").fill(sourceId);
    await page.getByTestId("source-add-submit").click();

    await expect(page.getByTestId("source-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-list")).toContainText(sourceId);
    await expect(page.getByTestId("source-list")).toContainText(gitRepo);
  });
});
