/**
 * Host isTaskComplete scorer for produce phase: keep the Root loop alive until
 * at least one staged wiki page exists (or maxSteps). Complements post-stream
 * review council / hard-validate.
 */

import { createScorer } from "@mastra/core/evals";
import { listMarkdownPages } from "./fs-ops.js";

/**
 * Returns isTaskComplete config that scores 1 when staging has markdown pages.
 * Score 0 injects feedback so the model keeps writing.
 */
export function buildProducePagesCompleteConfig(wikiRoot: string) {
  const scorer = createScorer({
    id: "okf-wiki-pages-written",
    name: "Wiki pages written",
    description:
      "Host check: staging directory must contain at least one markdown page.",
  }).generateScore(async () => {
    try {
      const pages = await listMarkdownPages(wikiRoot);
      return pages.length > 0 ? 1 : 0;
    } catch {
      return 0;
    }
  });

  return {
    scorers: [scorer],
    strategy: "all" as const,
    onComplete: async (result: { complete?: boolean }) => {
      if (!result.complete) {
        // Feedback is handled by scorer infrastructure; no-op hook for logs.
      }
    },
  };
}
