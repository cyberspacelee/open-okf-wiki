import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

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
