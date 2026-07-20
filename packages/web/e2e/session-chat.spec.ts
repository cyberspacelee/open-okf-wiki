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

    // Assistant plan text + decision chips (workflow suspend → data-choice)
    await expect(page.getByText(/proposed wiki plan/i).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByTestId("session-message-text").first()).toBeVisible({
      timeout: 10_000,
    });

    // Dynamic decision chips (approve | deny)
    await expect(page.getByTestId("session-decision").first()).toBeVisible({
      timeout: 15_000,
    });
    const chips = page.getByTestId("session-decision").first().locator("button");
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThanOrEqual(2);

    const writeChip = page.getByTestId("session-choice-approve");
    if ((await writeChip.count()) > 0) {
      await writeChip.click();
    } else {
      await chips.filter({ hasText: /write/i }).first().click();
    }

    // After plan approve: write then publication gate (not the plan "page(s)" copy)
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
    await expect(page.getByText(/Published Wiki|published/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });
});
