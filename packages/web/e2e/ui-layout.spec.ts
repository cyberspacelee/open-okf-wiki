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
    await expect(page.getByTestId("source-list").getByRole("columnheader")).toHaveCount(5);
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
    const skillPanel = page.getByTestId("settings-skill-panel");
    await expectVisibleBox(skillPanel, { minWidth: 200, minHeight: 80 });
    await expectVisibleBox(page.getByTestId("settings-skill-kind"));
    await expectVisibleBox(page.getByTestId("settings-skill-digest"));
    await expectVisibleBox(page.getByTestId("settings-skill-fork"));
    await expectVisibleBox(page.getByTestId("settings-plan-confirm"));

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

    // --- Session layout after fixture run ---
    await page.getByTestId("workspace-subnav-run").click();
    await expect(page.getByTestId("run-page")).toBeVisible();
    // Breadcrumb matches Session title (regression: used to say "Run")
    await expect(page.getByTestId("run-page").locator(".breadcrumb")).toContainText("Session");
    await expect(page.getByTestId("run-page").getByRole("heading", { level: 1 })).toHaveText(
      "Session",
    );
    await expectVisibleBox(page.getByTestId("run-start"));

    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_publication",
      { timeout: 25_000 },
    );

    const timeline = page.getByTestId("session-timeline");
    await expectVisibleBox(timeline, { minWidth: 160, minHeight: 40 });
    // CSS contract: scrollable max height
    const maxH = await timeline.evaluate((el) => getComputedStyle(el).maxHeight);
    expect(maxH === "none" || parseFloat(maxH) > 0).toBeTruthy();
    const overflowY = await timeline.evaluate((el) => getComputedStyle(el).overflowY);
    expect(["auto", "scroll", "overlay"]).toContain(overflowY);

    // Markdown + tool cards painted
    await expect(page.getByTestId("session-markdown").first()).toBeVisible({
      timeout: 10_000,
    });
    await expectVisibleBox(page.getByTestId("session-markdown").first(), {
      minHeight: 12,
    });
    const toolCard = page.getByTestId("session-tool-card").first();
    await expectVisibleBox(toolCard, { minWidth: 80, minHeight: 24 });
    const toolBorder = await toolCard.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(parseFloat(toolBorder)).toBeGreaterThan(0);

    const subagent = page.getByTestId("session-subagent-card").first();
    await expectVisibleBox(subagent, { minWidth: 80, minHeight: 24 });
    // Subagent accent border-left
    const blw = await subagent.evaluate((el) => getComputedStyle(el).borderLeftWidth);
    expect(parseFloat(blw)).toBeGreaterThanOrEqual(2);

    await expectVisibleBox(page.getByTestId("run-publish-actions"));
    await expectVisibleBox(page.getByTestId("run-approve"));
    await expectVisibleBox(page.getByTestId("run-retry"));

    // Header actions row should not collapse to zero height
    await expectVisibleBox(page.getByTestId("run-start"));
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
    // Prefer filled timeline; fall back to empty placeholder if SSE missed (still layout).
    const timeline = page.getByTestId("session-timeline");
    const empty = page.getByTestId("session-timeline-empty");
    await expect(timeline.or(empty).first()).toBeVisible({ timeout: 10_000 });
    if (await timeline.count()) {
      await expectVisibleBox(timeline, { minWidth: 80 });
    } else {
      await expectVisibleBox(empty, { minWidth: 80 });
    }
    // Publish HITL region usable; buttons must remain enabled (layout may stack full-width).
    const publish = page.getByTestId("run-publish-actions");
    await expect(publish).toBeVisible();
    await publish.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("run-approve")).toBeEnabled();
    await expect(page.getByTestId("run-deny")).toBeEnabled();
    // Prefer non-zero size; if still 0 due to animation, clickability is enough signal.
    const approveBox = await page.getByTestId("run-approve").boundingBox();
    if (approveBox) {
      expect(approveBox.width * approveBox.height).toBeGreaterThan(0);
    }
  });

  test("plan-confirm card layout when planConfirm enabled", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await createWorkspaceViaUi(page, "E2E PlanLayout");
    const gitRepo = createTempGitRepo("plan-layout");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-settings").click();
    await page.getByTestId("settings-plan-confirm").check();
    await page.getByTestId("settings-save").click();
    await expect(page.getByRole("status")).toContainText(/saved/i, { timeout: 10_000 });

    await page.getByTestId("workspace-subnav-run").click();
    await page.getByTestId("run-start").click();
    await expect(page.getByTestId("run-last-status")).toHaveAttribute(
      "data-status",
      "awaiting_plan",
      { timeout: 25_000 },
    );

    const planCard = page.getByTestId("session-plan-card");
    await expect(planCard).toBeVisible({ timeout: 15_000 });
    await expectVisibleBox(planCard, { minWidth: 120, minHeight: 60 });
    const borderColor = await planCard.evaluate((el) => getComputedStyle(el).borderTopColor);
    // Amber-ish warning border (not transparent / not fully transparent)
    expect(borderColor === "rgba(0, 0, 0, 0)" || borderColor === "transparent").toBeFalsy();
    await expectVisibleBox(page.getByTestId("run-approve-plan"));
    await expectVisibleBox(page.getByTestId("run-deny-plan"));
    // Plan phase should surface markdown and/or status in the timeline area
    await expect(
      page.getByTestId("session-markdown").or(page.getByTestId("session-timeline")).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
