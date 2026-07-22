/**
 * Shared helpers for Session timeline data-* part rendering.
 */

import type { PendingInteraction } from "../decision-types";
import type { PlanLike } from "../plan-markdown";
import type { SessionCardStatus } from "../SessionCard";
import type { useI18n } from "../../../i18n";

/** Product data-* parts that may appear on the operator timeline. */
export const DATA_PART_WHITELIST = new Set([
  "data-gate",
  "data-plan",
  "data-plan-progress",
  "data-defects",
  "data-progress",
  "data-agent-span",
  "data-sources-index",
  "data-run",
  "data-workflow",
  "data-workflow-step",
  "data-tool-workflow",
  "data-tool-agent",
]);

export function redactUnknown(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  }
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      if (s.length > 800) {
        return JSON.parse(
          s.replace(
            /"content"\s*:\s*"(?:\\.|[^"\\]){20,}"/g,
            '"content":"[omitted]"',
          ),
        );
      }
      return value;
    } catch {
      return "[unserializable]";
    }
  }
  return value;
}

export function asDecision(input: unknown): PendingInteraction | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const o = input as Record<string, unknown>;
  if (typeof o.question !== "string") {
    return null;
  }
  const options = Array.isArray(o.options) ? o.options : [];
  return {
    type: (o.type as PendingInteraction["type"]) ?? "choice",
    question: o.question,
    mode: (o.mode as PendingInteraction["mode"]) ?? "choice_or_input",
    selectionMode: (o.selectionMode as "single" | "multi") ?? "single",
    options: options
      .filter((x): x is { id: string; label: string; description?: string } =>
        Boolean(x && typeof x === "object" && "id" in x && "label" in x),
      )
      .map((x) => ({
        id: String(x.id),
        label: String(x.label),
        description:
          typeof x.description === "string" ? x.description : undefined,
      })),
    inputPlaceholder:
      typeof o.inputPlaceholder === "string" ? o.inputPlaceholder : undefined,
    toolCallId: typeof o.toolCallId === "string" ? o.toolCallId : undefined,
  };
}

export function asPlanLike(value: unknown): PlanLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.summary !== "string" || !Array.isArray(o.pages)) {
    return null;
  }
  const pages = o.pages
    .filter(
      (p): p is { path: string; purpose: string } =>
        Boolean(
          p &&
            typeof p === "object" &&
            typeof (p as { path?: unknown }).path === "string" &&
            typeof (p as { purpose?: unknown }).purpose === "string",
        ),
    )
    .map((p) => ({ path: p.path, purpose: p.purpose }));
  if (pages.length === 0) {
    return null;
  }
  return {
    summary: o.summary,
    pages,
    notes: typeof o.notes === "string" ? o.notes : undefined,
  };
}

export function planFromWorkflowDataPart(data: unknown): PlanLike | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const steps = (data as { steps?: unknown }).steps;
  if (!steps || typeof steps !== "object") {
    return null;
  }
  for (const step of Object.values(steps as Record<string, unknown>)) {
    if (!step || typeof step !== "object") {
      continue;
    }
    const status = (step as { status?: unknown }).status;
    const payload = (step as { suspendPayload?: unknown }).suspendPayload;
    if (status !== "suspended" || !payload || typeof payload !== "object") {
      continue;
    }
    if ((payload as { gate?: unknown }).gate === "plan") {
      const plan = asPlanLike((payload as { plan?: unknown }).plan);
      if (plan) {
        return plan;
      }
    }
  }
  return null;
}

export function workflowProgressLabel(data: unknown, partType: string): string {
  if (!data || typeof data !== "object") {
    return partType.replace(/^data-/, "");
  }
  const d = data as Record<string, unknown>;
  const status = typeof d.status === "string" ? d.status : undefined;
  const name =
    (typeof d.name === "string" && d.name) ||
    (d.step &&
    typeof d.step === "object" &&
    typeof (d.step as { name?: string }).name === "string"
      ? (d.step as { name: string }).name
      : undefined) ||
    (typeof d.runId === "string" ? d.runId.slice(0, 8) : undefined);
  if (name && status) {
    return `${name}: ${status}`;
  }
  return status || name || partType.replace(/^data-/, "");
}

export function workflowErrorFromData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const d = data as Record<string, unknown>;
  if (typeof d.error === "string" && d.error.trim()) {
    return d.error.trim();
  }
  if (d.steps && typeof d.steps === "object") {
    for (const [id, step] of Object.entries(
      d.steps as Record<string, unknown>,
    )) {
      if (!step || typeof step !== "object") {
        continue;
      }
      const s = step as Record<string, unknown>;
      if (s.status === "failed" || s.status === "error") {
        if (typeof s.error === "string" && s.error.trim()) {
          return `${id}: ${s.error.trim()}`;
        }
        return `${id} failed`;
      }
    }
  }
  return undefined;
}

export function isNoisyWorkflowPart(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const status = String(
    (data as { status?: unknown }).status ?? "",
  ).toLowerCase();
  return status === "running" || status === "waiting" || status === "pending";
}

export function localizeDecisionOption(
  opt: PendingInteraction["options"][number],
  t: ReturnType<typeof useI18n>["t"],
): PendingInteraction["options"][number] {
  const blob = `${opt.label} ${opt.description ?? ""}`;
  switch (opt.id) {
    case "publish_now":
      return { ...opt, label: t.planConfirm.chipPublish };
    case "keep_staging":
      return { ...opt, label: t.planConfirm.chipKeepStaging };
    case "revise":
    case "request_changes":
    case "request-changes":
      return { ...opt, label: t.planConfirm.chipRevise };
    case "approve":
    case "approve_write": {
      if (/publish/i.test(blob)) {
        return { ...opt, label: t.planConfirm.chipPublish };
      }
      const n =
        Number(/(\d+)/.exec(opt.label)?.[1]) ||
        (opt.description
          ? opt.description.split(",").map((s) => s.trim()).filter(Boolean)
              .length
          : 0) ||
        1;
      return {
        ...opt,
        label: t.planConfirm.chipWrite.replace("{n}", String(n)),
      };
    }
    case "deny":
    case "reject_plan":
      if (/staging|keep/i.test(blob)) {
        return { ...opt, label: t.planConfirm.chipKeepStaging };
      }
      return { ...opt, label: t.planConfirm.chipDeny };
    default:
      return opt;
  }
}

export function workflowCardStatus(
  status: string,
  failed: boolean,
): SessionCardStatus {
  if (failed) {
    return "failed";
  }
  if (/success|complete|done|finish/i.test(status)) {
    return "completed";
  }
  if (/run|stream|active|start|suspend/i.test(status)) {
    return "running";
  }
  return "idle";
}
