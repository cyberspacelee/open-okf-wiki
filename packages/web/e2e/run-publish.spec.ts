import { test, expect } from "@playwright/test";
import { createTempGitRepo, uniqueWorkspaceRoot } from "./helpers";

async function setupWorkspaceWithSource(
  page: import("@playwright/test").Page,
  namePrefix: string,
): Promise<void> {
  const rootPath = uniqueWorkspaceRoot();
  const gitRepo = createTempGitRepo("pub-src");
  const name = `${namePrefix} ${Date.now()}`;

  await page.goto("/workspaces");
  await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-root-input").fill(rootPath);
  await page.getByTestId("workspace-create-submit").click();
  await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("workspace-subnav-sources").click();
  await expect(page.getByTestId("sources-page")).toBeVisible();
  await page.getByTestId("source-path-input").fill(gitRepo);
  await page.getByTestId("source-id-input").fill("appsrc");
  await page.getByTestId("source-add-submit").click();
  await expect(page.getByTestId("source-list")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("source-list")).toContainText("appsrc");

  await page.getByTestId("workspace-subnav-run").click();
  await expect(page.getByTestId("run-page")).toBeVisible();
}

test.describe("run publication HITL", () => {
  test("approve publish moves awaiting_publication to published", async ({ page }) => {
    await setupWorkspaceWithSource(page, "E2E Pub Approve");

    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 20_000 },
    );

    // Publication review controls and pages list
    await expect(page.getByTestId("run-publish-actions")).toBeVisible();
    await expect(page.getByTestId("run-approve")).toBeVisible();
    await expect(page.getByTestId("run-deny")).toBeVisible();
    await expect(page.getByTestId("run-pages-list")).toBeVisible();
    await expect(page.getByTestId("run-pages-list")).toContainText("overview.md");

    await page.getByTestId("run-approve").click();
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "published",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("run-list")).toContainText("Published");
    // Actions should disappear once no longer awaiting publication.
    await expect(page.getByTestId("run-publish-actions")).toHaveCount(0);
  });

  test("deny publication moves awaiting_publication to publication_declined", async ({
    page,
  }) => {
    await setupWorkspaceWithSource(page, "E2E Pub Deny");

    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 20_000 },
    );

    await page.getByTestId("run-deny").click();
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "publication_declined",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("run-list")).toContainText("Publication declined");
    await expect(page.getByTestId("run-publish-actions")).toHaveCount(0);
  });
});
