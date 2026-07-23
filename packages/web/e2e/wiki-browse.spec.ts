import { expect, test } from "@playwright/test";
import { createTempGitRepo, uniqueWorkspaceRoot } from "./helpers";

test.describe("published wiki browse", () => {
  test("lists overview.md and shows title after Agent Workspace publish", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const gitRepo = createTempGitRepo("wiki-src");
    const name = `E2E Wiki Browse ${Date.now()}`;

    await page.goto("/workspaces");
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("workspace-subnav-sources").click();
    await expect(page.getByTestId("sources-page")).toBeVisible();
    await page.getByTestId("source-path-input").fill(gitRepo);
    await page.getByTestId("source-id-input").fill("wikisrc");
    await page.getByTestId("source-add-submit").click();
    await expect(page.getByTestId("source-list")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("source-list")).toContainText("wikisrc");

    // Publish via Agent Workspace (ADR 0026 — sole human HITL surface)
    await page.getByTestId("workspace-subnav-agent").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible();
    await page.getByTestId("agent-mode-wiki").click();
    await page.getByTestId("agent-start-wiki-run").click();

    // Fixture may present plan and/or publication gates (workspace planConfirm).
    // Approve every gate that appears until publish completes or wiki is ready.
    for (let i = 0; i < 4; i += 1) {
      const approve = page.getByTestId("agent-gate-approve");
      const published = page.getByText(/Published Wiki|published|atomically|completed|done/i);
      const state = await Promise.race([
        approve
          .first()
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(() => "gate" as const)
          .catch(() => "none" as const),
        published
          .first()
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(() => "published" as const)
          .catch(() => "none" as const),
      ]);
      if (state === "published") break;
      if (state === "gate") {
        await approve.first().click();
        continue;
      }
      break;
    }
    await expect(
      page.getByText(/Published Wiki|published|atomically|completed|done/i).first(),
    ).toBeVisible({
      timeout: 90_000,
    });

    await page.getByTestId("workspace-subnav-wiki").click();
    await expect(page.getByTestId("wiki-page")).toBeVisible({ timeout: 15_000 });

    const list = page.getByTestId("wiki-page-list");
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(
      list.getByTestId("wiki-page-link").filter({ hasText: "overview.md" }),
    ).toBeVisible();

    const content = page.getByTestId("wiki-page-content");
    await expect(content).toBeVisible();
    await expect(page.getByTestId("wiki-page-title")).toContainText(name);
    await expect(page.getByTestId("wiki-markdown")).toContainText("fixture mode");
  });

  test("shows empty state when not published yet", async ({ page }) => {
    const rootPath = uniqueWorkspaceRoot();
    const name = `E2E Wiki Empty ${Date.now()}`;

    await page.goto("/workspaces");
    await page
      .getByRole("button", { name: /^create( workspace)?$/i })
      .first()
      .click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-root-input").fill(rootPath);
    await page.getByTestId("workspace-create-submit").click();
    await expect(page.getByTestId("agent-workspace-page")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("workspace-subnav-wiki").click();
    await expect(page.getByTestId("wiki-page")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("wiki-empty")).toBeVisible();
  });
});
