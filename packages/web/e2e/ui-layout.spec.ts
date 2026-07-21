import { test, expect } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
  expectVisibleBox,
} from "./helpers";

test.describe("UI layout smoke — Session / Settings skill / Sources", () => {
  test("desktop: sources dual forms, skill panel, session timeline layout", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { rootPath } = await createWorkspaceViaUi(page, "E2E Layout");
    const gitRepo = createTempGitRepo("layout-src");
    await addSourceViaUi(page, gitRepo);

    // --- Sources layout ---
    await expect(page.getByTestId("sources-page")).toBeVisible();
    await expectVisibleBox(page.getByTestId("source-list"), { minWidth: 200, minHeight: 40 });
    // ID, Origin, Path, Probe, Ignores, Actions
    await expect(page.getByTestId("source-list").getByRole("columnheader")).toHaveCount(6);
    // Link + clone forms both present with usable controls
    await expectVisibleBox(page.getByTestId("source-path-input"), { minWidth: 120, minHeight: 24 });
    await expectVisibleBox(page.getByTestId("source-remote-input"), {
      minWidth: 120,
      minHeight: 24,
    });
    await expectVisibleBox(page.getByTestId("source-add-submit"));
    await expectVisibleBox(page.getByTestId("source-clone-submit"));
    // Origin column shows path-linked source
    await expect(page.getByTestId("source-list")).toContainText("path");
    // Long mono path should not force page wider than viewport (horizontal overflow)
    const pageScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const pageClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(pageScrollWidth).toBeLessThanOrEqual(pageClientWidth + 2);

    // --- Settings skill layout ---
    await page.getByTestId("workspace-subnav-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expectVisibleBox(page.getByTestId("settings-plan-confirm"));
    await page.getByTestId("settings-tab-skill").click();
    const skillPanel = page.getByTestId("settings-skill-panel");
    await expectVisibleBox(skillPanel, { minWidth: 200, minHeight: 80 });
    await expectVisibleBox(page.getByTestId("settings-skill-kind"));
    await expectVisibleBox(page.getByTestId("settings-skill-digest"));
    await expectVisibleBox(page.getByTestId("settings-skill-fork"));

    await page.getByTestId("settings-skill-fork").click();
    await expect(page.getByTestId("settings-skill-kind")).toHaveText("fork", {
      timeout: 20_000,
    });
    const editor = page.getByTestId("settings-skill-file-editor");
    await expectVisibleBox(editor, { minWidth: 200, minHeight: 80 });
    // Editor should not overflow viewport width
    const editorBox = await editor.boundingBox();
    expect(editorBox!.width).toBeLessThanOrEqual(1280);
    await expectVisibleBox(page.getByTestId("settings-skill-save-file"));
    await expectVisibleBox(page.getByTestId("settings-skill-reset"));

    // --- Runs job console layout ---
    await page.getByTestId("workspace-subnav-run").click();
    await expect(page.getByTestId("run-page")).toBeVisible();
    await expect(page.getByTestId("workspace-breadcrumb")).toContainText("Runs");
    await expect(page.getByTestId("run-page").getByRole("heading", { level: 1 })).toHaveText(
      "Runs",
    );
    await expectVisibleBox(page.getByTestId("run-start"));

    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 25_000 },
    );
    await expectVisibleBox(page.getByTestId("run-event-log"), { minWidth: 120 });
    await expectVisibleBox(page.getByTestId("run-publish-actions"));
    await expectVisibleBox(page.getByTestId("run-approve"));
    // Retry is only for terminal outcomes — not while publication HITL is open.
    await expect(page.getByTestId("run-retry")).toHaveCount(0);
    await expectVisibleBox(page.getByTestId("run-cancel"));

    // --- Session chatbot layout (AI Elements) ---
    await page.getByTestId("workspace-subnav-session").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible();
    await expectVisibleBox(page.getByTestId("session-conversation"), { minWidth: 160 });
    await expectVisibleBox(page.getByTestId("session-input"), { minWidth: 80 });
    await expectVisibleBox(page.getByTestId("session-prompt"), { minWidth: 80 });
    await expect(page.getByTestId("session-list")).toBeVisible();
    await expectVisibleBox(page.getByTestId("session-select"), { minWidth: 80 });
    await expectVisibleBox(page.getByTestId("session-new"), { minWidth: 40 });
    await expect(page.getByTestId("session-delete")).toBeVisible();
    await expect(page.getByTestId("session-slash-open")).toBeVisible();
    // Slash palette opens when typing /
    await page.getByTestId("session-input").fill("/");
    await expect(page.getByTestId("session-slash-menu")).toBeVisible();
    // New session → history switcher has 2 entries; older is read-only
    await page.getByTestId("session-new").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible();
    await expect(page.getByTestId("session-readonly-banner")).toHaveCount(0);
    void rootPath;
  });

  test("mobile 375px: session and sources remain usable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await createWorkspaceViaUi(page, "E2E Mobile");
    const gitRepo = createTempGitRepo("mobile-src");
    await addSourceViaUi(page, gitRepo);

    // Sources: forms still have non-zero size
    await expectVisibleBox(page.getByTestId("source-path-input"), { minWidth: 100 });
    await expectVisibleBox(page.getByTestId("source-remote-input"), { minWidth: 100 });
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(375 + 24); // small tolerance for scrollbars

    await page.getByTestId("workspace-subnav-run").click();
    await expect(page.getByTestId("run-page")).toBeVisible();
    await expectVisibleBox(page.getByTestId("run-start"), { minWidth: 40, minHeight: 24 });
    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 25_000 },
    );
    await expect(page.getByTestId("run-event-log")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("run-publish-actions")).toBeVisible();
    await expect(page.getByTestId("run-approve")).toBeEnabled();
    await expect(page.getByTestId("run-deny")).toBeEnabled();

    await page.getByTestId("workspace-subnav-session").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible();
    await expectVisibleBox(page.getByTestId("session-input"), { minWidth: 60 });
  });

  test("session chatbot layout with dynamic decisions", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await createWorkspaceViaUi(page, "E2E PlanLayout");
    const gitRepo = createTempGitRepo("plan-layout");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-session").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible();
    await page.getByTestId("session-input").fill("generate a wiki plan");
    await page.getByTestId("session-send").click();

    await expect(page.getByRole("heading", { name: /proposed wiki plan/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("session-decision").first()).toBeVisible({
      timeout: 15_000,
    });
    await expectVisibleBox(page.getByTestId("session-decision").first(), {
      minWidth: 100,
      minHeight: 24,
    });
  });
});
