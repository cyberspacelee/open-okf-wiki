/**
 * Product timeline data parts for Session (phase, agent spans, sources).
 * Emitted via writer.custom → toAISdkStream as UI data-* parts.
 */

import type { WikiRunPlan } from "@okf-wiki/contract";

export type WikiRunUiPhase =
  | "planning"
  | "researching"
  | "writing"
  | "reviewing"
  | "repairing"
  | "done"
  | "failed";

export type TimelineStepStatus = "pending" | "active" | "complete" | "failed";

export type TimelineStep = {
  id: string;
  label: string;
  status: TimelineStepStatus;
  description?: string;
};

export type AgentSpanRole = "domain" | "leaf" | "reviewer" | "agent" | "root";

export type AgentSpanPayload = {
  spanId: string;
  agentId: string;
  role: AgentSpanRole;
  status: "running" | "complete" | "failed";
  promptSummary?: string;
  parentId?: string;
  runId: string;
  error?: string;
};

export type SourceIndexEntry = {
  path: string;
  sourceId?: string;
  lines?: string;
  agentId?: string;
};

export type SourcesIndexPayload = {
  runId: string;
  sources: SourceIndexEntry[];
};

export type WikiRunStreamWriterLike = {
  write: (chunk: unknown) => Promise<void>;
  custom?: (chunk: {
    type: `data-${string}`;
    data: unknown;
    id?: string;
    transient?: boolean;
  }) => Promise<void>;
};

async function emitData(
  writer: WikiRunStreamWriterLike | undefined,
  type: `data-${string}`,
  data: unknown,
  id?: string,
): Promise<void> {
  if (!writer) {
    return;
  }
  const part = { type, data, ...(id ? { id } : {}) };
  if (typeof writer.custom === "function") {
    await writer.custom(part);
    return;
  }
  await writer.write(part);
}

export function roleFromAgentId(agentId: string): AgentSpanRole {
  const n = agentId.toLowerCase();
  if (/reviewer/.test(n)) {
    return "reviewer";
  }
  if (/leaf/.test(n)) {
    return "leaf";
  }
  if (/domain/.test(n)) {
    return "domain";
  }
  if (/root/.test(n)) {
    return "root";
  }
  return "agent";
}

export function buildPhaseSteps(
  phase: WikiRunUiPhase,
  extras?: { written?: number; total?: number; defectCount?: number },
): TimelineStep[] {
  const order: WikiRunUiPhase[] = [
    "planning",
    "researching",
    "writing",
    "reviewing",
    "repairing",
    "done",
  ];
  // Map failed onto active failed step
  const effective = phase === "failed" ? "reviewing" : phase;
  const idx = order.indexOf(effective);

  const writeLabel =
    extras?.total && extras.total > 0
      ? `Write pages (${extras.written ?? 0}/${extras.total})`
      : "Write pages";
  const reviewLabel =
    extras?.defectCount !== undefined && extras.defectCount > 0
      ? `Review (${extras.defectCount} defects)`
      : "Review";

  const defs: Array<{ id: string; label: string; phase: WikiRunUiPhase }> = [
    { id: "planning", label: "Plan Spec", phase: "planning" },
    { id: "researching", label: "Investigate sources", phase: "researching" },
    { id: "writing", label: writeLabel, phase: "writing" },
    { id: "reviewing", label: reviewLabel, phase: "reviewing" },
    { id: "done", label: "Ready to publish", phase: "done" },
  ];

  return defs.map((d) => {
    const di = order.indexOf(d.phase);
    let status: TimelineStepStatus = "pending";
    if (phase === "failed" && d.phase === "reviewing") {
      status = "failed";
    } else if (d.phase === "done" && phase === "done") {
      status = "complete";
    } else if (di < idx) {
      status = "complete";
    } else if (di === idx) {
      status = phase === "done" ? "complete" : "active";
    }
    // repairing maps onto reviewing active
    if (phase === "repairing" && d.phase === "reviewing") {
      status = "active";
    }
    return { id: d.id, label: d.label, status };
  });
}

