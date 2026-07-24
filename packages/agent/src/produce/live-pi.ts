/**
 * Pi-backed produce path (ADR 0030) — no Mastra / AI SDK.
 *
 * Live: createWikiSession + prompt with Pi built-in tools.
 * Fixture/offline: write OKF-aligned wiki pages without an LLM.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WikiRunSpec } from "@okf-wiki/contract";
import { scanWikiTree } from "@okf-wiki/core";
import { lastAssistantOutcome } from "../pi/assistant-outcome.js";
import { createWikiSession } from "../pi/create-wiki-session.js";
import { type RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { rootWritePrompt, rootWriteSystemPrompt } from "./prompts.js";

export type ProduceWithPiInput = {
  /** Frozen Run Boundary layout; this module never copies or rematerializes it. */
  layout: RunWorkdirLayout;
  /** Already-approved living Spec. */
  spec: WikiRunSpec;
  workspaceName: string;
  /** Force fixture mode (no LLM). Also true when OKF_WIKI_AGENT_MODE=fixture. */
  fixture?: boolean;
  /** Optional model for live mode. */
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  wikiLanguage?: "en" | "zh";
  multiSource?: boolean;
  receiptIndex?: string;
  repairDefects?: string;
  abortSignal?: AbortSignal;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  additionalSkillPaths?: readonly string[];
  sourceIgnores?: SourceIgnoreInput;
};

export type ProduceWithPiResult = {
  mode: "fixture" | "live";
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

export async function listWikiMarkdown(wikiDir: string): Promise<string[]> {
  const scan = await scanWikiTree(wikiDir);
  const missing = scan.issues.some(
    (issue) => issue.relativePath === "." && issue.code === "ENOENT",
  );
  if (missing) return [];
  if (scan.issues[0]) throw new Error(scan.issues[0].message);
  return scan.files
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath.toLowerCase().endsWith(".md"));
}

/**
 * Fixture wiki: concept overview with type+title+citation; listing-only index.md.
 */
async function writeFixtureWiki(layout: RunWorkdirLayout, title: string): Promise<string[]> {
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

/**
 * Produce wiki content via Pi (or fixture write).
 * Prefer Pi built-ins; never enables bash.
 */
export async function produceWithPi(input: ProduceWithPiInput): Promise<ProduceWithPiResult> {
  throwIfAborted(input.abortSignal);
  const layout = input.layout;
  await mkdir(layout.wikiDir, { recursive: true });
  await mkdir(layout.analysisDir, { recursive: true });
  throwIfAborted(input.abortSignal);

  const title = input.spec.summary?.trim() || input.workspaceName.trim() || "Repository overview";
  const useFixture = shouldUsePiFixtureMode(input);

  if (useFixture) {
    const pages = await writeFixtureWiki(layout, title);
    return {
      mode: "fixture",
      layout,
      pages,
      summary: "Pi fixture mode wrote overview.md + listing index.md",
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

  const handle = await createWikiSession({
    role: "root_write",
    runWorkDir: layout.runWorkDir,
    model: input.model,
    modelRuntime: input.modelRuntime,
    systemPrompt: rootWriteSystemPrompt(),
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
    await handle.session.prompt(
      rootWritePrompt({
        layout,
        spec: input.spec,
        wikiLanguage: input.wikiLanguage,
        multiSource: input.multiSource,
        receiptIndex: input.receiptIndex,
        repairDefects: input.repairDefects,
      }),
    );
    throwIfAborted(input.abortSignal);

    const outcome = lastAssistantOutcome(handle.session.messages);
    if (outcome?.isError) {
      throw new Error(
        outcome.errorMessage ||
          `Pi live produce failed (stopReason=${outcome.stopReason ?? "error"})`,
      );
    }

    const pages = await listWikiMarkdown(layout.wikiDir);
    if (pages.length === 0) {
      throw new Error("Pi live produce finished without writing any wiki markdown pages");
    }
    return {
      mode: "live",
      layout,
      pages,
      summary: `Pi live produce wrote ${pages.length} page(s)`,
    };
  } finally {
    if (input.abortSignal) {
      input.abortSignal.removeEventListener("abort", onAbort);
    }
    handle.dispose();
  }
}
