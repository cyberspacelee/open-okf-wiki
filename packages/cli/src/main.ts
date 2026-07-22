#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startWikiRun,
  shellPhaseLabel,
  shouldUsePiFixtureMode,
  type WikiRunShellPhase,
} from "@okf-wiki/agent";
import { defaultWikiRunSpec, type WorkspaceConfig } from "@okf-wiki/contract";
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
  okf-wiki wiki-run --root <path> [options]
  okf-wiki serve [--print]
  okf-wiki help

wiki-run options:
  --root <path>           Workspace root (required). Loads .okf-wiki/workspace.json when present.
  --source <id=path>      Source mount (repeatable). Merges over workspace sources by id.
  --name <name>           Name when no workspace.json (default: basename of --root)
  --title <title>         Produce title (default: plan summary)
  --auto-approve          Skip plan gate (default for headless)
  --plan-confirm          Stop at plan gate (no produce)
  --yes, --publish        Mark shell published after produce (no filesystem publish)
  --fixture               Force Pi fixture mode (no LLM)
  --live                  Force live Pi mode (requires model credentials)
  --json                  Emit only the final JSON result (phases on stderr)

Notes:
  - workspace-create writes a draft workspace.json (empty sources). Add local
    Git source paths via the Web UI or POST /api/workspaces/:id/sources.
  - Web UI is the primary operator surface (packages/web + packages/server).
  - wiki-run is headless Pi produce (fixture by default / OKF_WIKI_AGENT_MODE).
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

type WikiRunCliArgs = {
  root: string;
  name?: string;
  title?: string;
  sources: Array<{ id: string; path: string }>;
  planConfirm: boolean;
  autoPublish: boolean;
  fixture?: boolean;
  jsonOnly: boolean;
};

function parseSourceSpec(raw: string): { id: string; path: string } {
  const eq = raw.indexOf("=");
  const colon = raw.indexOf(":");
  let sep = -1;
  if (eq > 0) sep = eq;
  else if (colon > 0 && !/^[A-Za-z]:[\\/]/.test(raw)) sep = colon;
  if (sep <= 0) {
    throw new Error(
      `invalid --source ${JSON.stringify(raw)} (expected id=path)`,
    );
  }
  const id = raw.slice(0, sep).trim();
  const sourcePath = raw.slice(sep + 1).trim();
  if (!id || !sourcePath) {
    throw new Error(
      `invalid --source ${JSON.stringify(raw)} (expected id=path)`,
    );
  }
  return { id, path: sourcePath };
}

function parseWikiRunArgs(argv: string[]): WikiRunCliArgs {
  const sources: Array<{ id: string; path: string }> = [];
  let root: string | undefined;
  let name: string | undefined;
  let title: string | undefined;
  let planConfirm = false;
  let autoPublish = false;
  let fixture: boolean | undefined;
  let jsonOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const needValue = (flag: string): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`missing value for ${flag}`);
      }
      i += 1;
      return next;
    };

    switch (token) {
      case "--root":
        root = needValue(token);
        break;
      case "--name":
        name = needValue(token);
        break;
      case "--title":
        title = needValue(token);
        break;
      case "--source":
        sources.push(parseSourceSpec(needValue(token)));
        break;
      case "--auto-approve":
        planConfirm = false;
        break;
      case "--plan-confirm":
        planConfirm = true;
        break;
      case "--yes":
      case "--publish":
        autoPublish = true;
        break;
      case "--fixture":
        fixture = true;
        break;
      case "--live":
        fixture = false;
        break;
      case "--json":
        jsonOnly = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        throw new Error(`unknown wiki-run option: ${token}`);
    }
  }

  if (!root) {
    throw new Error("wiki-run requires --root <path>");
  }

  return {
    root,
    name,
    title,
    sources,
    planConfirm,
    autoPublish,
    fixture,
    jsonOnly,
  };
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

type PhaseLine = {
  phase: WikiRunShellPhase | "planning";
  label: string;
  detail?: string;
};

/**
 * Headless wiki-run via WikiRunShell + produceWithPi (ADR 0030).
 * Fixture by default (OKF_WIKI_AGENT_MODE=fixture or no live credentials).
 */
