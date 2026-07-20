/**
 * Shared Mastra registry for Wiki Workflow + agent runs.
 * Storage is required for workflow suspend/resume snapshots (HITL gates).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { wikiRunWorkflow } from "./wiki-workflow.js";

const WORKSPACE_DIR_NAME = ".okf-wiki";

/** Directory for Mastra libSQL files (workflow snapshots). */
export function mastraStorageDir(): string {
  const home = process.env.OKF_WIKI_HOME?.trim();
  if (home) {
    return path.join(path.resolve(home), "mastra");
  }
  return path.join(homedir(), WORKSPACE_DIR_NAME, "mastra");
}

function mastraDbUrl(): string {
  // In-memory for unit tests when explicitly requested.
  if (process.env.OKF_WIKI_MASTRA_STORAGE === "memory") {
    return ":memory:";
  }
  const dir = mastraStorageDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "workflows.db");
  // libSQL file URLs use file: prefix
  return `file:${file}`;
}

let instance: Mastra | undefined;

/**
 * Lazily construct the process-wide Mastra instance.
 * Registers the wiki-run workflow; agents are created per-run inside steps
 * (model/tools depend on workspace config).
 */
export function getMastra(): Mastra {
  if (instance) {
    return instance;
  }
  instance = new Mastra({
    workflows: {
      wikiRunWorkflow,
    },
    storage: new LibSQLStore({
      id: "okf-wiki-mastra",
      url: mastraDbUrl(),
    }),
  });
  return instance;
}

/** Test helper: drop singleton so the next getMastra() rebuilds. */
export function resetMastraForTests(): void {
  instance = undefined;
}
