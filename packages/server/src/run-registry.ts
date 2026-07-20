/**
 * Re-export Wiki Run records from Run Boundary (@okf-wiki/core).
 * Prefer importing from @okf-wiki/core in new code.
 */
export {
  createRun,
  registerRunRecord,
  updateRunRecord,
  loadRun,
  listRuns,
  RunStatusConflictError,
  type CreateRunOptions,
  type RegisterRunOptions,
  type RunRecordPatch,
} from "@okf-wiki/core";
