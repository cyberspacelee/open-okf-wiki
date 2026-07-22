/**
 * Operator-facing plan rendering helpers for SessionTurn.
 */

import type { WikiRunPlan } from "@okf-wiki/contract";

/** Render a WikiRunSpec as operator-facing Markdown (fullscreen / transcript). */
export function planToMarkdown(plan: WikiRunPlan): string {
  const lines = [
    "## Proposed wiki Spec",
    "",
    plan.summary,
    "",
    `**Audience:** ${plan.audience ?? "—"}`,
    "",
  ];
  if (plan.domains?.length) {
    lines.push(
      "### Domains",
      ...plan.domains.map(
        (d) =>
          `- **${d.title}** (\`${d.id}\`${d.critical ? ", critical" : ""}) — ${d.scope}`,
      ),
      "",
    );
  }
  lines.push(
    "### Pages",
    ...plan.pages.map((p) => {
      const qs =
        p.questions?.length > 0
          ? ` _(questions: ${p.questions.slice(0, 3).join("; ")})_`
          : "";
      return `- \`${p.path}\` — ${p.purpose}${qs}`;
    }),
  );
  if (plan.openQuestions?.length) {
    lines.push(
      "",
      "### Open questions",
      ...plan.openQuestions.map((q) => `- ${q}`),
    );
  }
  if (plan.notes?.trim()) {
    lines.push("", "### Notes", "", plan.notes.trim());
  }
  if (plan.changelog?.length) {
    lines.push(
      "",
      "### Changelog",
      ...plan.changelog.map((c) => `- ${c}`),
    );
  }
  return lines.join("\n");
}
