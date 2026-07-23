/**
 * Localize product timeline strip body from structured AgentProductMeta.
 * Projection stores structure + optional English fallback content; UI formats here.
 */

import { formatMessage } from "../../../i18n/format.ts";
import type { MessageTree } from "../../../i18n/en.ts";
import type { AgentProductMeta, PlanProgressPage } from "./types.ts";

type AgentWorkspaceCopy = MessageTree["agentWorkspace"];

function phaseHead(phase: string | undefined, t: AgentWorkspaceCopy): string {
  if (!phase) return t.productCopy.working;
  const map = t.phases as Record<string, string>;
  if (phase in map) return map[phase]!;
  return phase.replace(/_/g, " ") || t.productCopy.working;
}

/**
 * Render product card body for the operator locale.
 * Prefer structured `product` fields; `contentFallback` only if structure is empty.
 */
export function formatProductCardContent(
  product: AgentProductMeta,
  t: AgentWorkspaceCopy,
  contentFallback?: string,
): string {
  const c = t.productCopy;
  switch (product.kind) {
    case "work_block":
      return "";
    case "run_phase": {
      const head = phaseHead(product.phase, t);
      const msg = product.label?.trim();
      if (msg) return formatMessage(c.withDetail, { head, detail: msg });
      return head;
    }
    case "gate": {
      if (product.gate === "plan") {
        const pages = product.pages;
        const n = Array.isArray(pages) ? pages.length : 0;
        if (n > 0) return formatMessage(c.gatePlanPages, { n });
        return c.gatePlan;
      }
      if (product.gate === "publication") return c.gatePublish;
      return product.question?.trim() || c.gateInput;
    }
    case "run_link": {
      const id = product.runId ? product.runId.slice(0, 8) : "—";
      if (product.status) {
        return formatMessage(c.runLinkStatus, {
          id,
          status: String(product.status).replace(/_/g, " "),
        });
      }
      return formatMessage(c.runLink, { id });
    }
    case "progress": {
      const head = phaseHead(product.phase, t);
      const label = product.label?.trim();
      if (label) return formatMessage(c.withDetail, { head, detail: label });
      return head;
    }
    case "plan_progress": {
      const pages = Array.isArray(product.pages) ? product.pages : [];
      const done = pages.filter(
        (p) =>
          typeof p === "object" &&
          p &&
          "status" in p &&
          (p as PlanProgressPage).status === "done",
      ).length;
      const total = pages.length;
      const lines = pages.slice(0, 12).map((p) => {
        if (typeof p === "string") return `· ${p}`;
        const pg = p as PlanProgressPage;
        const mark =
          pg.status === "done" ? "✓" : pg.status === "writing" ? "…" : "·";
        return `${mark} ${pg.path}`;
      });
      const more =
        pages.length > 12
          ? `\n${formatMessage(c.pagesMore, { n: pages.length - 12 })}`
          : "";
      return (
        [formatMessage(c.writingPages, { done, total }), ...lines].join("\n") +
        more
      );
    }
    case "defects": {
      const round = product.round ?? 1;
      if (product.clean) {
        return formatMessage(c.defectsClean, { round });
      }
      return formatMessage(c.defectsFound, {
        count: product.defectCount ?? 0,
        round,
      });
    }
  }
  return contentFallback?.trim() || "";
}
