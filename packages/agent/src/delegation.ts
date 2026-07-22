/**
 * Supervisor delegation hooks: Host-enforced depth, fan-out, message filter.
 * Aligns with Cursor planner/worker context isolation.
 */

import type { WorkspaceOrchestration } from "@okf-wiki/contract";
import { DEFAULT_ORCHESTRATION } from "./limits.js";

export type DelegationCounters = {
  domainStarts: number;
  leafStarts: number;
  /** Approximate nesting: increments on domain, leaf treated as depth 2. */
  maxObservedDepth: number;
};

export function createDelegationCounters(): DelegationCounters {
  return { domainStarts: 0, leafStarts: 0, maxObservedDepth: 0 };
}

/**
 * Build Mastra stream `delegation` option for Root supervisor.
 * Caps Domain/Leaf fan-out and injects scope-only prompts.
 */
export function buildRootDelegationOptions(input: {
  orchestration?: WorkspaceOrchestration;
  counters?: DelegationCounters;
}) {
  const orch = input.orchestration ?? DEFAULT_ORCHESTRATION;
  const counters = input.counters ?? createDelegationCounters();

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
        return {
          proceed: true,
          modifiedPrompt: [
            context.prompt,
            "",
            "Host constraints: research only; do not write wiki pages; cite tool-derived line numbers only.",
            `Tool step budget: ${orch.domainMaxSteps}.`,
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
        if (counters.leafStarts >= orch.maxLeafFanOut * Math.max(1, orch.maxDomainFanOut)) {
          return {
            proceed: false,
            rejectionReason: "Host leaf fan-out budget exhausted. Reduce existing evidence.",
          };
        }
        counters.leafStarts += 1;
        counters.maxObservedDepth = Math.max(counters.maxObservedDepth, 2);
        return {
          proceed: true,
          modifiedPrompt: [
            context.prompt,
            "",
            "Host constraints: narrow path only; short evidence bullets with paths and line numbers; no wiki writes.",
            `Tool step budget: ${orch.leafMaxSteps}.`,
          ].join("\n"),
          modifiedMaxSteps: orch.leafMaxSteps,
        };
      }

      // Unknown subagent: allow with conservative step cap.
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
      if (context.error) {
        return {
          feedback: `Delegation to ${context.primitiveId} failed: ${String(context.error)}. Prefer a narrower scope or direct read_source fallback.`,
        };
      }
      return {
        feedback: `Delegation to ${context.primitiveId} finished. Reduce into Spec/receipts; do not re-open the same empty scope.`,
      };
    },

    /**
     * Keep child context small: only the last few messages + system-ish content.
     * Cursor insight: workers should not inherit full planner history.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageFilter: ({ messages }: { messages: any[]; primitiveId: string; prompt: string }) => {
      if (!Array.isArray(messages)) {
        return [] as any[];
      }
      // Keep at most last 6 messages to avoid full Root trajectory.
      return messages.slice(-6);
    },
  };
}
