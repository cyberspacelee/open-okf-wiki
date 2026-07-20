import { spawn } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { GitProbe } from "@okf-wiki/contract";
import { isPathInside } from "./paths.js";

/** Dest must be strictly inside parent (not equal). */
function isStrictlyInside(parent: string, child: string): boolean {
  if (path.resolve(parent) === path.resolve(child)) {
    return false;
  }
  return isPathInside(parent, child);
}

function runGit(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options?.timeoutMs;
    const timer =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            if (!settled) {
              child.kill("SIGTERM");
            }
          }, timeoutMs)
        : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      settled = true;
      resolve({ code: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      settled = true;
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * Inspect a local path with the host `git` binary. No network operations.
 */
export async function probeLocalGit(rawPath: string): Promise<GitProbe> {
  const resolved = path.resolve(rawPath);
  try {
    await access(resolved);
  } catch {
    return {
      path: resolved,
      isGit: false,
      head: null,
      branch: null,
      dirty: false,
      error: "path does not exist or is not accessible",
    };
  }

  const inside = await runGit(resolved, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout !== "true") {
    return {
      path: resolved,
      isGit: false,
      head: null,
      branch: null,
      dirty: false,
      error: inside.stderr || "not a git working tree",
    };
  }

  const head = await runGit(resolved, ["rev-parse", "HEAD"]);
  const branch = await runGit(resolved, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await runGit(resolved, ["status", "--porcelain"]);

  if (head.code !== 0) {
    return {
      path: resolved,
      isGit: true,
      head: null,
      branch: null,
      dirty: false,
      error: head.stderr || "failed to read HEAD",
    };
  }

  return {
    path: resolved,
    isGit: true,
    head: head.stdout,
    branch: branch.code === 0 ? branch.stdout : null,
    dirty: status.stdout.length > 0,
    error: null,
  };
}

/** Default subdirectory under workspace root for product-managed clones. */
export const WORKSPACE_SOURCES_DIR_NAME = "sources";

export type CloneIntoWorkspaceInput = {
  /** Absolute workspace rootPath (agent cwd / project home). */
  workspaceRoot: string;
  /** Remote URL (https/ssh/git). Never stored as a secret; may appear in origin.remoteUrl. */
  remoteUrl: string;
  /** Source id slug; also default directory name under sources/. */
  sourceId: string;
  /**
   * Optional relative directory under workspace root.
   * Default: `sources/{sourceId}`. Must not escape root.
   */
  relativeDir?: string;
  /** Optional branch/tag/commit to checkout after clone. */
  ref?: string;
  /** Clone timeout (default 120s). */
  timeoutMs?: number;
};

export type CloneIntoWorkspaceResult = {
  /** Absolute path of the cloned working tree. */
  path: string;
  probe: GitProbe;
};

/**
 * Operator-initiated `git clone` into the Workspace.
 * Does not use agent shell. Relies on host git credentials (helper/SSH agent).
 * Does not store tokens. Path is always contained under workspaceRoot.
 */
export async function cloneIntoWorkspace(
  input: CloneIntoWorkspaceInput,
): Promise<CloneIntoWorkspaceResult> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const remoteUrl = input.remoteUrl.trim();
  if (!remoteUrl) {
    throw new Error("remoteUrl is required");
  }
  // Block obvious shell metacharacters in URL for spawn arg safety.
  if (/[\r\n\0]/.test(remoteUrl)) {
    throw new Error("remoteUrl contains invalid characters");
  }

  const sourceId = input.sourceId.trim();
  if (!sourceId) {
    throw new Error("sourceId is required");
  }

  const relative =
    typeof input.relativeDir === "string" && input.relativeDir.trim()
      ? input.relativeDir.trim().replace(/\\/g, "/")
      : `${WORKSPACE_SOURCES_DIR_NAME}/${sourceId}`;

  const parts = relative.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) {
    throw new Error("relativeDir must be a path inside the workspace root");
  }
  const dest = path.join(workspaceRoot, ...parts);
  if (!isStrictlyInside(workspaceRoot, dest)) {
    throw new Error("clone destination must be strictly inside workspace root");
  }

  try {
    await access(dest);
    throw new Error(`clone destination already exists: ${dest}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("clone destination already exists")) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(path.dirname(dest), { recursive: true });

  const timeoutMs = input.timeoutMs ?? 120_000;
  const clone = await runGit(
    workspaceRoot,
    ["clone", "--", remoteUrl, dest],
    { timeoutMs },
  );
  if (clone.code !== 0) {
    const detail = clone.stderr || clone.stdout || `exit ${clone.code}`;
    throw new Error(`git clone failed: ${detail}`);
  }

  const ref = input.ref?.trim();
  if (ref) {
    if (/[\r\n\0]/.test(ref)) {
      throw new Error("ref contains invalid characters");
    }
    const checkout = await runGit(dest, ["checkout", ref], { timeoutMs: 60_000 });
    if (checkout.code !== 0) {
      const detail = checkout.stderr || checkout.stdout || "checkout failed";
      throw new Error(`git checkout ref failed: ${detail}`);
    }
  }

  // Ensure dest is a directory (clone succeeded).
  const info = await stat(dest);
  if (!info.isDirectory()) {
    throw new Error(`clone did not produce a directory: ${dest}`);
  }

  const probe = await probeLocalGit(dest);
  if (!probe.isGit) {
    throw new Error(`cloned path is not a git working tree: ${dest}`);
  }

  return { path: dest, probe };
}
