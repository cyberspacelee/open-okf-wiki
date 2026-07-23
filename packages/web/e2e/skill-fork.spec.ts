import { test, expect } from "@playwright/test";
import { uniqueWorkspaceRoot } from "./helpers";

test.describe("skill fork settings", () => {
  test("creates a skill fork and shows digest", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const name = `E2E SkillFork ${Date.now()}`;

    await page.goto("/workspaces");
    await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.getByTestId("settings-tab-skill").click();
    await expect(page.getByTestId("settings-skill-panel")).toBeVisible();

    // Default is home (~/.agents/skills) or package when home skills off
    await expect(page.getByTestId("settings-skill-kind")).toHaveText(
      /^(home|package)$/,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("settings-skill-digest")).toBeVisible();

    await page.getByTestId("settings-skill-fork").click();
    await expect(page.getByTestId("settings-skill-kind")).toHaveText("fork", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("settings-skill-file-editor")).toBeVisible();

    // Edit and save SKILL.md
    await page.getByTestId("settings-skill-file-editor").fill(
      "---\nname: forked-skill\ndescription: e2e fork\n---\n# Forked\n",
    );
    await page.getByTestId("settings-skill-save-file").click();
    // Digest should still be shown after save
    await expect(page.getByTestId("settings-skill-digest")).toBeVisible();

    await page.getByTestId("settings-skill-reset").click();
    await expect(page.getByTestId("settings-skill-kind")).toHaveText(
      /^(home|package)$/,
      { timeout: 15_000 },
    );
  });
});
