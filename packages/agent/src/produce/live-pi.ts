/**
 * Pi-backed produce path (ADR 0030) — no Mastra / AI SDK.
 *
 * Live: createWikiSession + prompt with Pi built-in tools.
 * Fixture/offline: write wiki/index.md without an LLM.
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createWikiSession } from "../pi/create-wiki-session.js";
import {
  materializeRunWorkdir,
  runWorkdirPromptPaths,
  type MaterializeRunWorkdirInput,
  type RunWorkdirLayout,
} from "../pi/run-workdir.js";
import type { WikiAgentRole } from "../pi/tool-policy.js";

export type LivePiRole = Extract<WikiAgentRole, "root_write" | "root_research">;

export type ProduceWithPiInput = {
  runWorkDir: string;
  role: LivePiRole;
  /**
   * When set, materialise sources/skill/wiki/analysis before producing.
   * When omitted, runWorkDir is assumed already laid out.
   */
  materialize?: Omit<MaterializeRunWorkdirInput, "runWorkDir">;
  /** Force fixture mode (no LLM). Also true when OKF_WIKI_AGENT_MODE=fixture. */
  fixture?: boolean;
  /** Optional model for live mode. */
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  systemPrompt?: string;
  /** Override the default live prompt. */
  prompt?: string;
  /** Title used in fixture page frontmatter. */
  title?: string;
  abortSignal?: AbortSignal;
};

export type ProduceWithPiResult = {
  mode: "fixture" | "live";
  role: LivePiRole;
  layout: RunWorkdirLayout;
  /** Relative paths under wiki/ that exist after produce. */
  pages: string[];
  summary: string;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/** Fixture / offline when env or explicit flag says so. */
export function shouldUsePiFixtureMode(
  input: { fixture?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.fixture === true) return true;
  if (input.fixture === false) return false;
  if (env.OKF_WIKI_AGENT_MODE === "fixture") return true;
  if (env.OKF_WIKI_AGENT_MODE === "live") return false;
  // Default offline-friendly: fixture when no live model credentials hint.
  if (!env.OPENAI_API_KEY?.trim() && !env.OPENAI_BASE_URL?.trim()) {
    return true;
  }
  return false;
}

async function listWikiMarkdown(wikiDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? path.join(wikiDir, rel) : wikiDir;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(child);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        out.push(child.replace(/\\/g, "/"));
      }
    }
  }
  await walk("");
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function writeFixtureWiki(
  layout: RunWorkdirLayout,
  title: string,
): Promise<string[]> {
  await mkdir(layout.wikiDir, { recursive: true });
  const content = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "This page was produced in **Pi fixture mode** (no LLM call).",
    "",
    "Layout:",
    "- `sources/` — registered source mounts",
    "- `skill/` — Producer Skill",
    "- `wiki/` — Staging Wiki",
    "- `analysis/` — run analysis",
    "",
    "Grounding: [Source](repo:README.md#L1).",
    "",
    "Set `OKF_WIKI_AGENT_MODE=live` with credentials for a live Pi session.",
    "",
  ].join("\n");
  const indexPath = path.join(layout.wikiDir, "index.md");
  await writeFile(indexPath, content, "utf8");
  return ["index.md"];
}

function defaultLivePrompt(role: LivePiRole, layout: RunWorkdirLayout): string {
  const paths = runWorkdirPromptPaths(layout);
  if (role === "root_research") {
    return [
      "You are researching sources for a repository wiki.",
      paths,
      "Using only tools (no bash), explore sources/ and skill/.",
      "Summarise findings; do not write wiki pages in this research role.",
    ].join("\n");
  }
  return [
    "You are writing a Staging Wiki for this repository.",
    paths,
    "Using only tools (no bash):",
    "1. List and read sources under sources/.",
    "2. Write a concise wiki entry point to wiki/index.md.",
    "3. Reply with the path you wrote when done.",
  ].join("\n");
}

/**
 * Produce wiki content via Pi (or fixture write).
 * Prefer Pi built-ins; never enables bash.
 */
export async function produceWithPi(
  input: ProduceWithPiInput,
): Promise<ProduceWithPiResult> {
  throwIfAborted(input.abortSignal);

  let layout: RunWorkdirLayout;
  if (input.materialize) {
    layout = await materializeRunWorkdir({
      runWorkDir: input.runWorkDir,
      ...input.materialize,
    });
  } else {
    const runWorkDir = path.resolve(input.runWorkDir);
    layout = {
      runWorkDir,
      sourcesDir: path.join(runWorkDir, "sources"),
      skillDir: path.join(runWorkDir, "skill"),
      wikiDir: path.join(runWorkDir, "wiki"),
      analysisDir: path.join(runWorkDir, "analysis"),
      sourceMounts: new Map(),
    };
    await mkdir(layout.wikiDir, { recursive: true });
    await mkdir(layout.analysisDir, { recursive: true });
  }

  throwIfAborted(input.abortSignal);

  const title = input.title?.trim() || "Repository overview";
  const useFixture = shouldUsePiFixtureMode(input);

  if (useFixture) {
    // Research role in fixture still materialises layout; write only for write role.
    if (input.role === "root_write") {
      const pages = await writeFixtureWiki(layout, title);
      return {
        mode: "fixture",
        role: input.role,
        layout,
        pages,
        summary: "Pi fixture mode wrote wiki/index.md",
      };
    }
    return {
      mode: "fixture",
      role: input.role,
      layout,
      pages: [],
      summary: "Pi fixture research complete (no writes)",
    };
  }

  if (!input.model) {
    throw new Error(
      "produceWithPi live mode requires a model (or set fixture / OKF_WIKI_AGENT_MODE=fixture)",
    );
  }

  const systemPrompt =
    input.systemPrompt ??
    [
      "You are the Open OKF Wiki producer agent.",
      "Use only the provided tools. Never use bash.",
      "All paths are relative to the run workdir cwd.",
      input.role === "root_write"
        ? "You may write and edit under wiki/ and analysis/."
        : "You are read-only; do not attempt writes.",
    ].join(" ");

  const handle = await createWikiSession({
    role: input.role,
    runWorkDir: layout.runWorkDir,
    model: input.model,
    modelRuntime: input.modelRuntime,
    systemPrompt,
  });

  try {
    throwIfAborted(input.abortSignal);
    const prompt =
      input.prompt ?? defaultLivePrompt(input.role, layout);
    await handle.session.prompt(prompt);
    throwIfAborted(input.abortSignal);
    const pages =
      input.role === "root_write"
        ? await listWikiMarkdown(layout.wikiDir)
        : [];
    return {
      mode: "live",
      role: input.role,
      layout,
      pages,
      summary:
        input.role === "root_write"
          ? `Pi live produce wrote ${pages.length} page(s)`
          : "Pi live research complete",
    };
  } finally {
    handle.dispose();
  }
}
