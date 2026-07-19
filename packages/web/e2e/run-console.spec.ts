import { test, expect } from "@playwright/test";
import { createTempGitRepo, uniqueWorkspaceRoot } from "./helpers";

test.describe("run console", () => {
  test("starts a fixture run and reaches awaiting_publication", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const gitRepo = createTempGitRepo("run-src");
    const name = `E2E Run WS ${Date.now()}`;

    // Create workspace via UI
    await page.goto("/workspaces");
    await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });

    // Add a git source (required to start a run)
    await page.getByTestId("workspace-subnav-sources").click();
    await expect(page.getByTestId("sources-page")).toBeVisible();
    await page.getByTestId("source-path-input").fill(gitRepo);
    await page.getByTestId("source-id-input").fill("appsrc");
    await page.getByTestId("source-add-submit").click();
    await expect(page.getByTestId("source-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-list")).toContainText("appsrc");

    // Open Run console and start generate
    await page.getByTestId("workspace-subnav-run").click();
    await expect(page.getByTestId("run-page")).toBeVisible();
    await page.getByTestId("run-start").click();

    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 15_000 });
    // Fixture mode completes quickly; UI polls while status is running.
    await expect(page.getByTestId("run-last-status")).toHaveText("awaiting_publication", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("run-list")).toContainText("awaiting_publication");
    // No stub / not-wired failure text.
    await expect(page.getByTestId("run-page")).not.toContainText("Wiki Run agent not wired yet");
  });
});