export async function emitRunPhase(
  writer: WikiRunStreamWriterLike | undefined,
  input: {
    runId: string;
    phase: WikiRunUiPhase;
    label?: string;
    plan?: WikiRunPlan;
    writtenPaths?: Iterable<string>;
    defectCount?: number;
    failed?: boolean;
  },
): Promise<void> {
  const written = input.writtenPaths
    ? [...input.writtenPaths].length
    : undefined;
  const total = input.plan?.pages?.length;
  const steps = buildPhaseSteps(input.phase, {
    written,
    total,
    defectCount: input.defectCount,
  });
  const label =
    input.label ??
    ({
      planning: "Planning wiki Spec",
      researching: "Investigating sources",
      writing: "Writing wiki pages",
      reviewing: "Review council",
      repairing: "Repairing defects",
      done: "Produce complete",
      failed: "Produce failed",
    } as const)[input.phase];

  await emitData(
    writer,
    "data-progress",
    {
      phase: input.phase,
      label,
      runId: input.runId,
      failed: Boolean(input.failed ?? input.phase === "failed"),
      steps,
      written,
      total,
    },
    `progress-${input.runId}-${input.phase}`,
  );
}

export async function emitAgentSpan(
  writer: WikiRunStreamWriterLike | undefined,
  payload: AgentSpanPayload,
): Promise<void> {
  await emitData(
    writer,
    "data-agent-span",
    payload,
    `agent-span-${payload.spanId}-${payload.status}`,
  );
}

export async function emitSourcesIndex(
  writer: WikiRunStreamWriterLike | undefined,
  payload: SourcesIndexPayload,
): Promise<void> {
  if (!payload.sources.length) {
    return;
  }
  // Cap for UI
  const sources = payload.sources.slice(0, 40);
  await emitData(
    writer,
    "data-sources-index",
    { ...payload, sources },
    `sources-${payload.runId}`,
  );
}

/** Merge unique source paths into a mutable map. */
export function noteSourceHit(
  map: Map<string, SourceIndexEntry>,
  entry: SourceIndexEntry,
): void {
  const key = `${entry.sourceId ?? ""}:${entry.path}`;
  const prev = map.get(key);
  if (!prev) {
    map.set(key, entry);
    return;
  }
  if (entry.lines && !prev.lines) {
    map.set(key, { ...prev, lines: entry.lines });
  }
}

/** Best-effort extract path hits from tool result chunks. */
export function sourceHitsFromToolChunk(
  chunk: unknown,
  agentId?: string,
): SourceIndexEntry[] {
  if (!chunk || typeof chunk !== "object") {
    return [];
  }
  const c = chunk as {
    type?: string;
    payload?: {
      toolName?: string;
      name?: string;
      result?: unknown;
      args?: unknown;
    };
  };
  const type = c.type ?? "";
  if (!type.includes("tool") || type.includes("call")) {
    // only results
    if (!type.includes("result") && type !== "tool-result") {
      return [];
    }
  }
  const toolName = c.payload?.toolName ?? c.payload?.name ?? "";
  const result = c.payload?.result;
  const out: SourceIndexEntry[] = [];

  if (
    toolName === "read_source" ||
    toolName === "glob_source" ||
    toolName === "search_source" ||
    toolName === "list_source"
  ) {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      const sourceId =
        typeof r.sourceId === "string" ? r.sourceId : undefined;
      if (typeof r.path === "string" && r.path) {
        out.push({
          path: r.path,
          sourceId,
          agentId,
        });
      }
      if (Array.isArray(r.paths)) {
        for (const p of r.paths) {
          if (typeof p === "string") {
            out.push({ path: p, sourceId, agentId });
          }
        }
      }
      if (Array.isArray(r.matches)) {
        for (const m of r.matches) {
          if (m && typeof m === "object" && "path" in m) {
            const path = String((m as { path?: unknown }).path ?? "");
            const line = (m as { line?: unknown }).line;
            if (path) {
              out.push({
                path,
                sourceId,
                lines: typeof line === "number" ? `L${line}` : undefined,
                agentId,
              });
            }
          }
        }
      }
      if (Array.isArray(r.entries)) {
        // list_source: skip noise
      }
    }
  }
  return out;
}

export function summarizePrompt(prompt: string, max = 120): string {
  const t = prompt.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
