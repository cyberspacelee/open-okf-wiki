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
 * Chronological trail item for one produce unit (message segments interleaved
 * with tools — matches Pi turn order instead of "all text then all tools").
 */
export type ProduceUnitTrailItem =
  | { kind: "message"; text?: string; thinking?: string }
  | { kind: "tool"; tool: ProduceUnitTool };

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
  /**
   * Ordered message/tool trail when the host provides it.
   * Prefer over separate message+tools for render order.
   */
  trail?: ProduceUnitTrailItem[];
  summary?: string;
  receiptPath?: string;
  error?: string;
  children?: ProduceUnit[];
  /** First-seen sequence for stable chronological list order (UI). */
  seq?: number;
};

/** Stable unit key for last-by-unitId fold. */
export function produceUnitKey(unit: Pick<ProduceUnit, "unitId" | "role">): string {
  return (unit.unitId?.trim() || unit.role || "unit").slice(0, 120);
}

/**
 * Fold a produce progress patch into the unit list (last-by-unitId).
 * Merges fields so partial patches keep prior task/summary/tools when omitted.
 * New units always append (chronological: older first, newer last).
 * Never reorders existing units — updates stay in place.
 */
export function foldProduceUnit(prev: readonly ProduceUnit[], next: ProduceUnit): ProduceUnit[] {
  const unitId = produceUnitKey(next);
  const idx = prev.findIndex((u) => produceUnitKey(u) === unitId);
  if (idx < 0) {
    const seq =
      typeof next.seq === "number"
        ? next.seq
        : prev.reduce((max, u) => Math.max(max, typeof u.seq === "number" ? u.seq : -1), -1) + 1;
    return [...prev, { ...next, unitId, seq }];
  }
  const out = prev.slice();
  const prior = out[idx]!;
  out[idx] = {
    ...prior,
    ...next,
    unitId,
    // Preserve first-seen order key.
    seq: prior.seq,
    // Prefer non-empty tools/message/trail from the patch; keep prior when absent.
    tools: next.tools ?? prior.tools,
    message: next.message ?? prior.message,
    trail: next.trail ?? prior.trail,
    task: next.task ?? prior.task,
    summary: next.summary ?? prior.summary,
    parentId: next.parentId ?? prior.parentId,
    receiptPath: next.receiptPath ?? prior.receiptPath,
    error: next.status === "failed" ? (next.error ?? prior.error) : next.error,
  };
  return out;
}

/**
 * Chronological display order: first-seen seq ascending (older units first).
 * Defensive sort so callers never reverse-stack new domain cards above old ones.
 */
export function orderProduceUnits(units: readonly ProduceUnit[]): ProduceUnit[] {
  return units
    .map((u, i) => ({ u, i, seq: typeof u.seq === "number" ? u.seq : i }))
    .sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.i - b.i))
    .map((x) => x.u);
}

/**
 * Rebuild parentId edges into a nested tree (domain → leaf).
 * Children ordered by first-seen seq. Does not mutate inputs.
 */
export function buildProduceTree(units: readonly ProduceUnit[]): ProduceUnit[] {
  const ordered = orderProduceUnits(units);
  if (ordered.length === 0) return [];

  type Node = ProduceUnit & { children?: ProduceUnit[] };
  const byId = new Map<string, Node>();
  for (const u of ordered) {
    const id = produceUnitKey(u);
    byId.set(id, { ...u, unitId: id, children: undefined });
  }

  const childIds = new Set<string>();
  for (const u of ordered) {
    const id = produceUnitKey(u);
    const parentId = u.parentId?.trim();
    if (!parentId || parentId === id || !byId.has(parentId)) continue;
    const parent = byId.get(parentId)!;
    const child = byId.get(id)!;
    parent.children = [...(parent.children ?? []), child];
    childIds.add(id);
  }

  const roots: Node[] = [];
  for (const u of ordered) {
    const id = produceUnitKey(u);
    if (!childIds.has(id)) roots.push(byId.get(id)!);
  }
  return roots;
}

/**
 * Top-level units for the wiki_produce trail.
 * If a single synthetic `root` wraps everything, surface its children so the
 * operator sees planner/domain/… directly under the tool card.
 */
export function produceDisplayRoots(units: readonly ProduceUnit[]): ProduceUnit[] {
  const tree = buildProduceTree(units);
  if (
    tree.length === 1 &&
    String(tree[0]!.role) === "root" &&
    (tree[0]!.children?.length ?? 0) > 0
  ) {
    return tree[0]!.children!;
  }
  return tree;
}

/** True when any unit is still in-flight (drives wiki_produce default expand). */
export function produceUnitsActive(units: readonly ProduceUnit[]): boolean {
  return units.some((u) => u.status === "running" || u.status === "pending");
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
