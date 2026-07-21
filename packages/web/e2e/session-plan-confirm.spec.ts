import { test, expect } from "@playwright/test";
import { createTempGitRepo, setChecked, uniqueWorkspaceRoot } from "./helpers";

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
    await setChecked(page, "settings-plan-confirm", true);
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
      { timeout: 45_000 },
    );
    await expect(page.getByTestId("session-plan-card")).toBeVisible({
      timeout: 15_000,
    });
    // Job event log is the Run console timeline (not Session chat).
    await expect(page.getByTestId("run-event-log")).toBeVisible();

    const approvePlan = page.getByTestId("run-approve-plan");
    await expect(approvePlan).toBeVisible();
    await expect(approvePlan).toBeEnabled();
    await approvePlan.click({ force: true });

    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("run-pages-list")).toContainText("overview.md");
    await expect(page.getByTestId("run-publish-actions")).toBeVisible();
    await expect(page.getByTestId("run-event-log")).toBeVisible();
  });
});
