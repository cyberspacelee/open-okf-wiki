/**
 * Produce deep module — Layer B Supervisor body (ADR 0028 / 0029).
 * Public entry: runWikiAgent. Submodules own plan parse, fixture, live, review.
 */

import { mkdir } from "node:fs/promises";
import { redactErrorMessage } from "../run-redact.js";
import { isRunCancelledError } from "../session-turn/cancel.js";
import { resolveSkillPath } from "@okf-wiki/core";
import { runFixture, shouldUseFixtureMode } from "./fixture.js";
import { runLive } from "./live.js";
import {
  stagingDirForRun,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
} from "./types.js";

export type {
  WikiRunAgentInput,
  WikiRunAgentPhase,
  WikiRunAgentResult,
  WikiRunStreamWriter,
} from "./types.js";
export { stagingDirForRun } from "./types.js";
export { parsePlanFromAgentText } from "./plan-parse.js";
export { shouldUseFixtureMode } from "./fixture.js";
export {
  resolveWikiModel,
  resolveModelConfig,
  type ResolvedWikiModel,
} from "./model.js";
export {
  DEFAULT_PLAN_MAX_STEPS,
  DEFAULT_WRITE_MAX_STEPS_BASE,
  WRITE_MAX_STEPS_PER_PLAN_PAGE,
  WRITE_MAX_STEPS_CAP,
  resolvePhaseMaxSteps,
} from "./max-steps.js";

/**
 * Execute a Wiki Run against workspace sources and staging.
 * Does not persist the StoredRunRecord — the server registry owns that.
 */
export async function runWikiAgent(
  input: WikiRunAgentInput,
): Promise<WikiRunAgentResult> {
  if (!input.workspace.sources || input.workspace.sources.length === 0) {
    return {
      status: "failed",
      error: "workspace must have at least one source",
    };
  }

  const wikiRoot = stagingDirForRun(input.workspace.rootPath, input.runId);
  await mkdir(wikiRoot, { recursive: true });

  try {
    if (input.abortSignal?.aborted) {
      const err = new Error("Wiki Run cancelled");
      err.name = "AbortError";
      throw err;
    }

    if (await shouldUseFixtureMode()) {
      return await runFixture(input, wikiRoot);
    }

    const skillRoot = await resolveSkillPath({
      skillPath: input.workspace.skillPath,
      workspaceRoot: input.workspace.rootPath,
    });
    return await runLive(input, wikiRoot, skillRoot);
  } catch (error) {
    if (isRunCancelledError(error) || input.abortSignal?.aborted) {
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
