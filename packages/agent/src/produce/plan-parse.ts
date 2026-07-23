/**
 * Parse model plan text into a WikiRunSpec.
 */

import { defaultWikiRunSpec, type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract";

/**
 * Parse a model plan into a WikiRunSpec.
 * Accepts fenced JSON Spec/plan shapes or Markdown page lists.
 * Falls back to prior Spec pages or defaultWikiRunSpec.
 */
export function parsePlanFromAgentText(
  text: string,
  options: {
    workspaceName: string;
    prior?: WikiRunSpec;
  },
): WikiRunSpec {
  const raw = text?.trim() ?? "";
  const pages: Array<{ path: string; purpose: string }> = [];
  const seen = new Set<string>();

  // Prefer fenced JSON Spec (or legacy { summary, pages }) when present.
  const jsonFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (jsonFence?.[1]) {
    try {
      const parsed = JSON.parse(jsonFence[1]!) as Record<string, unknown>;
      const asSpec = WikiRunSpecSchema.safeParse({
        ...parsed,
        ...(options.prior?.notes && !parsed.notes ? { notes: options.prior.notes } : {}),
      });
      if (asSpec.success && asSpec.data.pages.length > 0) {
        return asSpec.data;
      }
      if (Array.isArray(parsed.pages)) {
        for (const item of parsed.pages) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const pathVal = String((item as { path?: unknown }).path ?? "").trim();
          const purposeVal = String((item as { purpose?: unknown }).purpose ?? "").trim();
          if (!pathVal || !purposeVal || seen.has(pathVal)) {
            continue;
          }
          seen.add(pathVal);
          pages.push({
            path: pathVal.slice(0, 200),
            purpose: purposeVal.slice(0, 500),
          });
        }
      }
      if (pages.length > 0) {
        const summary =
          (typeof parsed.summary === "string" && parsed.summary.trim()) ||
          raw
            .split("\n")
            .find((l) => l.trim() && !l.trim().startsWith("```"))
            ?.trim() ||
          `Proposed wiki plan for ${options.workspaceName}`;
        return WikiRunSpecSchema.parse({
          summary: summary.slice(0, 1500),
          pages: pages.map((p) => ({
            ...p,
            domainIds: ["core"],
            questions: [p.purpose],
            critical: true,
          })),
          domains: [
            {
              id: "core",
              title: "Core",
              scope: "Primary repository scope",
              critical: true,
              questions: pages.map((p) => p.purpose).slice(0, 8),
            },
          ],
          ...(options.prior?.notes
            ? { notes: options.prior.notes }
            : typeof parsed.notes === "string" && parsed.notes.trim()
              ? { notes: parsed.notes.trim().slice(0, 4000) }
              : {}),
        });
      }
    } catch {
      // fall through to list parsing
    }
  }

  const lineRe = /^[\s>*-]*\**`?([A-Za-z0-9_./-]+\.md)`?\**\s*[-—:–]\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(raw)) !== null) {
    const pathVal = match[1]!.trim();
    const purposeVal = match[2]!.replace(/\*\*/g, "").trim();
    if (!pathVal || !purposeVal || seen.has(pathVal)) {
      continue;
    }
    seen.add(pathVal);
    pages.push({
      path: pathVal.slice(0, 200),
      purpose: purposeVal.slice(0, 500),
    });
  }

  // Summary: first non-empty non-list line, or first heading body.
  let summary = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("```") || t.startsWith("#")) {
      if (t.startsWith("#")) {
        const heading = t.replace(/^#+\s*/, "").trim();
        if (heading && !summary) {
          summary = heading;
        }
      }
      continue;
    }
    if (/^[-*+]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      continue;
    }
    summary = t;
    break;
  }
  if (!summary) {
    summary = options.prior?.summary || `Proposed wiki plan for ${options.workspaceName}`;
  }

  if (pages.length === 0 && options.prior?.pages?.length) {
    return WikiRunSpecSchema.parse({
      ...options.prior,
      summary: summary.slice(0, 1500),
      ...(options.prior.notes ? { notes: options.prior.notes } : {}),
    });
  }

  if (pages.length === 0) {
    return defaultWikiRunSpec(options.workspaceName);
  }

  return WikiRunSpecSchema.parse({
    summary: summary.slice(0, 1500),
    pages: pages.map((p) => ({
      ...p,
      domainIds: ["core"],
      questions: [p.purpose],
      critical: true,
    })),
    domains: [
      {
        id: "core",
        title: "Core",
        scope: "Primary repository scope",
        critical: true,
        questions: pages.map((p) => p.purpose).slice(0, 8),
      },
    ],
    ...(options.prior?.notes ? { notes: options.prior.notes } : {}),
  });
}
