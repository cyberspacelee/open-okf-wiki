/**
 * Plan chrome: data-plan viewer, plan-progress badge, plan from workflow suspend.
 */

import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { useI18n } from "../../../i18n";
import { PlanViewer } from "../PlanViewer";
import { sessionCardMeta } from "../session-card-styles";
import {
  asPlanLike,
  planFromWorkflowDataPart,
} from "./message-part-utils";

export function PlanProgressBadge({
  written,
  total,
}: {
  written: number;
  total: number;
}) {
  const { t } = useI18n();
  const text = t.session.tools.pagesWritten
    .replace("{written}", String(written))
    .replace("{total}", String(total));
  return (
    <p className={`mb-2 ${sessionCardMeta}`} data-testid="session-plan-progress">
      {text}
    </p>
  );
}

export function renderPlanPart(
  key: string,
  part: UIMessage["parts"][number],
  opts: {
    writtenPaths: ReadonlySet<string> | readonly string[];
  },
): ReactNode {
  if (part.type === "data-plan") {
    const data = "data" in part ? part.data : undefined;
    const plan = asPlanLike(data);
    if (plan) {
      return (
        <div key={key}>
          <PlanViewer plan={plan} writtenPaths={opts.writtenPaths} />
        </div>
      );
    }
    return null;
  }

  if (part.type === "data-plan-progress") {
    // Prefer RunPagesQueue chrome at message top; keep compact badge as live pulse.
    // writtenPaths come only from data-plan-progress (Phase 1) — never invent tool paths.
    const data = "data" in part ? part.data : undefined;
    if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as { pages?: unknown }).pages)
    ) {
      const pages = (data as { pages: Array<{ status?: string }> }).pages;
      const written = pages.filter((p) => p.status === "written").length;
      return (
        <PlanProgressBadge key={key} written={written} total={pages.length} />
      );
    }
    return null;
  }

  return undefined;
}

/** Extract plan from workflow data parts when no dedicated data-plan exists. */
export function renderPlanFromWorkflow(
  key: string,
  part: UIMessage["parts"][number],
  opts: {
    writtenPaths: ReadonlySet<string> | readonly string[];
    hasDataPlan: boolean;
  },
): ReactNode {
  if (opts.hasDataPlan) {
    return undefined;
  }
  if (
    part.type !== "data-workflow" &&
    part.type !== "data-workflow-step"
  ) {
    return undefined;
  }
  const data = "data" in part ? part.data : undefined;
  const plan =
    planFromWorkflowDataPart(data) ||
    (part.type === "data-workflow-step" && data && typeof data === "object"
      ? asPlanLike(
          (
            (
              data as {
                step?: { suspendPayload?: { plan?: unknown } };
              }
            ).step?.suspendPayload as { plan?: unknown } | undefined
          )?.plan,
        ) ||
        asPlanLike(
          (data as { suspendPayload?: { plan?: unknown } }).suspendPayload
            ?.plan,
        )
      : null);
  if (plan) {
    return (
      <div key={key} data-testid="session-plan-from-workflow">
        <PlanViewer plan={plan} writtenPaths={opts.writtenPaths} />
      </div>
    );
  }
  return undefined;
}
