import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { GitProbe } from "@okf-wiki/contract";

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
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
