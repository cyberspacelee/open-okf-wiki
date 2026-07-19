import { test, expect } from "@playwright/test";
import { createTempGitRepo, uniqueWorkspaceRoot } from "./helpers";

test.describe("published wiki browse", () => {
  test("lists overview.md and shows title after approve publish", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const gitRepo = createTempGitRepo("wiki-src");
    const name = `E2E Wiki Browse ${Date.now()}`;

    // 1. Create workspace + git source + fixture run + approve publish
    await page.goto("/workspaces");
    await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("workspace-subnav-sources").click();
    await expect(page.getByTestId("sources-page")).toBeVisible();
    await page.getByTestId("source-path-input").fill(gitRepo);
    await page.getByTestId("source-id-input").fill("wikisrc");
    await page.getByTestId("source-add-submit").click();
    await expect(page.getByTestId("source-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-list")).toContainText("wikisrc");

    await page.getByTestId("workspace-subnav-run").click();
    await expect(page.getByTestId("run-page")).toBeVisible();
    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 20_000 },
    );
    await page.getByTestId("run-approve").click();
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "published",
      { timeout: 15_000 },
    );

    // 2. Open Wiki tab
    await page.getByTestId("workspace-subnav-wiki").click();
    await expect(page.getByTestId("wiki-page")).toBeVisible({ timeout: 15_000 });

    // 3. See overview.md in list and content with title
    const list = page.getByTestId("wiki-page-list");
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(list.getByTestId("wiki-page-link").filter({ hasText: "overview.md" })).toBeVisible();

    const content = page.getByTestId("wiki-page-content");
    await expect(content).toBeVisible();
    await expect(page.getByTestId("wiki-page-title")).toContainText(name);
    await expect(page.getByTestId("wiki-markdown")).toContainText("fixture mode");
  });

  test("shows empty state when not published yet", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const name = `E2E Wiki Empty ${Date.now()}`;

    await page.goto("/workspaces");
    await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("workspace-subnav-wiki").click();
    await expect(page.getByTestId("wiki-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("wiki-empty")).toBeVisible();
    await expect(page.getByTestId("wiki-empty")).toContainText(/not published/i);
  });
});
