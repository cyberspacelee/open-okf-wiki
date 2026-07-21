import { test, expect } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
  expectVisibleBox,
} from "./helpers";

test.describe("Session chatbot (AI Elements)", () => {
  test("generate plan, render markdown/tool, choose dynamic option", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await createWorkspaceViaUi(page, "E2E SessionChat");
    const gitRepo = createTempGitRepo("sess-src");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-session").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("session-conversation")).toBeVisible();
    await expectVisibleBox(page.getByTestId("session-input"));

    // Kick off plan (Session forces plan gate via wiki-run workflow)
    await page.getByTestId("session-input").fill("generate a wiki plan");
    await page.getByTestId("session-send").click();

    // Fixture agent trajectory: tool card + text stream before/at plan gate (ADR 0026)
    await expect(page.getByTestId("session-tool-part").first()).toBeVisible({
      timeout: 45_000,
    });
    // Specialized tool card (list_source in plan phase)
    await expect(
      page.locator('[data-testid="session-tool-part"][data-tool-name]').first(),
    ).toBeVisible({ timeout: 10_000 });
    // Product phase progress (data-progress), not only raw workflow JSON
    await expect(page.getByTestId("session-phase-progress").first()).toBeVisible({
      timeout: 45_000,
    });
    // Short plan prompt (full body is data-plan card, not duplex markdown)
    await expect(page.getByText(/wiki plan/i).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByTestId("session-message-text").first()).toBeVisible({
      timeout: 10_000,
    });

    // Structured plan card + page checklist + fullscreen markdown reader
    await expect(page.getByTestId("session-plan-card").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("session-plan-pages").first()).toBeVisible();
    await expect(page.getByTestId("session-plan-pages-count").first()).toBeVisible();
    await expect(page.getByTestId("session-plan-markdown").first()).toBeVisible();
    await page.getByTestId("session-plan-fullscreen").first().click();
    await expect(page.getByTestId("session-plan-fullscreen-dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    // Dynamic decision chips (approve | request changes | deny)
    await expect(page.getByTestId("session-decision").first()).toBeVisible({
      timeout: 15_000,
    });
    const chips = page.getByTestId("session-decision").first().locator("button");
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("session-choice-revise")).toBeVisible();
    // Plan gate allows free-text revision (not locked like publish)
    await expect(page.getByTestId("session-input")).toBeEnabled();
    await expect(page.getByTestId("session-plan-revise-hint")).toBeVisible();

    // Third path: request changes → free-text revise → new plan with concepts.md
    await page.getByTestId("session-choice-revise").click();
    await expect(page.getByTestId("session-plan-revise-hint")).toBeVisible();
    await page.getByTestId("session-input").fill("add a concepts page");
    await page.getByTestId("session-send").click();

    await expect(page.getByText(/revising the wiki plan|wiki plan/i).first()).toBeVisible({
      timeout: 45_000,
    });
    // Fixture revise adds concepts.md to the structured plan card
    await expect(
      page.getByTestId("session-plan-markdown").filter({ hasText: /concepts\.md/i }).first(),
    ).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("session-choice-approve")).toBeVisible({
      timeout: 15_000,
    });

    const writeChip = page.getByTestId("session-choice-approve");
    await writeChip.click();

    // After plan approve: write then publication gate
    await expect(page.getByText(/Publish the staged wiki/i).first()).toBeVisible({
      timeout: 90_000,
    });

    // choice_only publish gate: free text disabled
    await expect(page.getByTestId("session-composer-locked")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("session-input")).toBeDisabled();
    await expect(page.getByTestId("session-send")).toBeDisabled();

    // Publish via workflow resume (approve)
    const publishChip = page.getByTestId("session-choice-approve");
    await expect(publishChip).toBeVisible({ timeout: 15_000 });
    await publishChip.click();
    await expect(
      page
        .getByText(/Published Wiki|published|atomically|completed/i)
        .or(page.getByTestId("session-status").filter({ hasText: /completed/i }))
        .first(),
    ).toBeVisible({
      timeout: 90_000,
    });
  });
});
