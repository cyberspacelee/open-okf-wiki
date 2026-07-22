/**
 * Supervisor delegation hooks: Host-enforced depth, fan-out, message filter.
 * Emits data-agent-span for Session multi-agent timeline (ADR 0028 UI).
 */

import type { WorkspaceOrchestration } from "@okf-wiki/contract";
import { DEFAULT_ORCHESTRATION } from "./limits.js";
import {
  emitAgentSpan,
  roleFromAgentId,
  summarizePrompt,
  type WikiRunStreamWriterLike,
} from "./run-timeline.js";

export type DelegationCounters = {
  domainStarts: number;
  leafStarts: number;
  maxObservedDepth: number;
  spanSeq: number;
};

export function createDelegationCounters(): DelegationCounters {
  return { domainStarts: 0, leafStarts: 0, maxObservedDepth: 0, spanSeq: 0 };
}

/**
 * Build Mastra stream `delegation` option for Root supervisor.
 * Caps Domain/Leaf fan-out and injects scope-only prompts.
 */
export function buildRootDelegationOptions(input: {
  orchestration?: WorkspaceOrchestration;
  counters?: DelegationCounters;
  runId?: string;
  writer?: WikiRunStreamWriterLike;
}) {
  const orch = input.orchestration ?? DEFAULT_ORCHESTRATION;
  const counters = input.counters ?? createDelegationCounters();
  const runId = input.runId ?? "run";
  const writer = input.writer;

  return {
    onDelegationStart: async (context: {
      primitiveId: string;
      prompt: string;
      iteration: number;
    }) => {
      const id = context.primitiveId ?? "";
      const isDomain = /domain/i.test(id);
      const isLeaf = /leaf/i.test(id);

      if (isDomain) {
        if (counters.domainStarts >= orch.maxDomainFanOut) {
          return {
            proceed: false,
            rejectionReason: `Host maxDomainFanOut=${orch.maxDomainFanOut} reached. Synthesize existing domain receipts instead of opening more domains.`,
          };
        }
        counters.domainStarts += 1;
        counters.maxObservedDepth = Math.max(counters.maxObservedDepth, 1);
        counters.spanSeq += 1;
        const spanId = `${runId}-domain-${counters.spanSeq}`;
        await emitAgentSpan(writer, {
          spanId,
          agentId: id || "domainResearcher",
          role: roleFromAgentId(id || "domain"),
          status: "running",
          promptSummary: summarizePrompt(context.prompt),
          parentId: "root",
          runId,
        });
        return {
          proceed: true,
          modifiedPrompt: [
            context.prompt,
            "",
            "Host constraints: research only; do not write wiki pages; cite tool-derived line numbers only.",
            `Tool step budget: ${orch.domainMaxSteps}.`,
            `Host spanId: ${spanId}`,
          ].join("\n"),
          modifiedMaxSteps: orch.domainMaxSteps,
        };
      }

      if (isLeaf) {
        if (orch.maxDepth < 2) {
          return {
            proceed: false,
            rejectionReason: `Host maxDepth=${orch.maxDepth} forbids Leaf researchers.`,
          };
        }
        if (
          counters.leafStarts >=
          orch.maxLeafFanOut * Math.max(1, orch.maxDomainFanOut)
        ) {
          return {
            proceed: false,
            rejectionReason:
              "Host leaf fan-out budget exhausted. Reduce existing evidence.",
          };
        }
        counters.leafStarts += 1;
        counters.maxObservedDepth = Math.max(counters.maxObservedDepth, 2);
        counters.spanSeq += 1;
        const spanId = `${runId}-leaf-${counters.spanSeq}`;
        await emitAgentSpan(writer, {
          spanId,
          agentId: id || "leafResearcher",
          role: roleFromAgentId(id || "leaf"),
          status: "running",
          promptSummary: summarizePrompt(context.prompt),
          parentId: "root",
          runId,
        });
        return {
          proceed: true,
          modifiedPrompt: [
            context.prompt,
            "",
            "Host constraints: narrow path only; short evidence bullets with paths and line numbers; no wiki writes.",
            `Tool step budget: ${orch.leafMaxSteps}.`,
            `Host spanId: ${spanId}`,
          ].join("\n"),
          modifiedMaxSteps: orch.leafMaxSteps,
        };
      }

      counters.spanSeq += 1;
      const spanId = `${runId}-agent-${counters.spanSeq}`;
      await emitAgentSpan(writer, {
        spanId,
        agentId: id || "agent",
        role: roleFromAgentId(id || "agent"),
        status: "running",
        promptSummary: summarizePrompt(context.prompt),
        parentId: "root",
        runId,
      });
      return {
        proceed: true,
        modifiedMaxSteps: Math.min(orch.domainMaxSteps, 12),
      };
    },

    onDelegationComplete: async (context: {
      primitiveId: string;
      error?: unknown;
      bail: () => void;
    }) => {
      const id = context.primitiveId ?? "agent";
      const spanId = `${runId}-complete-${id}-${counters.spanSeq}`;
      await emitAgentSpan(writer, {
        spanId,
        agentId: id,
        role: roleFromAgentId(id),
        status: context.error ? "failed" : "complete",
        parentId: "root",
        runId,
        error: context.error
          ? String(
              context.error instanceof Error
                ? context.error.message
                : context.error,
            ).slice(0, 400)
          : undefined,
      });
      if (context.error) {
        return {
          feedback: `Delegation to ${context.primitiveId} failed: ${String(context.error)}. Prefer a narrower scope or direct read_source fallback.`,
        };
      }
      return {
        feedback: `Delegation to ${context.primitiveId} finished. Reduce into Spec/receipts; do not re-open the same empty scope.`,
      };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageFilter: ({
      messages,
    }: {
      messages: any[];
      primitiveId: string;
      prompt: string;
    }) => {
      if (!Array.isArray(messages)) {
        return [] as any[];
      }
      return messages.slice(-6);
    },
  };
}
