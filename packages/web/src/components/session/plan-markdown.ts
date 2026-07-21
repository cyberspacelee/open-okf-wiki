/** Shared plan → Markdown for Session UI (inline + fullscreen). */

export type PlanLike = {
  summary: string;
  pages: Array<{ path: string; purpose: string }>;
  notes?: string;
};

export function planToMarkdown(plan: PlanLike): string {
  const lines = [
    "## Proposed wiki plan",
    "",
    plan.summary,
    "",
    "### Pages",
    ...plan.pages.map((p) => `- \`${p.path}\` — ${p.purpose}`),
  ];
  if (plan.notes?.trim()) {
    lines.push("", "### Notes", "", plan.notes.trim());
  }
  return lines.join("\n");
}
