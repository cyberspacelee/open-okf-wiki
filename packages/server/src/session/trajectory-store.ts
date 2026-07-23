/**
 * Session-scoped product trajectory store (ADR 0031).
 *
 * Path: `.okf-wiki/pi-sessions/<sessionId>/operator-trajectory.jsonl`
 * Fold last-by-unitId for cold-load work_unit snapshots.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { piSessionPath } from "@okf-wiki/agent";
import {
  assertProductInject,
  OPERATOR_TRAJECTORY_FILE,
  type ProductSseEvent,
  ProductSseEventSchema,
  type ProductWorkUnitEvent,
} from "@okf-wiki/contract";

const MAX_MESSAGE_CHARS = 64_000;

/** Absolute path for operator-trajectory.jsonl under the session workdir. */
export function operatorTrajectoryPath(workspaceRoot: string, sessionId: string): string {
  return path.join(piSessionPath(workspaceRoot, sessionId), OPERATOR_TRAJECTORY_FILE);
}

function capMessageField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= MAX_MESSAGE_CHARS) return value;
  return value.slice(0, MAX_MESSAGE_CHARS);
}

/** Cap work_unit message thinking/text before durable write. */
export function capProductEventForTrajectory(event: ProductSseEvent): ProductSseEvent {
  if (event.kind !== "work_unit" || !event.message) return event;
  const thinking = capMessageField(event.message.thinking);
  const text = capMessageField(event.message.text);
  if (thinking === event.message.thinking && text === event.message.text) {
    return event;
  }
  return {
    ...event,
    message: {
      ...event.message,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(text !== undefined ? { text } : {}),
    },
  };
}

/**
 * Append one whitelist product event to the session trajectory.
 * Asserts inject kind; best-effort mkdir of the session dir.
 */
export async function appendTrajectory(
  workspaceRoot: string,
  sessionId: string,
  event: ProductSseEvent,
): Promise<void> {
  assertProductInject(event.kind);
  const capped = capProductEventForTrajectory(event);
  const filePath = operatorTrajectoryPath(workspaceRoot, sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(capped)}\n`, "utf8");
}

/**
 * Load all product trajectory rows (skip malformed / non-whitelist lines).
 * Missing file → empty array.
 */
export async function loadTrajectory(
  workspaceRoot: string,
  sessionId: string,
): Promise<ProductSseEvent[]> {
  const filePath = operatorTrajectoryPath(workspaceRoot, sessionId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    if (code === "ENOENT") return [];
    throw err;
  }

  const events: ProductSseEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const result = ProductSseEventSchema.safeParse(parsed);
      if (result.success) {
        events.push(result.data);
      }
    } catch {
      // skip bad line
    }
  }
  return events;
}

/**
 * Fold work_unit events to last snapshot per unitId (cold-load Work surface).
 */
export function foldWorkUnits(
  events: readonly ProductSseEvent[],
): Map<string, ProductWorkUnitEvent> {
  const map = new Map<string, ProductWorkUnitEvent>();
  for (const event of events) {
    if (event.kind !== "work_unit") continue;
    map.set(event.unitId, event);
  }
  return map;
}

/** Last run_phase from trajectory (cold-load phase strip). */
export function lastRunPhase(
  events: readonly ProductSseEvent[],
): Extract<ProductSseEvent, { kind: "run_phase" }>["phase"] | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === "run_phase") {
      return event.phase;
    }
  }
  return undefined;
}

/** Last linked Wiki Run id from run_link / work_unit / run_phase (cold-load). */
export function lastLinkedRunId(events: readonly ProductSseEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (
      (event.kind === "run_link" ||
        event.kind === "work_unit" ||
        event.kind === "run_phase" ||
        event.kind === "gate") &&
      typeof event.runId === "string" &&
      event.runId.trim()
    ) {
      return event.runId.trim();
    }
  }
  return undefined;
}

/**
 * Last Spec/plan snapshot from a gate inject (cold-load Plan panel).
 * Prefers plan-gate, then any gate that carried a plan.
 */
export function lastPlanFromTrajectory(
  events: readonly ProductSseEvent[],
): NonNullable<Extract<ProductSseEvent, { kind: "gate" }>["plan"]> | undefined {
  let anyPlan: NonNullable<Extract<ProductSseEvent, { kind: "gate" }>["plan"]> | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind !== "gate" || !event.plan) continue;
    if (event.gate === "plan") return event.plan;
    if (!anyPlan) anyPlan = event.plan;
  }
  return anyPlan;
}

/** Last gate inject (for pendingGate restore when shell is gone). */
export function lastGateFromTrajectory(
  events: readonly ProductSseEvent[],
): Extract<ProductSseEvent, { kind: "gate" }> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === "gate" && event.gate) return event;
  }
  return undefined;
}
