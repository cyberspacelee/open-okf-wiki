import { expect, test } from "@playwright/test";
import {
  addSourceViaUi,
  chooseOption,
  createTempGitRepo,
  createWorkspaceViaUi,
  setChecked,
} from "./helpers";

async function setLocale(page: import("@playwright/test").Page, locale: "en" | "zh") {
  await page.goto("/workspaces");
  await page.evaluate((value) => localStorage.setItem("okf-wiki.locale", value), locale);
  await page.reload();
  await expect(page.getByTestId("workspaces-page")).toBeVisible();
}

test.describe("workspace delete, wiki language, ignore rules", () => {
  test("locale switch updates nav labels", async ({ page }) => {
    await setLocale(page, "en");
    await expect(page.getByTestId("nav-workspaces")).toContainText("Workspaces");

    await page.getByTestId("locale-switch").click();
    await expect(page.getByTestId("nav-workspaces")).toContainText("工作区");
    await expect(page.getByTestId("workspaces-page").locator("h1")).toContainText("工作区");

    await page.getByTestId("locale-switch").click();
    await expect(page.getByTestId("nav-workspaces")).toContainText("Workspaces");
  });

  test("sets wiki language and source ignore presets", async ({ page }) => {
    await setLocale(page, "en");
    const { rootPath } = await createWorkspaceViaUi(page, "E2E Lang Ignore");
    const gitRepo = createTempGitRepo("java-app");

    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await chooseOption(page, "settings-wiki-language", /Chinese|中文/i);
    await page.getByTestId("settings-save").click();
    await expect(page.getByRole("status")).toContainText(/saved|已保存/i);

    await page.reload();
    await expect(page.getByTestId("settings-wiki-language")).toHaveAttribute("data-value", "zh");

    await addSourceViaUi(page, gitRepo, "appsrc");
    await page.getByTestId("source-edit-ignores-appsrc").click();
    await expect(page.getByTestId("source-ignore-editor")).toBeVisible();
    await page.getByTestId("preset-java-tests").click();
    await expect(page.getByTestId("source-ignore-text")).toContainText("**/*Test.java");
    await page.getByTestId("source-ignore-save").click();
    // java-tests preset adds 6 patterns
    await expect(page.getByTestId("source-list")).toContainText(/6 custom|6 条自定义/);

    expect(rootPath).toBeTruthy();
  });

  test("deletes workspace from list", async ({ page }) => {
    await setLocale(page, "en");
    const { name } = await createWorkspaceViaUi(page, "E2E Delete WS");

    await page.goto("/workspaces");
    await expect(page.getByTestId("workspace-list")).toContainText(name);

    const row = page.locator('[data-testid="workspace-row"]').filter({ hasText: name });
    await row.getByTestId("workspace-delete").click();
    await expect(page.getByTestId("workspace-delete-dialog")).toBeVisible();
    // Meta uses shadcn Checkbox (role=checkbox), not native input.
    await setChecked(page, "workspace-delete-meta", true);
    await page.getByTestId("workspace-delete-confirm").click();

    await expect(
      page.locator('[data-testid="workspace-row"]').filter({ hasText: name }),
    ).toHaveCount(0, { timeout: 15_000 });
  });
});
