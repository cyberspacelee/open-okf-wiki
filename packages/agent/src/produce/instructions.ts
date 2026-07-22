/**
 * Root agent instruction builders (language + host-enforced ignores).
 */

import type { WorkspaceConfig } from "@okf-wiki/contract";
import { effectiveIgnoresForSource } from "@okf-wiki/core";

export function wikiLanguageInstruction(workspace: WorkspaceConfig): string {
  const lang = workspace.wikiLanguage ?? "en";
  if (lang === "zh") {
    return [
      "## Output language",
      "Write all Wiki page content in Simplified Chinese (简体中文).",
      "Frontmatter `title` values and body prose must be Chinese.",
      "Keep Source Citations, file paths, code identifiers, and relative `.md` links unchanged (do not translate paths).",
    ].join("\n");
  }
  return [
    "## Output language",
    "Write all Wiki page content in English.",
    "Frontmatter `title` values and body prose must be English.",
    "Keep Source Citations, file paths, code identifiers, and relative `.md` links unchanged.",
  ].join("\n");
}

export function formatEffectiveIgnoresSection(
  workspace: WorkspaceConfig,
): string {
  if (workspace.sources.length === 0) {
    return "## Effective Source Ignores\n(no sources)";
  }
  const blocks = workspace.sources.map((s) => {
    const ignores = effectiveIgnoresForSource(s);
    const flag =
      s.applyDefaultIgnores === false
        ? "applyDefaultIgnores=false (user patterns only)"
        : "applyDefaultIgnores=true (defaults + user)";
    const list =
      ignores.length === 0
        ? "  (none)"
        : ignores.map((p) => `  - ${p}`).join("\n");
    return [`### source \`${s.id}\` (${flag})`, list].join("\n");
  });
  return [
    "## Effective Source Ignores (host-enforced)",
    "These patterns are applied by the Run Boundary on every list_source, read_source, glob_source, and search_source call.",
    "Ignored paths are omitted from listings and cannot be read. Do not invent a second exclusion policy.",
    "Do not use shell or raw filesystem APIs to bypass these filters.",
    ...blocks,
  ].join("\n");
}

export function buildInstructions(workspace: WorkspaceConfig): string {
  const sourceList = workspace.sources
    .map((s) => `- ${s.id}: ${s.path}`)
    .join("\n");
  return [
    "You are the OKF Wiki Root Agent for a single Wiki Run.",
    "Follow the producer skill strictly.",
    "",
    "## Run instructions",
    "1. Activate/load the Producer Skill (Mastra skill tools and/or read_skill). Start with SKILL.md, then references/templates as needed.",
    "2. Explore sources with list_source, glob_source, search_source, and read_source (read-only, multi-root by sourceId).",
    "   - glob_source: find files by name pattern (e.g. **/*Listener.java)",
    "   - search_source: content regex; results include true 1-based line numbers",
    "   - read_source: returns numbered lines `N| text` plus lineCount — cite only within lineCount",
    "   Source paths may live outside the workspace root; never assume sources are under cwd.",
    "   Effective Source Ignores are host-enforced on those tools (see section below).",
    "3. Write final Markdown pages under the wiki staging area with write_wiki.",
    "   Prefer writing planned pages as soon as you have enough evidence; do not only explore.",
    "4. Every page MUST start with YAML frontmatter containing a non-empty `title`.",
    "5. Prefer a small coherent page set (e.g. overview.md plus architecture/module as needed).",
    "6. When finished, reply with a short plain-text summary listing the wiki-relative page paths you wrote.",
    "",
    "## Source Citations",
    "- Format: [Source](repo:path#Lstart-Lend) or multi-repo [Source](repo:sourceId/path#Lstart-Lend).",
    "- Line numbers are 1-based inclusive and MUST be ≤ read_source lineCount (or a search_source hit line).",
    "- The `N|` prefix in read_source content is metadata only — never copy it into wiki prose or citations.",
    "- Do not invent or estimate line ranges. Re-read if unsure.",
    "",
    wikiLanguageInstruction(workspace),
    "",
    formatEffectiveIgnoresSection(workspace),
    "",
    "Do not use shell/git clone/fetch. Use only the provided tools.",
    "Do not invent source citations without reading or searching the cited files.",
    "Do not cite or describe paths that tools never returned or that were rejected as ignored.",
    "",
    `Workspace root (agent cwd): ${workspace.rootPath}`,
    `Workspace: ${workspace.name} (${workspace.id})`,
    `Wiki language: ${workspace.wikiLanguage ?? "en"}`,
    "Sources:",
    sourceList || "- (none)",
  ].join("\n");
}
