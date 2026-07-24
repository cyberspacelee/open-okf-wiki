/**
 * Produce parent-session-visible trail (ADR 0031 / Pi tool shape).
 *
 * Maps host-local ProduceProgress → stable ProduceToolDetails.
 *
 * Authority (official Pi):
 * - **Live**: parent Session `wiki_produce` tool_execution_update via onUpdate
 * - **Cold**: toolResult.details on parent JSONL (+ optional custom entries)
 *
 * Custom type `okf.produce_progress` remains for mid-run / settle durability
 * without polluting LLM context (session-format custom entries).
 *
 * Not a product work_unit inject.
 */

import type {
  ProduceAgentRole,
  ProduceProgress,
  ProduceProgressMessage,
  ProduceProgressStatus,
  ProduceProgressTool,
} from "../events.js";

/** Durable parent Pi custom entry type (settle/fail only). */
export const OKF_PRODUCE_PROGRESS_CUSTOM_TYPE = "okf.produce_progress" as const;

/**
 * Stable JSON shape for the operator web card / parent-visible produce unit.
 * Nested `children` form the domain → leaf (etc.) tree when aggregated.
 */
export type ProduceToolDetails = {
  role: ProduceAgentRole;
  status: ProduceProgressStatus;
  unitId?: string;
  task?: string;
  /**
   * Flat routing only (unit patches / custom entries). Omitted when the unit
   * is nested under a parent's `children` array in the aggregated tree.
   */
  parentId?: string;
  tools?: ProduceProgressTool[];
  message?: ProduceProgressMessage;
  summary?: string;
  receiptPath?: string;
  error?: string;
  children?: ProduceToolDetails[];
};

/** Minimal SessionManager surface used for settle/fail custom entries. */
export type ProduceProgressSessionManager = {
  appendCustomEntry(customType: string, data?: unknown): string;
};

export type CreateProduceProgressBridgeOpts = {
  /**
   * Called on every unit details update (mapped patch for the unit that
   * changed). Prefer onTree for parent tool onUpdate.
   */
  onDetails?: (details: ProduceToolDetails) => void;
  /**
   * Called after each progress fold with the nested root tree.
   * Wire to parent wiki_produce tool onUpdate (Pi partialResult.details).
   */
  onTree?: (tree: ProduceToolDetails) => void;
  /**
   * Optional parent Operator Session manager.
   * appendCustomEntry("okf.produce_progress") for mid-run throttle + settle/fail
   * (not LLM context). Primary cold trail is wiki_produce toolResult.details.
   */
  sessionManager?: ProduceProgressSessionManager;
  /** Synthetic root unitId when aggregating multi-unit tree. Default "root". */
  rootUnitId?: string;
  /** Synthetic root role. Default "root". */
  rootRole?: ProduceAgentRole;
  /** Synthetic root task label. */
  rootTask?: string;
  /**
   * Min ms between running-status custom entry writes (mid-run cold load).
   * Settle/fail always write. Default 2000.
   */
  customEntryThrottleMs?: number;
};

export type ProduceProgressBridge = {
  /** Feed host-local ProduceProgress (from attachProgress / produce sink). */
  onProgress: (p: ProduceProgress) => void;
  /** Nested root tree (synthetic root + children). */
  getDetails: () => ProduceToolDetails;
  /** Last flat details for a unitId. */
  getUnitDetails: (unitId: string) => ProduceToolDetails | undefined;
};

type StoredUnit = {
  details: ProduceToolDetails;
  parentId?: string;
};

/**
 * Map a single ProduceProgress snapshot → ProduceToolDetails (no children).
 */
export function progressToDetails(p: ProduceProgress): ProduceToolDetails {
  const details: ProduceToolDetails = {
    role: p.role,
    status: p.status,
  };
  if (p.unitId !== undefined) details.unitId = p.unitId;
  if (p.task !== undefined) details.task = p.task;
  if (p.parentId !== undefined) details.parentId = p.parentId;
  if (p.tools !== undefined) details.tools = p.tools;
  if (p.message !== undefined) details.message = p.message;
  if (p.summary !== undefined) details.summary = p.summary;
  if (p.receiptPath !== undefined) details.receiptPath = p.receiptPath;
  if (p.error !== undefined) details.error = p.error;
  return details;
}

/**
 * Aggregate flat unit map into a nested tree under a synthetic root.
 * Units whose parentId is missing, equals rootUnitId, or is not in the map
 * become direct children of the root.
 */
