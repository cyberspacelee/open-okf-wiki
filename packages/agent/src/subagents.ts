/**
 * Bounded Domain / Leaf / Reviewer subagents for adaptive Wiki Runs.
 * Research roles are read-only; Root remains the only wiki writer.
 */

import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { WikiRunTools } from "./tools.js";

export type SubagentBundle = {
  domainResearcher?: Agent;
  leafResearcher?: Agent;
  reviewer?: Agent;
};

/**
 * Build optional specialist agents. Only research tools are attached —
 * never write_wiki on Domain/Leaf/Reviewer.
 */
export function createSubagents(options: {
  model: MastraModelConfig;
  tools: WikiRunTools;
  adaptive: boolean;
  reviewer: boolean;
}): SubagentBundle {
  const researchTools = {
    list_source: options.tools.list_source,
    read_source: options.tools.read_source,
    list_skill: options.tools.list_skill,
    read_skill: options.tools.read_skill,
  };

  const out: SubagentBundle = {};

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
      ].join("\n"),
      tools: researchTools,
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
      ].join("\n"),
      tools: researchTools,
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
