import {
  parseWikiArtifactRef,
  parseWikiDelegateContract,
  parseWikiDelegateError,
  parseWikiDelegateGap,
  parseWikiDelegateReceipt,
} from "../delegate-contracts.js";
import type { WikiTaskRuntimePartial, WikiTaskRuntimeState } from "../runtime-types.js";

/** Strict parser for durable delegate state. Used by run.json and WikiLeadRun. */
export function parseDelegateState(value: unknown): WikiTaskRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { batches?: unknown }).batches)) {
    throw new Error("Invalid Wiki delegate runtime state");
  }
  if (Object.keys(value).some((key) => key !== "batches")) throw new Error("Invalid Wiki delegate runtime state");
  const raw = value as { batches: unknown[] };
  const batchIds = new Set<number>();
  const batches = raw.batches.map((entry, batchIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Wiki delegate batch state");
    const batch = entry as { batchId?: unknown; tasks?: unknown };
    if (Object.keys(batch).some((key) => key !== "batchId" && key !== "tasks")) throw new Error("Invalid Wiki delegate batch state");
    if (!Number.isSafeInteger(batch.batchId) || batch.batchId !== batchIndex + 1 || batchIds.has(batch.batchId as number)
      || !Array.isArray(batch.tasks) || batch.tasks.length === 0) {
      throw new Error("Invalid Wiki delegate batch state");
    }
    batchIds.add(batch.batchId as number);
    const taskIds = new Set<string>();
    return {
      batchId: batch.batchId as number,
      tasks: batch.tasks.map((taskValue) => {
        if (!taskValue || typeof taskValue !== "object" || Array.isArray(taskValue)) throw new Error("Invalid Wiki delegate task state");
        const task = taskValue as Record<string, unknown>;
        if (Object.keys(task).some((key) => !["task", "phase", "attempt", "collected", "pause", "partial", "sessionFile", "receipt"].includes(key))) {
          throw new Error("Invalid Wiki delegate task state");
        }
        const contract = parseWikiDelegateContract(task.task);
        if (taskIds.has(contract.id)) throw new Error("Duplicate Wiki delegate task state");
        taskIds.add(contract.id);
        if (contract.batchId !== batch.batchId || !["queued", "running", "paused", "terminal"].includes(String(task.phase))
          || !Number.isSafeInteger(task.attempt) || (task.attempt as number) < 0 || typeof task.collected !== "boolean") {
          throw new Error("Invalid Wiki delegate task state");
        }
        const receipt = task.receipt === undefined ? undefined : parseWikiDelegateReceipt(task.receipt);
        const pause = task.pause === undefined ? undefined : parseWikiDelegateError(task.pause);
        const partial = task.partial === undefined ? undefined : parseTaskPartial(task.partial);
        if ((task.phase === "queued" && task.attempt !== 0) || (task.phase !== "queued" && (task.attempt as number) < 1)
          || (task.phase === "terminal") !== Boolean(receipt) || task.phase !== "paused" && pause || task.phase !== "terminal" && task.collected
          || partial && task.phase !== "running" && task.phase !== "paused"
          || pause && pause.code !== "quota" && pause.code !== "usage_limit"
          || task.sessionFile !== undefined && (typeof task.sessionFile !== "string" || !task.sessionFile)
          || receipt && (receipt.id !== contract.id || receipt.role !== contract.role || receipt.attempts !== task.attempt
            || receipt.contractId !== contract.contractId || receipt.contractDigest !== contract.contractDigest)) {
          throw new Error("Invalid Wiki delegate task transition state");
        }
        return {
          task: contract,
          phase: task.phase as "queued" | "running" | "paused" | "terminal",
          attempt: task.attempt as number,
          collected: task.collected,
          ...(typeof task.sessionFile === "string" && task.sessionFile ? { sessionFile: task.sessionFile } : {}),
          ...(receipt ? { receipt } : {}),
          ...(pause ? { pause } : {}),
          ...(partial ? { partial } : {}),
        };
      }),
    };
  });
  return { batches };
}

function parseTaskPartial(value: unknown): WikiTaskRuntimePartial {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wiki delegate partial state");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["outputs", "coverage", "gaps"].includes(key)) || !Array.isArray(raw.outputs)
    || !Array.isArray(raw.coverage) || raw.coverage.some((item) => typeof item !== "string" || !item)
    || !Array.isArray(raw.gaps)) throw new Error("Invalid Wiki delegate partial state");
  return { outputs: raw.outputs.map(parseWikiArtifactRef), coverage: [...raw.coverage] as string[], gaps: raw.gaps.map(parseWikiDelegateGap) };
}
