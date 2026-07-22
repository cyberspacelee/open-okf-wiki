/**
 * Smoke: Agent Workspace is the primary operate surface (ADR 0030).
 */
import { test, expect } from "@playwright/test";

test("workspaces picker loads and can open agent workspace route", async ({
  page,
}) => {
  await page.goto("/workspaces");
  await expect(page.locator("body")).toBeVisible();
  // Route exists even with empty list.
  await page.goto("/w/nonexistent-id");
  // App should render (error or empty shell), not a blank crash.
  await expect(page.locator("body")).toBeVisible();
});
