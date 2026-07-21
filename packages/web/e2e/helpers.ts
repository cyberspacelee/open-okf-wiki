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

/**
 * Select an option from a native `<select>` **or** a shadcn/Base UI Select
 * (trigger + listbox). `optionText` matches option label text, or for native
 * selects also exact `value`.
 *
 * Dual-path so Phase 2 can swap ModelSelect / wiki language without rewriting
 * every call site at once.
 */
export async function chooseOption(
  page: Page,
  testId: string,
  optionText: string | RegExp,
): Promise<void> {
  const control = page.getByTestId(testId);
  await expect(control).toBeVisible();

  const tagName = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tagName === "select") {
    if (typeof optionText === "string") {
      const matched = await control.evaluate((el, text) => {
        const select = el as HTMLSelectElement;
        for (const opt of Array.from(select.options)) {
          if (opt.text.trim() === text || opt.label.trim() === text) {
            return { label: opt.label || opt.text };
          }
        }
        for (const opt of Array.from(select.options)) {
          if (opt.value === text) {
            return { value: opt.value };
          }
        }
        return null;
      }, optionText);
      if (!matched) {
        throw new Error(
          `chooseOption: no <option> matching ${JSON.stringify(optionText)} on [data-testid="${testId}"]`,
        );
      }
      await control.selectOption(matched);
      return;
    }

    const matched = await control.evaluate((el, pattern) => {
      const select = el as HTMLSelectElement;
      const re = new RegExp(pattern.source, pattern.flags);
      for (const opt of Array.from(select.options)) {
        if (re.test(opt.text) || re.test(opt.label) || re.test(opt.value)) {
          return { value: opt.value };
        }
      }
      return null;
    }, { source: optionText.source, flags: optionText.flags });
    if (!matched) {
      throw new Error(
        `chooseOption: no <option> matching ${optionText} on [data-testid="${testId}"]`,
      );
    }
    await control.selectOption(matched);
    return;
  }

  // shadcn / Base UI Select: open trigger, pick listbox option by accessible name
  await control.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible({ timeout: 5_000 });
  const option = listbox.getByRole("option", { name: optionText });
  await option.click();
}

/**
 * Set checked state on native checkbox/radio **or** ARIA checkbox/switch/radio
 * (shadcn Checkbox / Switch / RadioGroup item).
 */
export async function setChecked(
  page: Page,
  testId: string,
  checked: boolean,
): Promise<void> {
  const control = page.getByTestId(testId);
  await expect(control).toBeVisible();

  const kind = await control.evaluate((el) => {
    if (el instanceof HTMLInputElement) {
      return { native: true as const, type: el.type, isChecked: el.checked };
    }
    const role = el.getAttribute("role");
    const ariaChecked = el.getAttribute("aria-checked");
    const dataChecked = el.hasAttribute("data-checked");
    const dataState = el.getAttribute("data-state");
    const isChecked =
      ariaChecked === "true" ||
      dataChecked ||
      dataState === "checked" ||
      dataState === "on";
    return {
      native: false as const,
      role,
      isChecked,
    };
  });

  if (kind.native && (kind.type === "checkbox" || kind.type === "radio")) {
    if (checked) {
      await control.check();
    } else if (kind.type === "checkbox") {
      await control.uncheck();
    }
    // radio cannot be unchecked via UI; ignore checked=false
    return;
  }

  if (kind.isChecked !== checked) {
    await control.click();
  }
}

export type ConfirmDestructiveOptions = {
  dialogTestId: string;
  confirmTestId: string;
  metaTestId?: string;
  metaChecked?: boolean;
};

/**
 * Confirm an AlertDialog (or any dialog with stable testids). Optionally
 * toggle a meta checkbox first (delete-meta pattern).
 */
export async function confirmDestructive(
  page: Page,
  opts: ConfirmDestructiveOptions,
): Promise<void> {
  const dialog = page.getByTestId(opts.dialogTestId);
  await expect(dialog).toBeVisible();

  if (opts.metaTestId != null && opts.metaChecked != null) {
    await setChecked(page, opts.metaTestId, opts.metaChecked);
  }

  await page.getByTestId(opts.confirmTestId).click();
}
