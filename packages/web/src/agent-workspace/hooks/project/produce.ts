/**
 * Parent-visible produce unit fold (Pi wiki_produce tool trail).
 *
 * Live: tool_execution_update/end on wiki_produce (partialResult/result.details)
 * Cold: toolResult.details + optional okf.produce_progress custom entries
 *
 * Single fold authority: last-by-unitId. Not work_unit / not dual units{} store.
 */

export const WIKI_PRODUCE_TOOL_NAME = "wiki_produce" as const;

export type ProduceUnitRole = "domain" | "leaf" | "reviewer" | "root" | "planner" | string;
export type ProduceUnitStatus = "pending" | "running" | "settled" | "failed" | string;

export type ProduceUnitTool = {
  toolCallId: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ProduceUnitMessage = {
  text?: string;
  thinking?: string;
};

/**
 * Operator-visible produce unit (mirrors agent ProduceToolDetails).
 * Nested children optional when aggregated; live/cold patches are usually flat.
 */
export type ProduceUnit = {
  role: ProduceUnitRole;
  status: ProduceUnitStatus;
  unitId?: string;
  task?: string;
  parentId?: string;
  tools?: ProduceUnitTool[];
  message?: ProduceUnitMessage;
  summary?: string;
  receiptPath?: string;
  error?: string;
  children?: ProduceUnit[];
};

/** Stable unit key for last-by-unitId fold. */
export function produceUnitKey(unit: Pick<ProduceUnit, "unitId" | "role">): string {
  return (unit.unitId?.trim() || unit.role || "unit").slice(0, 120);
}

/**
 * Fold a produce progress patch into the unit list (last-by-unitId).
 * Merges fields so partial patches keep prior task/summary/tools when omitted.
 */
export function foldProduceUnit(prev: readonly ProduceUnit[], next: ProduceUnit): ProduceUnit[] {
  const unitId = produceUnitKey(next);
  const patched: ProduceUnit = { ...next, unitId };
  const idx = prev.findIndex((u) => produceUnitKey(u) === unitId);
  if (idx < 0) return [...prev, patched];
  const out = prev.slice();
  const prior = out[idx]!;
  out[idx] = {
    ...prior,
    ...patched,
    unitId,
    // Prefer non-empty tools/message from the patch; keep prior when absent.
    tools: patched.tools ?? prior.tools,
    message: patched.message ?? prior.message,
    task: patched.task ?? prior.task,
    summary: patched.summary ?? prior.summary,
    parentId: patched.parentId ?? prior.parentId,
    receiptPath: patched.receiptPath ?? prior.receiptPath,
    error: patched.status === "failed" ? (patched.error ?? prior.error) : patched.error,
  };
  return out;
}

/** Seed list from cold-load array (already last-by-unitId server-side). */
export function seedProduceUnits(raw: unknown): ProduceUnit[] {
  if (!Array.isArray(raw)) return [];
  let units: ProduceUnit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const u = item as ProduceUnit;
    if (typeof u.role !== "string" || typeof u.status !== "string") continue;
    units = foldProduceUnit(units, u);
  }
  return units;
}

/** Loose parse of SSE / JSON payload into ProduceUnit when shape is valid. */
export function parseProduceUnitPayload(payload: unknown): ProduceUnit | null {
  if (!payload || typeof payload !== "object") return null;
  const u = payload as ProduceUnit;
  if (typeof u.role !== "string" || typeof u.status !== "string") return null;
  return u;
}

/**
 * Extract ProduceUnit tree/patch from Pi tool partialResult or result
 * (`{ content, details }` or bare details).
 */
export function produceUnitFromToolPayload(payload: unknown): ProduceUnit | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  if (rec.details !== undefined) {
    return parseProduceUnitPayload(rec.details);
  }
  return parseProduceUnitPayload(payload);
}

/** Flatten a root tree into unit list for the fold (root + children). */
export function flattenProduceTree(root: ProduceUnit): ProduceUnit[] {
  const out: ProduceUnit[] = [];
  const walk = (u: ProduceUnit) => {
    out.push(u);
    for (const c of u.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Fold tool details (possibly nested tree) into produceUnits state. */
export function foldProduceToolDetails(
  prev: readonly ProduceUnit[],
  details: ProduceUnit,
): ProduceUnit[] {
  let next = prev.slice();
  for (const u of flattenProduceTree(details)) {
    next = foldProduceUnit(next, u);
  }
  return next;
}

/** Roles for AgentTree nav (stable order, unique). */
export function produceUnitRoles(units: readonly ProduceUnit[]): Array<{
  unitId: string;
  role: string;
  status: string;
  task?: string;
}> {
  return units.map((u) => ({
    unitId: produceUnitKey(u),
    role: String(u.role),
    status: String(u.status),
    task: u.task,
  }));
}
