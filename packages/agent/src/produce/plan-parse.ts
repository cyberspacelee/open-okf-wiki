/** Parse the Planner response into the one executable WikiRunSpec shape. */

import { type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompleteSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = [
    "version",
    "summary",
    "audience",
    "domains",
    "pages",
    "openQuestions",
    "acceptance",
    "changelog",
  ];
  if (!required.every((key) => key in value)) return false;
  if (!Array.isArray(value.domains) || !Array.isArray(value.pages)) return false;
  if (
    !value.domains.every(
      (domain) =>
        isRecord(domain) &&
        ["id", "title", "scope", "critical", "questions"].every((key) => key in domain),
    )
  ) {
    return false;
  }
  if (
    !value.pages.every(
      (page) =>
        isRecord(page) &&
        ["path", "purpose", "domainIds", "questions", "critical"].every((key) => key in page),
    )
  ) {
    return false;
  }
  const acceptance = value.acceptance;
  return (
    isRecord(acceptance) &&
    ["reviewRequired", "maxRepairRounds", "blockingSeverities"].every((key) => key in acceptance)
  );
}

/**
 * Accept a complete WikiRunSpec as raw or fenced JSON.
 *
 * Markdown page lists and thin `{ summary, pages }` plans are intentionally
 * rejected: accepting them made the live Planner silently succeed with an
 * invented default Spec instead of failing closed.
 */
export function parsePlanFromAgentText(text: string): WikiRunSpec {
  const raw = text?.trim() ?? "";
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fence?.[1]?.trim(), raw].filter(
    (candidate, index, values): candidate is string =>
      Boolean(candidate) && values.indexOf(candidate) === index,
  );

  for (const candidate of candidates) {
    try {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (!isCompleteSpec(value)) continue;
      const parsed = WikiRunSpecSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next representation before failing closed.
    }
  }

  throw new Error("Planner did not return a complete JSON WikiRunSpec");
}
