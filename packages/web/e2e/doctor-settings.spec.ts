import { test, expect } from "@playwright/test";
import { setChecked } from "./helpers";

test.describe("doctor / global settings", () => {
  test("shows models panel, doctor, and health ok after check", async ({ page }) => {
    await page.goto("/settings");

    await expect(page.getByTestId("global-settings-page")).toBeVisible();
    await expect(page.getByTestId("provider-panel")).toBeVisible();
    await expect(page.getByTestId("model-add")).toBeVisible();

    await expect(page.getByTestId("doctor-panel")).toBeVisible();
    await expect(page.getByTestId("doctor-status")).toHaveText("ok");

    await expect(page.getByTestId("health-panel")).toBeVisible();
    await page.getByRole("button", { name: /run health check/i }).click();
    await expect(page.getByTestId("health-status")).toHaveText(/^ok · /);
  });

  test("adds a model profile and persists after reload", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("provider-panel")).toBeVisible();

    await page.getByTestId("model-add").click();
    await expect(page.getByTestId("model-editor")).toBeVisible();

    const name = `E2E Model ${Date.now()}`;
    await page.getByTestId("model-name-input").fill(name);
    await page.getByTestId("model-id-input").fill("openai/e2e-probe-model");
    await page.getByTestId("model-base-url").fill("https://e2e-gateway.example.com/v1");
    await setChecked(page, "model-shape-responses", true);
    await page.getByTestId("model-api-key").fill("sk-e2e-test-key-not-real");
    await page.getByTestId("model-save").click();

    await expect(page.getByTestId("settings-status")).toContainText(/model added/i, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("models-table")).toContainText(name);
    await expect(page.getByTestId("models-table")).toContainText("openai/e2e-probe-model");

    await page.reload();
    await expect(page.getByTestId("models-table")).toContainText(name);
    await expect(page.getByTestId("models-table")).toContainText("responses");
  });

  test("sidebar can collapse and expand", async ({ page }) => {
    await page.goto("/workspaces");
    const sidebar = page.getByTestId("app-sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");

    await page.getByTestId("sidebar-toggle").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");

    await page.getByTestId("sidebar-toggle").click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });
});
