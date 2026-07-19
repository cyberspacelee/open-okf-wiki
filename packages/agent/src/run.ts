import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Agent } from "@mastra/core/agent";
import { createCodeMode } from "@mastra/core/tools";
import { LocalSandbox } from "@mastra/core/workspace";
import type { WorkspaceConfig, WikiRunRecordStatus } from "@okf-wiki/contract";
import { WORKSPACE_DIR_NAME } from "@okf-wiki/core";
import { listMarkdownPages, writeFileContained } from "./fs-ops.js";
import { resolveSkillPath } from "./skill-path.js";
import { createWikiRunTools } from "./tools.js";

export type WikiRunAgentInput = {
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  /** Best-effort cancellation; fixture checks periodically, live passes to Mastra. */
  abortSignal?: AbortSignal;
};

export type WikiRunAgentResult = {
  status: Extract<
    WikiRunRecordStatus,
    "awaiting_publication" | "published" | "failed" | "cancelled"
  >;
  pages?: string[];
  summary?: string;
  error?: string;
};

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|AbortError/i.test(message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/** True when we should skip the LLM and write a fixture page. */
export function shouldUseFixtureMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OKF_WIKI_AGENT_MODE === "fixture") {
    return true;
  }
  if (env.OKF_WIKI_AGENT_MODE === "live") {
    return false;
  }
  // Default: fixture when no enterprise model credentials/endpoint are configured.
  const hasKey = Boolean(env.OPENAI_API_KEY?.trim());
  const hasUrl = Boolean(env.OPENAI_BASE_URL?.trim());
  return !hasKey && !hasUrl;
}

export function stagingDirForRun(workspaceRoot: string, runId: string): string {
  return path.join(
    path.resolve(workspaceRoot),
    WORKSPACE_DIR_NAME,
    "staging",
    runId,
  );
}

export function redactErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    // Allow hyphens in key material (e.g. sk-proj-..., sk-svcacct-...).
    .replace(/\bsk-[a-zA-Z0-9-]{10,}\b/g, "[redacted-key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=[redacted]")
    .slice(0, 500);
}

/**
 * Terminal success status after agent work.
 *
 * Always `awaiting_publication`. Publication (staging → publicationPath) is
 * owned by the server: HITL approve/deny APIs, or automatic publish when the
 * run record has `autoApprove: true`. The agent must not claim `published`.
 */
function successStatus(_autoApprove: boolean | undefined): "awaiting_publication" {
  return "awaiting_publication";
}

function buildSourceMap(workspace: WorkspaceConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of workspace.sources) {
    map.set(source.id, path.resolve(source.path));
  }
  return map;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("Wiki Run cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("Wiki Run cancelled");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runFixture(input: WikiRunAgentInput, wikiRoot: string): Promise<WikiRunAgentResult> {
  throwIfAborted(input.abortSignal);

  // Optional delay so cancel can win a race in tests (OKF_WIKI_FIXTURE_DELAY_MS).
  const delayRaw = process.env.OKF_WIKI_FIXTURE_DELAY_MS;
  const delayMs = delayRaw ? Number(delayRaw) : 0;
  if (Number.isFinite(delayMs) && delayMs > 0) {
    // Check abort in small slices so cancel is responsive.
    const slice = Math.min(50, delayMs);
    let waited = 0;
    while (waited < delayMs) {
      throwIfAborted(input.abortSignal);
      const step = Math.min(slice, delayMs - waited);
      await sleep(step, input.abortSignal);
      waited += step;
    }
  }

  throwIfAborted(input.abortSignal);

  const sourceIds = input.workspace.sources.map((s) => s.id).join(", ");
  const title = input.workspace.name || "Repository overview";
  const content = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "This page was produced in **fixture mode** (no LLM call).",
    "",
    `- Workspace: \`${input.workspace.id}\``,
    `- Sources: ${sourceIds || "(none)"}`,
    `- Run: \`${input.runId}\``,
    "",
    "Replace fixture mode with a live model by setting `OPENAI_API_KEY` and/or",
    "`OPENAI_BASE_URL`, or force live with `OKF_WIKI_AGENT_MODE=live`.",
    "",
  ].join("\n");

  await writeFileContained(wikiRoot, "overview.md", content);
  throwIfAborted(input.abortSignal);
  const pages = await listMarkdownPages(wikiRoot);
  return {
    status: successStatus(input.autoApprove),
    pages,
    summary: "Fixture Wiki Run wrote overview.md",
  };
}