async function cmdWikiRun(argv: string[]): Promise<void> {
  let args: WikiRunCliArgs;
  try {
    args = parseWikiRunArgs(argv);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(
      "usage: okf-wiki wiki-run --root <path> [--source id=path] [--fixture] [--yes]\n",
    );
    process.exit(2);
  }

  const rootPath = path.resolve(args.root);
  const phaseLog: PhaseLine[] = [];

  const emitPhase = (
    phase: PhaseLine["phase"],
    detail?: string,
  ): void => {
    const label =
      phase === "planning" ? "Planning" : shellPhaseLabel(phase);
    phaseLog.push({ phase, label, detail });
    const line = detail
      ? `phase\t${phase}\t${label}\t${detail}\n`
      : `phase\t${phase}\t${label}\n`;
    if (args.jsonOnly) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  // Prefer saved workspace when present; otherwise ephemeral headless config.
  let workspaceName = args.name?.trim() || path.basename(rootPath) || "wiki";
  let skillPath: string | undefined;
  const sourceMap = new Map<string, string>();

  try {
    const ws = await loadWorkspace(rootPath);
    workspaceName = args.name?.trim() || ws.name;
    skillPath = ws.skillPath;
    for (const src of ws.sources) {
      sourceMap.set(src.id, path.resolve(src.path));
    }
  } catch {
    // No workspace.json — fine for fixture-friendly headless runs.
  }

  for (const src of args.sources) {
    sourceMap.set(src.id, path.resolve(src.path));
  }

  const plan = defaultWikiRunSpec(workspaceName);
  const useFixture = shouldUsePiFixtureMode({ fixture: args.fixture });
  if (useFixture) {
    process.env.OKF_WIKI_AGENT_MODE = "fixture";
  } else if (args.fixture === false) {
    process.env.OKF_WIKI_AGENT_MODE = "live";
  }

  const runId = randomUUID();
  const sources = [...sourceMap.entries()].map(([id, p]) => ({
    id,
    path: p,
    origin: "path" as const,
  }));

  // Minimal WorkspaceConfig for startWikiRun (Pi shell + produce + optional publish).
  const workspace = {
    version: 1 as const,
    id: "cli",
    name: workspaceName,
    rootPath,
    sources: sources.map((s) => ({
      id: s.id,
      path: s.path,
      applyDefaultIgnores: true,
      ignore: [] as string[],
      origin: { type: "path" as const },
    })),
    skillPath,
    publicationPath: path.join(rootPath, "wiki"),
    planConfirm: args.planConfirm,
    model: { provider: "openai", modelId: "unused" },
    limits: {},
    roleModels: {},
    orchestration: {},
    wikiLanguage: "en" as const,
  } as unknown as WorkspaceConfig;

  emitPhase(
    "planning",
    args.planConfirm ? "plan gate forced" : "plan gate skipped (headless)",
  );

  try {
    const result = await startWikiRun({
      runId,
      workspace,
      plan,
      forcePlanConfirm: args.planConfirm,
      skipPlanConfirm: !args.planConfirm,
      autoApprove: args.autoPublish || !args.planConfirm,
      onEvent: (ev) => {
        if (ev.type === "phase" || ev.type === "gate") {
          emitPhase(
            (ev.message as WikiRunShellPhase) || "producing",
            typeof ev.data === "string" ? ev.data : ev.message,
          );
        }
      },
    });

    printJson({
      ok:
        result.status === "published" ||
        result.status === "awaiting_plan" ||
        result.status === "awaiting_publication" ||
        result.status === "publication_declined",
      command: "wiki-run",
      status: result.status,
      phase: result.status,
      phases: phaseLog,
      runId,
      fixture: useFixture,
      title: args.title?.trim() || plan.summary,
      summary: result.summary,
      pages: result.pages,
      rootPath,
      publicationPath: result.publicationPath,
      plan: result.plan,
      suspended: result.suspended,
      suspendGate: result.suspendGate,
      sourceIds: [...sourceMap.keys()],
      error: result.error,
      note:
        result.status === "published"
          ? "Published via Run Boundary (or staging retained if publish path failed)."
          : result.suspended
            ? "Suspended at gate — resume via Web Agent Workspace or re-run with --yes."
            : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitPhase("failed", message);
    printJson({
      ok: false,
      command: "wiki-run",
      status: "failed",
      phase: "failed",
      phases: phaseLog,
      runId,
      rootPath,
      error: message,
    });
    process.exit(1);
  }
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
  if (cmd === "wiki-run") {
    await cmdWikiRun(args);
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
