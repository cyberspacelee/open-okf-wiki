import { test, expect } from "@playwright/test";
import {
  addSourceViaUi,
  createTempGitRepo,
  createWorkspaceViaUi,
} from "./helpers";

test.describe("session plan-confirm + timeline", () => {
  test("Session plan gate then write and publish (HITL only on Session)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await createWorkspaceViaUi(page, "E2E PlanConfirm");
    const gitRepo = createTempGitRepo("plan-src");
    await addSourceViaUi(page, gitRepo);

    await page.getByTestId("workspace-subnav-session").click();
    await expect(page.getByTestId("session-chat-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("session-input").fill("generate a wiki plan");
    await page.getByTestId("session-send").click();

    await expect(page.getByTestId("session-tool-part").first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByTestId("session-plan-card").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("session-choice-approve")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("session-choice-approve").click();

    await expect(page.getByText(/Publish the staged wiki/i).first()).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByTestId("session-choice-approve")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("session-choice-approve").click();
    await expect(page.getByText(/Published Wiki|published/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });
});
