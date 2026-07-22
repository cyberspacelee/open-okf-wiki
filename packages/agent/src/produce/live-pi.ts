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
  /** Provider hard context window (model profile maxContextTokens). */
  maxContextTokens?: number;
  /** Workspace operational context target for compaction. */
  contextTargetTokens?: number;
  /** Product skill dirs for Pi (producer / workspace / home). */
  additionalSkillPaths?: readonly string[];
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

/**
 * Whether to use the no-LLM fixture produce path.
 *
 * **Explicit only** — never auto-selected because credentials are missing.
 * Prefer Pi faux/mock models in unit tests; use fixture only as a product
 * shortcut for pipeline smoke (shell, paths, publish) when requested:
 * - `fixture: true` argument, or
 * - `OKF_WIKI_AGENT_MODE=fixture` (tests / e2e / deliberate CLI `--fixture`)
 *
 * Default is **live**. Missing API keys must fail clearly on the live path.
 */
export function shouldUsePiFixtureMode(
  input: { fixture?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (input.fixture === true) return true;
  if (input.fixture === false) return false;
  return env.OKF_WIKI_AGENT_MODE === "fixture";
}

/**
 * True when env hints at an OpenAI-compatible credential.
 * Prefer `hasProviderCredentials` / Settings model profiles for full catalog checks.
 */
export function hasModelCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim() || env.OPENAI_BASE_URL?.trim());
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
  // Match defaultWikiRunSpec critical page + single-source citation form.
  const body = (heading: string) =>
    [
      "---",
      `title: ${JSON.stringify(heading)}`,
      "---",
      "",
      `# ${heading}`,
      "",
      "This page was produced in **Pi fixture mode** (no LLM call).",
      "",
      "Layout:",
      "- `sources/` — registered source mounts",
      "- `skill/` — Producer Skill",
      "- `wiki/` — Staging Wiki",
      "- `analysis/` — run analysis",
      "",
      // Bare repo:path is valid when the Snapshot Set has exactly one source.
      "Grounding: [Source](repo:README.md#L1).",
      "",
      "This page is a pipeline smoke fixture (no LLM). Use live mode with API credentials for real generation.",
      "",
    ].join("\n");

  const overviewPath = path.join(layout.wikiDir, "overview.md");
  const indexPath = path.join(layout.wikiDir, "index.md");
  await writeFile(overviewPath, body(title), "utf8");
  await writeFile(indexPath, body(`${title} (index)`), "utf8");
  return ["overview.md", "index.md"];
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
      "Live produce requires a model. Configure a model profile in Settings " +
        "(base URL + API key; OpenAI-compatible only), set OPENAI_API_KEY " +
        "(and optional OPENAI_BASE_URL), or pass an explicit model/modelRuntime. " +
        "For no-LLM pipeline smoke only, pass fixture: true or set " +
        "OKF_WIKI_AGENT_MODE=fixture (not the default).",
    );
  }

  const systemPrompt =
    input.systemPrompt ??
    [
      "You are the Open OKF Wiki producer agent.",
      "Use only the provided tools. Never use bash.",
      "All paths are relative to the run workdir cwd.",
      "Read skill/SKILL.md (Producer Skill) before writing wiki pages and follow its method.",
      "Prefer product skills listed in your skill catalog when relevant.",
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
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    additionalSkillPaths: input.additionalSkillPaths,
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
