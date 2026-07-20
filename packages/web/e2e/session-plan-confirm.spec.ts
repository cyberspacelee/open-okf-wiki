import { test, expect } from "@playwright/test";
import { createTempGitRepo, uniqueWorkspaceRoot } from "./helpers";

test.describe("session plan-confirm + timeline", () => {
  test("planConfirm pauses for approval then writes and shows timeline parts", async ({
    page,
  }) => {
    const rootPath = uniqueWorkspaceRoot();
    const gitRepo = createTempGitRepo("plan-src");
    const name = `E2E PlanConfirm ${Date.now()}`;

    await page.goto("/workspaces");
    await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });

    // Enable plan confirm
    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.getByTestId("settings-plan-confirm").check();
    await page.getByTestId("settings-save").click();
    await expect(page.getByRole("status")).toContainText(/saved/i, { timeout: 10_000 });

    await page.getByTestId("workspace-subnav-sources").click();
    await page.getByTestId("source-path-input").fill(gitRepo);
    await page.getByTestId("source-id-input").fill("appsrc");
    await page.getByTestId("source-add-submit").click();
    await expect(page.getByTestId("source-list")).toContainText("appsrc", {
      timeout: 15_000,
    });

    await page.getByTestId("workspace-subnav-run").click();
    await expect(page.getByTestId("run-page")).toBeVisible();
    await page.getByTestId("run-start").click();

    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_plan",
      { timeout: 25_000 },
    );
    await expect(page.getByTestId("session-plan-card")).toBeVisible();
    await expect(page.getByTestId("session-timeline")).toBeVisible();
    // Plan phase emits markdown text part
    await expect(page.getByTestId("session-markdown").first()).toBeVisible({
      timeout: 10_000,
    });

    const approvePlan = page.getByTestId("run-approve-plan");
    await expect(approvePlan).toBeVisible();
    await expect(approvePlan).toBeEnabled();
    // Force avoids rare detach races while SSE replay refreshes the run list.
    await approvePlan.click({ force: true });

    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("run-pages-list")).toContainText("overview.md");
    // Publish HITL available after write phase.
    await expect(page.getByTestId("run-publish-actions")).toBeVisible();
    // Timeline still present (plan-phase markdown and/or write-phase parts).
    await expect(page.getByTestId("session-timeline")).toBeVisible();
  });
});
