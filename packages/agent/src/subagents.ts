/**
 * Domain / Leaf / Reviewer subagents for the dynamic supervisor tree.
 * Research roles are read-only; Root remains the only default wiki writer.
 * Always created — small repos simply get a short tree, not disabled agents.
 */

import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { InputProcessor } from "@mastra/core/processors";
import type { Memory } from "@mastra/memory";
import type { WorkspaceOrchestration } from "@okf-wiki/contract";
import { DEFAULT_ORCHESTRATION } from "./limits.js";
import type { WikiRunTools } from "./tools.js";

export type SubagentBundle = {
  domainResearcher: Agent;
  leafResearcher: Agent;
  /** Primary reviewer (first council member). */
  reviewer: Agent;
  /** Full review council (length ≥ 1). */
  reviewers: Agent[];
  domainMaxSteps: number;
  leafMaxSteps: number;
  reviewerMaxSteps: number;
  orchestration: WorkspaceOrchestration;
};

/**
 * Build specialist agents. Only research/review tools are attached —
 * never write_wiki on Domain/Leaf/Reviewer.
 */
export function createSubagents(options: {
  /** Default model when role-specific models are omitted. */
  model: MastraModelConfig;
  /** Optional cheaper worker model for Domain/Leaf. */
  workerModel?: MastraModelConfig;
  /** Council reviewer models (first is primary). Empty → use model. */
  reviewerModels?: MastraModelConfig[];
  tools: WikiRunTools;
  orchestration?: WorkspaceOrchestration;
  /** Shared context-compaction processors (TokenLimiter + ToolCallFilter). */
  inputProcessors?: InputProcessor[];
  /**
   * Observational Memory for Reviewer only (explicit generate + threadId).
   * Domain/Leaf stay TokenLimiter-only — supervisor delegation may omit threadId.
   */
  memory?: Memory;
}): SubagentBundle {
  const orch = options.orchestration ?? DEFAULT_ORCHESTRATION;
  const researchTools = {
    list_source: options.tools.list_source,
    read_source: options.tools.read_source,
    glob_source: options.tools.glob_source,
    search_source: options.tools.search_source,
    list_skill: options.tools.list_skill,
    read_skill: options.tools.read_skill,
  };
  const processorOpts =
    options.inputProcessors && options.inputProcessors.length > 0
      ? { inputProcessors: options.inputProcessors }
      : {};
  const reviewerMemoryOpts = options.memory ? { memory: options.memory } : {};
  const workerModel = options.workerModel ?? options.model;
  const reviewerModels =
    options.reviewerModels && options.reviewerModels.length > 0
      ? options.reviewerModels
      : [options.model];

  const domainResearcher = new Agent({
    id: "okf-wiki-domain",
    name: "Domain Researcher",
    description:
      "Investigates one bounded domain/source scope and returns findings with source citations. Does not write wiki pages. Use for large or independent areas of the repository.",
    model: workerModel,
    instructions: [
      "You are a Domain research subagent for one Wiki Run.",
      "Investigate only the scope in the user message using list_source/glob_source/search_source/read_source.",
      "Return a concise receipt: findings, source paths with line numbers from tools, open questions.",
      "Do not write wiki pages. Do not invent citations or line ranges.",
      `Stay within ${orch.domainMaxSteps} tool steps (host-enforced).`,
    ].join("\n"),
    tools: researchTools,
    ...processorOpts,
  });

  const leafResearcher = new Agent({
    id: "okf-wiki-leaf",
    name: "Leaf Researcher",
    description:
      "Deep-dives a narrow module or path and returns evidence for the parent Domain. Does not write wiki pages.",
    model: workerModel,
    instructions: [
      "You are a Leaf research subagent.",
      "Inspect a narrow path/module using list_source/glob_source/search_source/read_source.",
      "Return short evidence bullets with concrete paths and tool-derived line numbers.",
      "Do not write wiki pages. Do not invent line ranges.",
      `Stay within ${orch.leafMaxSteps} tool steps (host-enforced).`,
    ].join("\n"),
    tools: researchTools,
    ...processorOpts,
  });

  const reviewers = reviewerModels.map((reviewerModel, index) => {
    const n = index + 1;
    return new Agent({
      id: `okf-wiki-reviewer-${n}`,
      name: `Wiki Reviewer ${n}`,
      description:
        "Read-only reviewer of staged wiki pages against sources. Produces defects only; cannot write wiki or publish.",
      model: reviewerModel,
      instructions: [
        "You are an independent Wiki Reviewer.",
        "Read staged pages with list_wiki/read_wiki and verify claims against list_source/glob_source/search_source/read_source.",
        "Flag invented or out-of-bounds citation line ranges.",
        "Prefer fenced JSON DefectReport: { clean, defects: [{ severity, code, path, issue, suggestedFix }] }.",
        "Severity: blocking (must fix before publish), major, or minor.",
        "If clean, say NO_DEFECTS or { \"clean\": true, \"defects\": [] }.",
        "Do not write or edit wiki pages. Do not publish.",
        `Stay within ${orch.reviewerMaxSteps} tool steps (host-enforced).`,
        index > 0
          ? "You are a second opinion — be decorrelated from other reviewers; focus on gaps others might miss."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      tools: {
        ...researchTools,
        list_wiki: options.tools.list_wiki,
        read_wiki: options.tools.read_wiki,
      },
      ...processorOpts,
      ...reviewerMemoryOpts,
    });
  });

  return {
    domainResearcher,
    leafResearcher,
    reviewer: reviewers[0]!,
    reviewers,
    domainMaxSteps: orch.domainMaxSteps,
    leafMaxSteps: orch.leafMaxSteps,
    reviewerMaxSteps: orch.reviewerMaxSteps,
    orchestration: orch,
  };
}

/** Agents map for Mastra supervisor-style Root.agents (research only). */
export function subagentsAsAgentsMap(
  bundle: SubagentBundle,
): Record<string, Agent> {
  return {
    domainResearcher: bundle.domainResearcher,
    leafResearcher: bundle.leafResearcher,
  };
}
