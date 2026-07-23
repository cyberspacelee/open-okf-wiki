/**
 * Pi-backed produce path (ADR 0030) — no Mastra / AI SDK.
 *
 * Live: createWikiSession + prompt with Pi built-in tools.
 * Fixture/offline: write OKF-aligned wiki pages without an LLM.
 */

import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createWikiSession } from "../pi/create-wiki-session.js";
import { lastAssistantOutcome } from "../pi/assistant-outcome.js";
import {
  materializeRunWorkdir,
  runWorkdirPromptPaths,
  type MaterializeRunWorkdirInput,
  type RunWorkdirLayout,
} from "../pi/run-workdir.js";
import type { WikiAgentRole } from "../pi/tool-policy.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { rootWritePrompt, rootWriteSystemPrompt } from "./prompts.js";
import type { WikiRunSpec } from "@okf-wiki/contract";

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
  /** Living Spec — used for default write prompt when present. */
  spec?: WikiRunSpec;
  wikiLanguage?: "en" | "zh";
  multiSource?: boolean;
  receiptIndex?: string;
  repairDefects?: string;
  isRefresh?: boolean;
  abortSignal?: AbortSignal;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  additionalSkillPaths?: readonly string[];
  sourceIgnores?: SourceIgnoreInput;
  workspaceRoot?: string;
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
 */
export function hasModelCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim() || env.OPENAI_BASE_URL?.trim());
}

export async function listWikiMarkdown(wikiDir: string): Promise<string[]> {
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

/**
 * Fixture wiki: concept overview with type+title+citation; listing-only index.md.
 */
async function writeFixtureWiki(
  layout: RunWorkdirLayout,
  title: string,
): Promise<string[]> {
  await mkdir(layout.wikiDir, { recursive: true });
  const overview = [
    "---",
    "type: Overview",
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
    // Bare repo:path is valid when the Snapshot Set has exactly one source.
    "Grounding: [Source](repo:README.md#L1).",
    "",
    "This page is a pipeline smoke fixture (no LLM). Use live mode with API credentials for real generation.",
    "",
  ].join("\n");

  const index = [
    `# ${title}`,
    "",
    "* [Overview](overview.md) - Repository overview (fixture)",
    "",
  ].join("\n");

  await writeFile(path.join(layout.wikiDir, "overview.md"), overview, "utf8");
  await writeFile(path.join(layout.wikiDir, "index.md"), index, "utf8");
  return ["index.md", "overview.md"];
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
  return rootWritePrompt({
    layout,
    spec: {
      version: 1,
      summary: "Repository wiki",
      audience: "Engineers",
      domains: [],
      pages: [
        {
          path: "overview.md",
          purpose: "Repository purpose and navigation",
          domainIds: [],
          questions: [],
          template: "overview",
          critical: true,
        },
      ],
      openQuestions: [],
      acceptance: {
        reviewRequired: true,
        maxRepairRounds: 2,
        blockingSeverities: ["blocking"],
      },
      changelog: [],
    },
  });
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
    if (input.role === "root_write") {
      const pages = await writeFixtureWiki(layout, title);
      return {
        mode: "fixture",
        role: input.role,
        layout,
        pages,
        summary: "Pi fixture mode wrote overview.md + listing index.md",
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
    (input.role === "root_write"
      ? rootWriteSystemPrompt()
      : [
          "You are the Open OKF Wiki research agent.",
          "Use only the provided tools. Never use bash.",
          "You are read-only; do not attempt writes.",
        ].join(" "));

  const handle = await createWikiSession({
    role: input.role,
    runWorkDir: layout.runWorkDir,
    workspaceRoot: input.workspaceRoot,
    model: input.model,
    modelRuntime: input.modelRuntime,
    systemPrompt,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    additionalSkillPaths: input.additionalSkillPaths,
    sourceIgnores: input.sourceIgnores,
    scopedTools: true,
  });

  const onAbort = () => {
    try {
      handle.session.abort();
    } catch {
      // best-effort
    }
  };
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      onAbort();
      const err = new Error("Wiki Run cancelled");
      err.name = "AbortError";
      handle.dispose();
      throw err;
    }
    input.abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    throwIfAborted(input.abortSignal);
    let prompt = input.prompt;
    if (!prompt) {
      if (input.role === "root_write" && input.spec) {
        prompt = rootWritePrompt({
          layout,
          spec: input.spec,
          wikiLanguage: input.wikiLanguage,
          multiSource: input.multiSource,
          receiptIndex: input.receiptIndex,
          repairDefects: input.repairDefects,
          isRefresh: input.isRefresh,
        });
      } else {
        prompt = defaultLivePrompt(input.role, layout);
      }
    }
    await handle.session.prompt(prompt);
    throwIfAborted(input.abortSignal);

    const outcome = lastAssistantOutcome(handle.session.messages);
    if (outcome?.isError) {
      throw new Error(
        outcome.errorMessage ||
          `Pi live produce failed (stopReason=${outcome.stopReason ?? "error"})`,
      );
    }

    const pages =
      input.role === "root_write"
        ? await listWikiMarkdown(layout.wikiDir)
        : [];
    if (input.role === "root_write" && pages.length === 0) {
      throw new Error(
        "Pi live produce finished without writing any wiki markdown pages",
      );
    }
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
    if (input.abortSignal) {
      input.abortSignal.removeEventListener("abort", onAbort);
    }
    handle.dispose();
  }
}
