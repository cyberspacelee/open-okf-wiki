/**
 * Bounded Domain / Leaf / Reviewer subagents for adaptive Wiki Runs.
 * Research roles are read-only; Root remains the only wiki writer.
 */

import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { InputProcessor } from "@mastra/core/processors";
import type { Memory } from "@mastra/memory";
import { ADAPTIVE_RUN_LIMITS } from "./limits.js";
import type { WikiRunTools } from "./tools.js";

export type SubagentBundle = {
  domainResearcher?: Agent;
  leafResearcher?: Agent;
  reviewer?: Agent;
  /** Host-enforced maxSteps for domain research generate/stream. */
  domainMaxSteps: number;
  /** Host-enforced maxSteps for leaf research generate/stream. */
  leafMaxSteps: number;
  /** Host-enforced maxSteps for reviewer generate. */
  reviewerMaxSteps: number;
};

/**
 * Build optional specialist agents. Only research tools are attached —
 * never write_wiki on Domain/Leaf/Reviewer.
 *
 * Step caps from ADAPTIVE_RUN_LIMITS are returned on the bundle so callers
 * pass them to generate/stream (host-enforced, not prompt-only).
 */
export function createSubagents(options: {
  model: MastraModelConfig;
  tools: WikiRunTools;
  adaptive: boolean;
  reviewer: boolean;
  /** Shared context-compaction processors (TokenLimiter + ToolCallFilter). */
  inputProcessors?: InputProcessor[];
  /**
   * Observational Memory for Reviewer only (explicit generate + threadId).
   * Domain/Leaf stay TokenLimiter-only — supervisor delegation may omit threadId.
   */
  memory?: Memory;
}): SubagentBundle {
  const researchTools = {
    list_source: options.tools.list_source,
    read_source: options.tools.read_source,
    list_skill: options.tools.list_skill,
    read_skill: options.tools.read_skill,
  };
  const processorOpts =
    options.inputProcessors && options.inputProcessors.length > 0
      ? { inputProcessors: options.inputProcessors }
      : {};
  const reviewerMemoryOpts = options.memory ? { memory: options.memory } : {};

  const out: SubagentBundle = {
    domainMaxSteps: ADAPTIVE_RUN_LIMITS.domainMaxSteps,
    leafMaxSteps: ADAPTIVE_RUN_LIMITS.leafMaxSteps,
    reviewerMaxSteps: ADAPTIVE_RUN_LIMITS.reviewerMaxSteps,
  };

  if (options.adaptive) {
    out.domainResearcher = new Agent({
      id: "okf-wiki-domain",
      name: "Domain Researcher",
      description:
        "Investigates one bounded domain/source scope and returns findings with source citations. Does not write wiki pages.",
      model: options.model,
      instructions: [
        "You are a Domain research subagent for one Wiki Run.",
        "Investigate only the scope in the user message using list_source/read_source.",
        "Return a concise receipt: findings, source paths, open questions.",
        "Do not write wiki pages. Do not invent citations.",
        `Stay within ${ADAPTIVE_RUN_LIMITS.domainMaxSteps} tool steps (host-enforced).`,
      ].join("\n"),
      tools: researchTools,
      ...processorOpts,
    });

    out.leafResearcher = new Agent({
      id: "okf-wiki-leaf",
      name: "Leaf Researcher",
      description:
        "Deep-dives a narrow module or path and returns evidence for the parent Domain. Does not write wiki pages.",
      model: options.model,
      instructions: [
        "You are a Leaf research subagent.",
        "Inspect a narrow path/module using list_source/read_source only.",
        "Return short evidence bullets with concrete paths.",
        "Do not write wiki pages.",
        `Stay within ${ADAPTIVE_RUN_LIMITS.leafMaxSteps} tool steps (host-enforced).`,
      ].join("\n"),
      tools: researchTools,
      ...processorOpts,
    });
  }

  if (options.reviewer) {
    out.reviewer = new Agent({
      id: "okf-wiki-reviewer",
      name: "Wiki Reviewer",
      description:
        "Read-only reviewer of staged wiki pages against sources. Produces defects only; cannot write wiki or publish.",
      model: options.model,
      instructions: [
        "You are an independent Wiki Reviewer.",
        "Read staged pages with list_wiki/read_wiki and verify claims against list_source/read_source.",
        "Return a defects list only (severity + issue + related path).",
        "Do not write or edit wiki pages. Do not publish.",
      ].join("\n"),
      tools: {
        ...researchTools,
        list_wiki: options.tools.list_wiki,
        read_wiki: options.tools.read_wiki,
      },
      ...processorOpts,
      ...reviewerMemoryOpts,
    });
  }

  return out;
}

/** Agents map for Mastra supervisor-style Root.agents. */
export function subagentsAsAgentsMap(
  bundle: SubagentBundle,
): Record<string, Agent> {
  const map: Record<string, Agent> = {};
  if (bundle.domainResearcher) {
    map.domainResearcher = bundle.domainResearcher;
  }
  if (bundle.leafResearcher) {
    map.leafResearcher = bundle.leafResearcher;
  }
  // Reviewer is invoked explicitly after write, not as free supervisor delegate by default.
  return map;
}
