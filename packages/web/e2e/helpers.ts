import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";

/** Unique absolute workspace root under /tmp for parallel-safe e2e runs. */
export function uniqueWorkspaceRoot(prefix = "okf-pw-ws"): string {
  const id = randomBytes(6).toString("hex");
  const root = path.join("/tmp", `${prefix}-${id}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Create a clean local git repo and return its absolute path. */
export function createTempGitRepo(label = "source"): string {
  const root = mkdtempSync(path.join(tmpdir(), `okf-pw-git-${label}-`));
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "e2e@okf-wiki.test"], {
    cwd: root,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: root, stdio: "pipe" });
  writeFileSync(path.join(root, "README.md"), `# ${label}\n`, "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "pipe" });
  return root;
}

/** Create workspace via UI; returns rootPath. */
export async function createWorkspaceViaUi(
  page: Page,
  namePrefix: string,
): Promise<{ rootPath: string; name: string }> {
  const rootPath = uniqueWorkspaceRoot();
  const name = `${namePrefix} ${Date.now()}`;
  await page.goto("/workspaces");
  await page.getByRole("button", { name: /^create( workspace)?$/i }).first().click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-root-input").fill(rootPath);
  await page.getByTestId("workspace-create-submit").click();
  await expect(page.getByTestId("workspace-detail")).toBeVisible({ timeout: 20_000 });
  return { rootPath, name };
}

/** Add a local git source on the Sources page (caller must be on workspace). */
export async function addSourceViaUi(
  page: Page,
  gitRepo: string,
  sourceId = "appsrc",
): Promise<void> {
  await page.getByTestId("workspace-subnav-sources").click();
  await expect(page.getByTestId("sources-page")).toBeVisible();
  await page.getByTestId("source-path-input").fill(gitRepo);
  await page.getByTestId("source-id-input").fill(sourceId);
  await page.getByTestId("source-add-submit").click();
  await expect(page.getByTestId("source-list")).toContainText(sourceId, {
    timeout: 15_000,
  });
}

/**
 * Layout smoke: element is painted with non-zero size.
 * Uses scrollIntoView + getBoundingClientRect fallback (boundingBox can be null
 * when partially outside viewport or during layout thrash).
 */
export async function expectVisibleBox(
  locator: Locator,
  opts?: { minWidth?: number; minHeight?: number },
): Promise<void> {
  await expect(locator).toBeVisible();
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
  } catch {
    // Detached/re-render races: fall through to size checks.
  }
  const minW = opts?.minWidth ?? 8;
  const minH = opts?.minHeight ?? 8;
  // Re-query visibility after possible re-render.
  await expect(locator).toBeVisible({ timeout: 5_000 });
  const box = await locator.boundingBox();
  if (box) {
    expect(box.width).toBeGreaterThan(minW);
    expect(box.height).toBeGreaterThan(minH);
    return;
  }
  const rect = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  expect(rect.width, "getBoundingClientRect width").toBeGreaterThan(minW);
  expect(rect.height, "getBoundingClientRect height").toBeGreaterThan(minH);
}
