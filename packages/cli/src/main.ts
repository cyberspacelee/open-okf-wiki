#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkspace,
  listRecentWorkspaces,
  loadWorkspace,
  probeLocalGit,
  registerWorkspaceInAppIndex,
  saveWorkspace,
} from "@okf-wiki/core";

function doctorUrl(): string {
  const port = process.env.OKF_WIKI_PORT ?? "8787";
  return `http://127.0.0.1:${port}/api/doctor`;
}

function usage(): never {
  process.stdout.write(`okf-wiki — headless helpers for the TypeScript workspace stack

Usage:
  okf-wiki doctor
  okf-wiki git-probe <path>
  okf-wiki workspaces
  okf-wiki workspace-create --name <name> --root <absolute-path>
  okf-wiki serve [--print]
  okf-wiki help

Notes:
  - workspace-create writes a draft workspace.json (empty sources). Add local
    Git source paths via the Web UI or POST /api/workspaces/:id/sources.
  - Web UI is the primary operator surface (packages/web + packages/server).
  - Headless wiki-run will land in a later phase.
  - doctor probes http://127.0.0.1:$OKF_WIKI_PORT/api/doctor (default 8787).
`);
  process.exit(0);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseNamedArgs(
  argv: string[],
  flags: readonly string[],
): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (flags.includes(token)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`missing value for ${token}`);
      }
      values[token] = next;
      i += 1;
      continue;
    }
    rest.push(token);
  }
  return { values, rest };
}

/** Resolve monorepo root from this file (src/ or dist/ under packages/cli). */
function monorepoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/cli/src or packages/cli/dist → packages/cli → packages → repo root
  return path.resolve(here, "../../..");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchServerDoctor(): Promise<unknown | null> {
  try {
    const response = await fetch(doctorUrl(), {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function cmdDoctor(): Promise<void> {
  const url = doctorUrl();
  const server = await fetchServerDoctor();
  printJson({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    openaiBaseUrlSet: Boolean(process.env.OPENAI_BASE_URL),
    openaiApiKeySet: Boolean(process.env.OPENAI_API_KEY),
    server:
      server === null
        ? { reachable: false, url }
        : { reachable: true, url, doctor: server },
  });
}

async function cmdGitProbe(target: string | undefined): Promise<void> {
  if (!target) {
    process.stderr.write("usage: okf-wiki git-probe <path>\n");
    process.exit(2);
  }
  const probe = await probeLocalGit(target);
  printJson(probe);
  process.exit(probe.isGit && !probe.error ? 0 : 1);
}

async function cmdWorkspaces(): Promise<void> {
  const roots = await listRecentWorkspaces();
  const workspaces: Array<
    | {
        rootPath: string;
        ok: true;
        id: string;
        name: string;
        sourceCount: number;
        lastOpenedAt?: string;
        publicationPath: string;
      }
    | { rootPath: string; ok: false; error: string }
  > = [];

  for (const rootPath of roots) {
    try {
      const ws = await loadWorkspace(rootPath);
      workspaces.push({
        rootPath: ws.rootPath,
        ok: true,
        id: ws.id,
        name: ws.name,
        sourceCount: ws.sources.length,
        lastOpenedAt: ws.lastOpenedAt,
        publicationPath: ws.publicationPath,
      });
    } catch (error) {
      workspaces.push({
        rootPath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  printJson({
    appIndexCount: roots.length,
    workspaces,
  });
}

async function cmdWorkspaceCreate(argv: string[]): Promise<void> {
  let values: Record<string, string>;
  try {
    ({ values } = parseNamedArgs(argv, ["--name", "--root", "--publication-path", "--model-id"]));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("usage: okf-wiki workspace-create --name <name> --root <absolute-path>\n");
    process.exit(2);
  }

  const name = values["--name"];
  const root = values["--root"];
  if (!name || !root) {
    process.stderr.write("usage: okf-wiki workspace-create --name <name> --root <absolute-path>\n");
    process.exit(2);
  }

  if (!path.isAbsolute(root)) {
    process.stderr.write(`--root must be an absolute path (got: ${root})\n`);
    process.exit(2);
  }

  try {
    // Draft workspace: empty sources allowed. Operator must addSource then
    // save (via server/Web UI) before a full wiki-run.
    const workspace = await createWorkspace({
      name,
      rootPath: root,
      publicationPath: values["--publication-path"],
      modelId: values["--model-id"],
    });
    await saveWorkspace(workspace);
    await registerWorkspaceInAppIndex(workspace.rootPath);
    printJson({
      workspace,
      note:
        "Draft workspace saved with empty sources. Add a git source via " +
        "POST /api/workspaces/:id/sources (or the Web UI), then continue.",
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

async function cmdServe(argv: string[]): Promise<void> {
  const printOnly = argv.includes("--print") || argv.includes("--help-only");
  const monorepoRoot = monorepoRootFromHere();
  const serverMain = path.join(monorepoRoot, "packages/server/src/main.ts");
  const serverExists = await pathExists(serverMain);

  const instructions =
    "Manual start (from monorepo root):\n" +
    "  pnpm --filter @okf-wiki/server start\n" +
    "  # or: node --experimental-strip-types packages/server/src/main.ts\n" +
    "Then open the Web UI:\n" +
    "  pnpm --filter @okf-wiki/web dev\n" +
    "API default: http://127.0.0.1:8787\n";

  if (printOnly || !serverExists) {
    if (!serverExists) {
      process.stderr.write(`server entry not found at ${serverMain}\n`);
    }
    process.stdout.write(instructions);
    process.exit(serverExists ? 0 : 1);
  }

  process.stdout.write(`spawning server: node --experimental-strip-types ${serverMain}\n`);
  process.stdout.write(`cwd: ${monorepoRoot}\n`);
  process.stdout.write("API: http://127.0.0.1:8787  (Ctrl+C to stop)\n");
  process.stdout.write(
    "Web UI (separate terminal): pnpm --filter @okf-wiki/web dev\n",
  );

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", serverMain],
    {
      cwd: monorepoRoot,
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    },
  );

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  const code: number = await new Promise((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`failed to spawn server: ${error.message}\n`);
      process.stderr.write(instructions);
      resolve(1);
    });
    child.on("close", (exitCode, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(exitCode ?? 0);
    });
  });
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  // pnpm often inserts a bare "--" separator; drop those tokens.
  const tokens = argv.filter((token) => token !== "--");
  const [cmd, ...args] = tokens;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
  }

  if (cmd === "doctor") {
    await cmdDoctor();
    return;
  }
  if (cmd === "git-probe") {
    await cmdGitProbe(args[0]);
    return;
  }
  if (cmd === "workspaces") {
    await cmdWorkspaces();
    return;
  }
  if (cmd === "workspace-create") {
    await cmdWorkspaceCreate(args);
    return;
  }
  if (cmd === "serve") {
    await cmdServe(args);
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  process.stderr.write("run: okf-wiki help\n");
  process.exit(2);
}

await main(process.argv.slice(2));