export function aggregateProduceDetails(
  units: ReadonlyMap<string, StoredUnit>,
  opts?: {
    rootUnitId?: string;
    rootRole?: ProduceAgentRole;
    rootTask?: string;
  },
): ProduceToolDetails {
  const rootUnitId = opts?.rootUnitId ?? "root";
  const rootRole = opts?.rootRole ?? "root";
  const rootTask = opts?.rootTask;

  const byId = new Map<string, ProduceToolDetails>();
  for (const [id, stored] of units) {
    // Nested form drops parentId (tree edges via children).
    const { parentId: _parentId, ...rest } = stored.details;
    byId.set(id, { ...rest, unitId: rest.unitId ?? id });
  }

  const childIds = new Set<string>();
  const childrenOf = new Map<string, string[]>();

  for (const [id, stored] of units) {
    const parent = stored.parentId;
    if (parent && parent !== rootUnitId && byId.has(parent) && parent !== id) {
      const list = childrenOf.get(parent) ?? [];
      list.push(id);
      childrenOf.set(parent, list);
      childIds.add(id);
    }
  }

  const attachChildren = (id: string, node: ProduceToolDetails): ProduceToolDetails => {
    const kids = childrenOf.get(id);
    if (!kids || kids.length === 0) return node;
    return {
      ...node,
      children: kids.map((cid) => {
        const child = byId.get(cid)!;
        return attachChildren(cid, child);
      }),
    };
  };

  // Prefer an explicit stored root unit when present.
  const storedRoot = units.get(rootUnitId);
  if (storedRoot) {
    const rootNode = attachChildren(rootUnitId, {
      ...(() => {
        const { parentId: _p, ...rest } = storedRoot.details;
        return rest;
      })(),
      unitId: storedRoot.details.unitId ?? rootUnitId,
    });
    // Orphans (not under root) still surface as siblings under root.children.
    const orphans: ProduceToolDetails[] = [];
    for (const [id] of units) {
      if (id === rootUnitId) continue;
      if (childIds.has(id)) continue;
      // Direct child of synthetic root (parentId root / missing / unknown).
      const parent = units.get(id)?.parentId;
      if (parent === rootUnitId || parent === undefined || !byId.has(parent)) {
        orphans.push(attachChildren(id, byId.get(id)!));
      }
    }
    if (orphans.length > 0) {
      return {
        ...rootNode,
        children: [...(rootNode.children ?? []), ...orphans],
      };
    }
    return rootNode;
  }

  const topLevel: ProduceToolDetails[] = [];
  for (const [id] of units) {
    if (childIds.has(id)) continue;
    topLevel.push(attachChildren(id, byId.get(id)!));
  }

  const status = deriveRootStatus(topLevel);
  return {
    role: rootRole,
    status,
    unitId: rootUnitId,
    ...(rootTask !== undefined ? { task: rootTask } : {}),
    ...(topLevel.length > 0 ? { children: topLevel } : {}),
  };
}

function deriveRootStatus(children: ProduceToolDetails[]): ProduceProgressStatus {
  if (children.length === 0) return "pending";
  if (children.some((c) => c.status === "running" || c.status === "pending")) {
    // Any in-flight or not-yet-started sibling keeps root open.
    if (children.some((c) => c.status === "running")) return "running";
    if (children.every((c) => c.status === "pending")) return "pending";
    return "running";
  }
  if (children.some((c) => c.status === "failed")) return "failed";
  if (children.every((c) => c.status === "settled")) return "settled";
  return "running";
}

/**
 * Host API: fold ProduceProgress into parent-visible ProduceToolDetails.
 *
 * - onProgress: reduce unit map, fire onDetails / onTree, durable custom entries
 * - getDetails: nested root tree for wiki_produce tool partials / cold projection
 */
export function createProduceProgressBridge(
  opts: CreateProduceProgressBridgeOpts = {},
): ProduceProgressBridge {
  const units = new Map<string, StoredUnit>();
  const rootUnitId = opts.rootUnitId ?? "root";
  const rootRole = opts.rootRole ?? "root";
  const rootTask = opts.rootTask;
  const throttleMs = opts.customEntryThrottleMs ?? 2000;
  let lastCustomWriteAt = 0;

  const getDetails = (): ProduceToolDetails =>
    aggregateProduceDetails(units, { rootUnitId, rootRole, rootTask });

  const writeCustom = (details: ProduceToolDetails, force: boolean): void => {
    if (!opts.sessionManager) return;
    const now = Date.now();
    const terminal = details.status === "settled" || details.status === "failed";
    if (!force && !terminal && now - lastCustomWriteAt < throttleMs) return;
    lastCustomWriteAt = now;
    try {
      opts.sessionManager.appendCustomEntry(OKF_PRODUCE_PROGRESS_CUSTOM_TYPE, details);
    } catch {
      // best-effort
    }
  };

  const onProgress = (p: ProduceProgress): void => {
    const unitId = (p.unitId?.trim() || "unit").slice(0, 120);
    const details = progressToDetails({ ...p, unitId });
    units.set(unitId, {
      details,
      parentId: p.parentId,
    });

    const tree = getDetails();

    try {
      opts.onDetails?.(details);
    } catch {
      // Never let a bad subscriber break produce.
    }
    try {
      opts.onTree?.(tree);
    } catch {
      // Never let a bad subscriber break produce.
    }

    // Unit-level custom entry on settle/fail; tree snapshot throttled for mid-run.
    const terminal = details.status === "settled" || details.status === "failed";
    if (terminal) writeCustom(details, true);
    writeCustom(tree, terminal);
  };

  return {
    onProgress,
    getDetails,
    getUnitDetails: (unitId) => units.get(unitId)?.details,
  };
}
