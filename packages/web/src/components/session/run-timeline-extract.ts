/**
 * Extract Host timeline data from UIMessage parts for Run chrome.
 */

import type { UIMessage } from "ai";
import type { PhaseStep } from "./RunPhaseStrip";
import type { PlanProgressPage } from "./RunPagesQueue";
import type { SourceIndexEntry } from "./RunSourcesPanel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type AgentSpanView = {
  spanId: string;
  agentId: string;
  role: string;
  status: string;
  promptSummary?: string;
  error?: string;
};

export type RunTimelineChrome = {
  /** Latest phase strip steps (prefer last data-progress with steps). */
  phaseSteps: PhaseStep[];
  phaseLabel?: string;
  pages: PlanProgressPage[];
  sources: SourceIndexEntry[];
  agentSpans: AgentSpanView[];
  /** Show checkpoint after plan part present. */
  hasPlan: boolean;
  /** Show ready checkpoint when phase done. */
  produceDone: boolean;
};

export function extractRunTimelineChrome(
  parts: UIMessage["parts"],
): RunTimelineChrome {
  let phaseSteps: PhaseStep[] = [];
  let phaseLabel: string | undefined;
  let pages: PlanProgressPage[] = [];
  let sources: SourceIndexEntry[] = [];
  const agentSpans: AgentSpanView[] = [];
  let hasPlan = false;
  let produceDone = false;

  for (const part of parts) {
    if (part.type === "data-plan") {
      hasPlan = true;
    }
    if (typeof part.type !== "string" || !part.type.startsWith("data-")) {
      continue;
    }
    const data = "data" in part ? part.data : undefined;
    if (!isRecord(data)) {
      continue;
    }

    if (part.type === "data-progress") {
      if (typeof data.label === "string") {
        phaseLabel = data.label;
      }
      if (data.phase === "done") {
        produceDone = true;
      }
      if (Array.isArray(data.steps)) {
        phaseSteps = data.steps
          .filter((s): s is Record<string, unknown> => isRecord(s))
          .map((s) => ({
            id: String(s.id ?? ""),
            label: String(s.label ?? s.id ?? ""),
            status: (["pending", "active", "complete", "failed"].includes(
              String(s.status),
            )
              ? String(s.status)
              : "pending") as PhaseStep["status"],
            description:
              typeof s.description === "string" ? s.description : undefined,
          }))
          .filter((s) => s.id);
      }
    }

    if (part.type === "data-plan-progress" && Array.isArray(data.pages)) {
      pages = data.pages
        .filter((p): p is Record<string, unknown> => isRecord(p))
        .map((p) => ({
          path: String(p.path ?? ""),
          purpose: typeof p.purpose === "string" ? p.purpose : undefined,
          status: typeof p.status === "string" ? p.status : undefined,
        }))
        .filter((p) => p.path);
    }

    if (part.type === "data-sources-index" && Array.isArray(data.sources)) {
      sources = data.sources
        .filter((s): s is Record<string, unknown> => isRecord(s))
        .map((s) => ({
          path: String(s.path ?? ""),
          sourceId: typeof s.sourceId === "string" ? s.sourceId : undefined,
          lines: typeof s.lines === "string" ? s.lines : undefined,
          agentId: typeof s.agentId === "string" ? s.agentId : undefined,
        }))
        .filter((s) => s.path);
    }

    if (part.type === "data-agent-span") {
      agentSpans.push({
        spanId: String(data.spanId ?? data.agentId ?? ""),
        agentId: String(data.agentId ?? ""),
        role: String(data.role ?? "agent"),
        status: String(data.status ?? "running"),
        promptSummary:
          typeof data.promptSummary === "string"
            ? data.promptSummary
            : undefined,
        error: typeof data.error === "string" ? data.error : undefined,
      });
    }
  }

  // Collapse agent spans to latest status per agentId
  const byAgent = new Map<string, AgentSpanView>();
  for (const s of agentSpans) {
    byAgent.set(s.agentId || s.spanId, s);
  }

  return {
    phaseSteps,
    phaseLabel,
    pages,
    sources,
    agentSpans: [...byAgent.values()],
    hasPlan,
    produceDone,
  };
}
