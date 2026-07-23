/**
 * WorkUnits fold cache (last-by-unitId). Not durability authority.
 */

import type { ProductWorkUnitEvent, WorkUnitStatus } from "@okf-wiki/contract";
import { compactToolInput, formatToolResultText } from "./format.ts";
import type {
  AgentToolCall,
  WorkUnitEventLike,
  WorkUnits,
  WorkUnitView,
} from "./types.ts";

function normalizeWorkUnitStatus(status: string): WorkUnitStatus {
  if (
    status === "pending" ||
    status === "running" ||
    status === "settled" ||
    status === "failed"
  ) {
    return status;
  }
  // Defensive map for legacy chip strings if any leak through cold load.
  if (status === "complete" || status === "done") return "settled";
  if (status === "error" || status === "streaming") {
    return status === "error" ? "failed" : "running";
  }
  return "pending";
}

/**
 * True when a unit has any body content (thinking / text / tools / summary / error).
 * Empty running units must use waitingForEvents, never "Thinking".
 */
export function workUnitHasBody(unit: WorkUnitView | null | undefined): boolean {
  if (!unit) return false;
  if (unit.message?.thinking?.trim()) return true;
  if (unit.message?.text?.trim()) return true;
  if (unit.tools && unit.tools.length > 0) return true;
  if (unit.summary?.trim()) return true;
  if (unit.error?.trim()) return true;
  return false;
}

/** Map WorkUnit tools into AgentToolCall for shared ToolExecutionCard chrome. */
export function workUnitToolsToAgentTools(
  tools: WorkUnitView["tools"] | undefined,
): AgentToolCall[] {
  if (!tools?.length) return [];
  return tools.map((t) => ({
    id: t.toolCallId,
    name: t.toolName,
    input: compactToolInput(t.input),
    output: t.errorText
      ? t.errorText
      : formatToolResultText(t.output),
    status:
      t.state === "output-error"
        ? ("error" as const)
        : t.state === "output-available"
          ? ("done" as const)
          : t.state === "input-available" || t.state === "input-streaming"
            ? ("running" as const)
            : ("pending" as const),
  }));
}

/**
 * Last-write fold by unitId. Status mapped as-is (pending|running|settled|failed).
 */
export function applyWorkUnit(
  units: WorkUnits,
  event: WorkUnitEventLike | ProductWorkUnitEvent,
): WorkUnits {
  const unitId =
    typeof event.unitId === "string" ? event.unitId.trim() : "";
  if (!unitId) return units;

  const prev = units[unitId];
  const status = normalizeWorkUnitStatus(String(event.status ?? "pending"));
  const next: WorkUnitView = {
    unitId,
    role:
      typeof event.role === "string" && event.role.trim()
        ? event.role.trim()
        : (prev?.role ?? "agent"),
    status,
    runId:
      typeof event.runId === "string" && event.runId
        ? event.runId
        : prev?.runId,
    task:
      typeof event.task === "string"
        ? event.task
        : prev?.task,
    parentId:
      typeof event.parentId === "string"
        ? event.parentId
        : prev?.parentId,
    message: event.message
      ? {
          thinking: event.message.thinking ?? prev?.message?.thinking,
          text: event.message.text ?? prev?.message?.text,
        }
      : prev?.message,
    tools: event.tools !== undefined ? event.tools : prev?.tools,
    summary:
      typeof event.summary === "string"
        ? event.summary
        : prev?.summary,
    receiptPath:
      typeof event.receiptPath === "string"
        ? event.receiptPath
        : prev?.receiptPath,
    error:
      typeof event.error === "string"
        ? event.error
        : status === "failed"
          ? prev?.error
          : status === "settled"
            ? undefined
            : prev?.error,
    updatedAt:
      typeof event.updatedAt === "number"
        ? event.updatedAt
        : (prev?.updatedAt ?? Date.now()),
  };

  // When message is partial-patched above, fill missing side from prev if event
  // only sent one of thinking/text (already handled via ??).
  return { ...units, [unitId]: next };
}

/** Seed units fold cache from durable cold-load workUnits array. */
export function workUnitsFromList(
  list: WorkUnitEventLike[] | undefined,
): WorkUnits {
  if (!list?.length) return {};
  let units: WorkUnits = {};
  for (const row of list) {
    if (!row?.unitId) continue;
    units = applyWorkUnit(units, {
      ...row,
      kind: "work_unit",
      status: row.status ?? "pending",
      role: row.role ?? "agent",
    });
  }
  return units;
}
