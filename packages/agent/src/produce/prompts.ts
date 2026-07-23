/**
 * Skill-aligned prompts for Host-orchestrated Pi produce (ADR 0028 / 0030).
 */

import type { WikiRunSpec } from "@okf-wiki/contract";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import { runWorkdirPromptPaths } from "../pi/run-workdir.js";

export type WikiLanguage = "en" | "zh";

function pageList(spec: WikiRunSpec): string {
  const pages = spec.pages ?? [];
  if (pages.length === 0) {
    return "- overview.md (critical) — repository overview";
  }
  return pages
    .map((p) => {
      const crit = p.critical === false ? "optional" : "critical";
      const tpl = p.template ? ` template=${p.template}` : "";
      return `- ${p.path} (${crit}${tpl}) — ${p.purpose}`;
    })
    .join("\n");
}

function domainList(spec: WikiRunSpec): string {
  const domains = spec.domains ?? [];
  if (domains.length === 0) return "(no domains listed)";
  return domains
    .map(
      (d) =>
        `- ${d.id}: ${d.title} — scope: ${d.scope}` +
        (d.questions?.length ? `\n  questions: ${d.questions.join("; ")}` : ""),
    )
    .join("\n");
}

/** Type values aligned with skill templates + OKF. */
export function typeForTemplate(template?: string, path?: string): string {
  if (template === "overview" || path === "overview.md") return "Overview";
  if (template === "architecture") return "Architecture";
  if (template === "module") return "Module";
  if (template === "flow") return "Flow";
  if (template === "concept") return "Concept";
  if (path?.endsWith("architecture.md")) return "Architecture";
  return "Concept";
}

/**
 * Root writer live user prompt — must drive full Spec pages, not a stub index.
 */
export function rootWritePrompt(input: {
  layout: RunWorkdirLayout;
  spec: WikiRunSpec;
  wikiLanguage?: WikiLanguage;
  multiSource?: boolean;
  receiptIndex?: string;
  repairDefects?: string;
  isRefresh?: boolean;
}): string {
  const paths = runWorkdirPromptPaths(input.layout);
  const lang =
    input.wikiLanguage === "zh"
      ? "Write page titles and body prose in Simplified Chinese. Keep paths, identifiers, and Source Citations untranslated."
      : "Write page titles and body prose in English.";
  const citeForm = input.multiSource
    ? "For multiple repositories: [Source](repo:repository-id/path/to/file#L10-L20)."
    : "For a single repository: [Source](repo:path/to/file#L10-L20).";
  const branch = input.isRefresh
    ? "Read skill/references/refresh.md in full (wiki/ already has prior pages)."
    : "Read skill/references/generate.md in full (wiki/ starts empty or fixture-seeded).";
  const receipts =
    input.receiptIndex?.trim() ||
    "List analysis/ for receipt JSON files; re-open load-bearing source spans as needed.";
  const repair = input.repairDefects?.trim()
    ? [
        "",
        "## Repair mode",
        "Blocking defects from the Host review council (fix these issues; do not rewrite unrelated pages unless needed):",
        input.repairDefects.trim(),
      ].join("\n")
    : "";

  return [
    "You are the Open OKF Wiki Root writer.",
    paths,
    "",
    "## Method",
    "1. Read skill/SKILL.md in full.",
    `2. ${branch}`,
    "3. Read analysis/spec.json (living WikiRunSpec) and follow its pages/domains.",
    "4. Read relevant skill/templates/{overview,architecture,module,flow,concept}.md before writing those page kinds.",
    "5. Use only tools: ls, find, grep, read, write, edit. Never use bash.",
    "",
    "## Language",
    lang,
    "",
    "## Spec pages (write every critical path under wiki/)",
    pageList(input.spec),
    "",
    "## Domains (context)",
    domainList(input.spec),
    "",
    "## Evidence receipts",
    receipts,
    "",
    "## Output contract (OKF + product)",
    "- Concept pages (all .md except index.md / log.md): YAML frontmatter with non-empty `type` and `title`.",
    "  Suggested types: Overview, Architecture, Module, Flow, Concept.",
    "- wiki/index.md is a reserved listing only (OKF §6): bullet links to concept pages; NO concept frontmatter; NO Source Citations required.",
    "- Do not put the narrative overview only in index.md — use overview.md (or Spec path) for prose.",
    `- Place verified Source Citations beside facts. ${citeForm}`,
    "- Line numbers must come from read/grep results — never invent ranges.",
    "- Internal links: relative paths ending in .md.",
    "- Cross-link related pages.",
    "",
    "When finished, ensure every critical Spec page exists on disk under wiki/.",
    repair,
  ].join("\n");
}

