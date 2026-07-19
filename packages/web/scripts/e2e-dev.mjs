#!/usr/bin/env node
/**
 * Spawns API server + Vite for Playwright e2e.
 * Builds core (+ contract via filter ...), starts the API, waits for /api/health,
 * then starts Vite with --strictPort. Exits when either child exits (or on signal).
 */
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const port = process.env.OKF_WIKI_PORT ?? "8787";
const host = process.env.OKF_WIKI_HOST ?? "127.0.0.1";
const home = process.env.OKF_WIKI_HOME ?? "/tmp/okf-wiki-pw-home";
const vitePort = process.env.VITE_PORT ?? "5173";
const healthUrl = `http://${host}:${port}/api/health`;

const children = [];

/** Kill pid and descendants (pnpm → node grandchildren). Linux/macOS via pgrep. */
function killTree(pid, signal = "SIGTERM") {
  if (!pid) {
    return;
  }
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
    }).trim();
    for (const line of out.split("\n")) {
      const childPid = Number(line);
      if (childPid) {
        killTree(childPid, signal);
      }
    }
  } catch {
    // no children
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function killChild(child, signal = "SIGTERM") {
  if (child.killed || !child.pid) {
    return;
  }
  killTree(child.pid, signal);
}

function spawnPnpm(args, env = {}) {
  const child = spawn("pnpm", args, {
    cwd: monorepoRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    const exitCode = code ?? (signal ? 1 : 0);
    for (const other of children) {
      if (other !== child) {
        killChild(other, "SIGTERM");
      }
    }
    process.exit(exitCode);
  });
  return child;
}

function shutdown() {
  for (const child of children) {
    killChild(child, "SIGTERM");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function waitForUrl(url, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: monorepoRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: false,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function main() {
  // Agent (+ contract/core) must be built — server imports @okf-wiki/agent from dist.
  // `@okf-wiki/agent...` = agent and its workspace dependencies.
  await run("pnpm", ["--filter", "@okf-wiki/agent...", "build"]);

  spawnPnpm(["--filter", "@okf-wiki/server", "start"], {
    OKF_WIKI_PORT: port,
    OKF_WIKI_HOST: host,
    OKF_WIKI_HOME: home,
    // Deterministic e2e: fixture mode writes overview.md without LLM credentials.
    OKF_WIKI_AGENT_MODE: process.env.OKF_WIKI_AGENT_MODE ?? "fixture",
  });

  await waitForUrl(healthUrl);

  spawnPnpm(
    [
      "--filter",
      "@okf-wiki/web",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      vitePort,
      "--strictPort",
    ],
    {},
  );
}

main().catch((err) => {
  console.error(err);
  shutdown();
  process.exit(1);
});
