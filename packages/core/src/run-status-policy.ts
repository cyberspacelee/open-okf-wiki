/**
 * Pure Wiki Run status transition rules (Run Boundary).
 * No I/O — used by run-store and agent finalize paths.
 */

import type { WikiRunRecordStatus } from "@okf-wiki/contract";

/** Outcomes that late product cancel must not overwrite. */
export function isDurableRunStatus(status: string | undefined | null): boolean {
  return status === "published" || status === "publication_declined";
}

/** Statuses from which operator cancel is allowed (or already cancelled). */
export function isCancellableRunStatus(status: WikiRunRecordStatus | string): boolean {
  return (
    status === "running" ||
    status === "awaiting_plan" ||
    status === "awaiting_publication" ||
    status === "cancelled"
  );
}

/**
 * Whether a non-cancel patch should be ignored because cancel already won.
 * (existing cancelled + patch is not cancelled → keep existing)
 */
export function cancelWinsOverPatch(
  existingStatus: WikiRunRecordStatus | string,
  patchStatus: WikiRunRecordStatus | string | undefined,
): boolean {
  return existingStatus === "cancelled" && patchStatus !== undefined && patchStatus !== "cancelled";
}

/**
 * Whether applying `cancelled` to `existingStatus` is allowed.
 * Idempotent when already cancelled.
 */
export function canTransitionToCancelled(existingStatus: WikiRunRecordStatus | string): boolean {
  return isCancellableRunStatus(existingStatus);
}

/**
 * Apply late product abort to a mapped terminal status.
 * Durable publish outcomes are preserved.
 */
export function applyLateAbortStatus<T extends { status: string; pages?: unknown; plan?: unknown }>(
  mapped: T,
  aborted: boolean,
): T | { status: "cancelled"; error: string; summary: string; pages: T["pages"]; plan: T["plan"] } {
  if (!aborted || isDurableRunStatus(mapped.status)) {
    return mapped;
  }
  return {
    status: "cancelled",
    error: "cancelled",
    summary: "Wiki Run cancelled",
    pages: mapped.pages,
    plan: mapped.plan,
  };
}