function buildInstructions(workspace: WorkspaceConfig): string {
  const sourceList = workspace.sources
    .map((s) => `- ${s.id}: ${s.path}`)
    .join("\n");
  return [
    "You are the OKF Wiki Root Agent for a single Wiki Run.",
    "Follow the producer skill strictly.",
    "",
    "## Run instructions",
    "1. Read skill file SKILL.md via read_skill, then any needed references/templates.",
    "2. Explore sources with list_source / read_source (read-only).",
    "3. Write final Markdown pages under the wiki staging area with write_wiki.",
    "4. Every page MUST start with YAML frontmatter containing a non-empty `title`.",
    "5. Prefer a small coherent page set (e.g. overview.md plus architecture/module as needed).",
    "6. When finished, reply with a short plain-text summary listing the wiki-relative page paths you wrote.",
    "",
    "Do not attempt shell access. Use only the provided tools.",
    "Do not invent source citations without reading the cited files.",
    "",
    `Workspace: ${workspace.name} (${workspace.id})`,
    "Sources:",
    sourceList || "- (none)",
  ].join("\n");
}

function resolveModelConfig(workspace: WorkspaceConfig): {
  id: `${string}/${string}`;
  url?: string;
  apiKey: string;
} {
  const rawId = workspace.model?.id?.trim() || process.env.OKF_WIKI_MODEL_ID?.trim() || "openai/default";
  // Mastra OpenAICompatibleConfig requires provider/model form.
  const id = (rawId.includes("/") ? rawId : `openai/${rawId}`) as `${string}/${string}`;
  const url = process.env.OPENAI_BASE_URL?.trim() || undefined;
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "local";
  return { id, url, apiKey };
}

async function runLive(input: WikiRunAgentInput, wikiRoot: string, skillRoot: string): Promise<WikiRunAgentResult> {
  const sources = buildSourceMap(input.workspace);
  // Discrete path-policy tools always registered; CodeMode only orchestrates them
  // via host-side RPC (validation/tracing/path containment stay on the host).
  const tools = createWikiRunTools({
    sources,
    skillRoot,
    wikiRoot,
  });

  // Optional Mastra Code Mode (live only): orchestration TS runs in LocalSandbox;
  // external_* calls still hit the same contained tools above.
  const { tool: execute_typescript, instructions: codeModeInstructions } = createCodeMode({
    tools,
    sandbox: new LocalSandbox({
      isolation: "none",
      workingDirectory: wikiRoot,
    }),
  });

  const model = resolveModelConfig(input.workspace);
  const agent = new Agent({
    id: "okf-wiki-root",
    name: "OKF Wiki Root",
    instructions: [buildInstructions(input.workspace), codeModeInstructions],
    model: {
      id: model.id,
      url: model.url,
      apiKey: model.apiKey,
    },
    tools: {
      ...tools,
      execute_typescript,
    },
  });

  throwIfAborted(input.abortSignal);

  const maxSteps = input.workspace.limits?.maxSteps ?? 24;
  const result = await agent.generate(
    [
      {
        role: "user",
        content:
          "Produce a source-grounded Wiki for this workspace. " +
          "Read SKILL.md first, inspect sources, write markdown pages with write_wiki, then summarize.",
      },
    ],
    {
      maxSteps,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    },
  );

  throwIfAborted(input.abortSignal);

  if (result.error) {
    throw result.error;
  }

  const pages = await listMarkdownPages(wikiRoot);
  if (pages.length === 0) {
    return {
      status: "failed",
      error: "agent finished without writing any wiki pages",
      summary: result.text?.slice(0, 400) || undefined,
    };
  }

  return {
    status: successStatus(input.autoApprove),
    pages,
    summary: (result.text?.trim() || `Wrote ${pages.length} page(s)`).slice(0, 1000),
  };
}

/**
 * Execute a Wiki Run against workspace sources and staging.
 * Does not persist the StoredRunRecord — the server registry owns that.
 */
export async function runWikiAgent(input: WikiRunAgentInput): Promise<WikiRunAgentResult> {
  if (!input.workspace.sources || input.workspace.sources.length === 0) {
    return {
      status: "failed",
      error: "workspace must have at least one source",
    };
  }

  const wikiRoot = stagingDirForRun(input.workspace.rootPath, input.runId);
  await mkdir(wikiRoot, { recursive: true });

  try {
    throwIfAborted(input.abortSignal);

    if (shouldUseFixtureMode()) {
      return await runFixture(input, wikiRoot);
    }

    const skillRoot = await resolveSkillPath(input.workspace.skillPath);
    return await runLive(input, wikiRoot, skillRoot);
  } catch (error) {
    if (isAbortError(error) || input.abortSignal?.aborted) {
      return {
        status: "cancelled",
        error: "cancelled",
        summary: "Wiki Run cancelled",
      };
    }
    return {
      status: "failed",
      error: redactErrorMessage(error),
    };
  }
}