export function rootWriteSystemPrompt(): string {
  return [
    "You are the Open OKF Wiki producer agent (Root writer).",
    "Use only the provided tools. Never use bash.",
    "Read skill/SKILL.md before writing. Follow analysis/spec.json.",
    "Write Staging Wiki pages under wiki/. Prefer Spec page paths.",
    "Concept pages need type + title frontmatter; index.md is listing-only.",
    "Cite sources with [Source](repo:…) form from real tool line numbers.",
  ].join(" ");
}

export function plannerPrompt(input: {
  layout: RunWorkdirLayout;
  workspaceName: string;
  wikiLanguage?: WikiLanguage;
}): string {
  const paths = runWorkdirPromptPaths(input.layout);
  return [
    "You are planning a source-grounded repository wiki (WikiRunSpec).",
    paths,
    `Workspace name: ${input.workspaceName}`,
    "Using only read tools (ls, find, grep, read), inspect sources/ entry points",
    "(README, package manifests, top-level layout). Do not write files.",
    "",
    "Return a single JSON object (optionally fenced) matching WikiRunSpec:",
    "{",
    '  "summary": string,',
    '  "audience": string,',
    '  "domains": [{ "id", "title", "scope", "critical", "questions": string[] }],',
    '  "pages": [{ "path", "purpose", "domainIds", "questions", "template"?, "critical" }],',
    '  "openQuestions": string[],',
    '  "acceptance": { "reviewRequired": true, "maxRepairRounds": 2, "blockingSeverities": ["blocking"] }',
    "}",
    "",
    "Rules:",
    "- Prefer few domains that isolate independent evidence.",
    "- Always include a critical overview.md (or Spec equivalent) with template overview.",
    "- index.md is a listing file generated/written later — do not list it as a concept page.",
    "- Page paths are relative under wiki/, end with .md.",
    input.wikiLanguage === "zh"
      ? "- Spec summary/purpose/questions may be Chinese; paths stay English filenames."
      : "- Spec prose in English.",
  ].join("\n");
}

export function domainResearchPrompt(input: {
  domainId: string;
  title: string;
  scope: string;
  questions: string[];
  nodeId: string;
  runId: string;
}): string {
  return [
    `Domain research: ${input.title} (${input.domainId})`,
    `Scope: ${input.scope}`,
    "Questions:",
    ...(input.questions.length
      ? input.questions.map((q) => `- ${q}`)
      : ["- What are the main boundaries and entry points in this scope?"]),
    "",
    "Use only read tools (ls, find, grep, read). Never write wiki pages.",
    "Return a concise evidence summary:",
    "- key findings (bullet list)",
    "- source paths with line ranges when known from tools",
    "- open questions",
    `Host will persist this as analysis receipt nodeId=${input.nodeId} runId=${input.runId}.`,
  ].join("\n");
}

export function leafResearchPrompt(input: {
  domainId: string;
  question: string;
  scope: string;
  nodeId: string;
  runId: string;
}): string {
  return [
    `Leaf research under domain ${input.domainId}`,
    `Scope: ${input.scope}`,
    `Question: ${input.question}`,
    "",
    "Use only read tools. Narrow investigation; return findings + source paths + open questions.",
    `nodeId=${input.nodeId} runId=${input.runId}`,
  ].join("\n");
}

export function reviewerPrompt(input: {
  pages: string[];
  lens: "grounding" | "coverage" | "consistency" | "general";
}): string {
  const lensHint = {
    grounding: "Focus on claims without resolvable Source Citations or invented APIs.",
    coverage: "Focus on Spec questions unanswered and missing critical pages.",
    consistency: "Focus on contradictions across pages and term drift.",
    general: "Review Staging Wiki under wiki/ against sources/ and skill/references/review.md.",
  }[input.lens];

  return [
    lensHint,
    "Return JSON: { clean: boolean, defects: [{ severity, code, path, issue }], summary }.",
    "severity is blocking | major | minor.",
    `Pages present: ${input.pages.join(", ") || "(none)"}`,
  ].join("\n");
}
