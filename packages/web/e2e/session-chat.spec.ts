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

    // Kick off plan
    await page.getByTestId("session-input").fill("generate a wiki plan");
    await page.getByTestId("session-send").click();

    // Assistant markdown (Streamdown via MessageResponse)
    await expect(page.getByRole("heading", { name: /proposed wiki plan/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("session-message-text").first()).toBeVisible({
      timeout: 10_000,
    });

    // Tool card from Elements
    await expect(page.getByText(/list_source/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Completed|Running/i).first()).toBeVisible();

    // Dynamic decision chips
    await expect(page.getByTestId("session-decision").first()).toBeVisible({
      timeout: 15_000,
    });
    const chips = page.getByTestId("session-decision").first().locator("button");
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThanOrEqual(2);

    // Prefer structured approve_write option id
    const writeChip = page.getByTestId("session-choice-approve_write");
    if ((await writeChip.count()) > 0) {
      await writeChip.click();
    } else {
      await chips.filter({ hasText: /write/i }).first().click();
    }

    // Next assistant turn after choice — real staging materialize
    await expect(page.getByText(/staged|writing|publish/i).first()).toBeVisible({
      timeout: 30_000,
    });

    // choice_only publish gate: free text disabled
    await expect(page.getByTestId("session-composer-locked")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("session-input")).toBeDisabled();
    await expect(page.getByTestId("session-send")).toBeDisabled();

    // Publish via product gate (choice_only chip)
    const publishChip = page.getByTestId("session-choice-publish_now");
    await expect(publishChip).toBeVisible({ timeout: 10_000 });
    await publishChip.click();
    await expect(page.getByText(/publish/i).first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
