import type { WikiRunRecordStatus } from "../api";

export type RunStatusTone = "default" | "running" | "success" | "warning" | "danger" | "muted";

const LABELS: Record<WikiRunRecordStatus, string> = {
  running: "Running",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
  awaiting_plan: "Awaiting plan",
  awaiting_publication: "Awaiting publication",
  publication_declined: "Publication declined",
};

const TONES: Record<WikiRunRecordStatus, RunStatusTone> = {
  running: "running",
  published: "success",
  failed: "danger",
  cancelled: "muted",
  awaiting_plan: "warning",
  awaiting_publication: "warning",
  publication_declined: "muted",
};

export function runStatusLabel(status: WikiRunRecordStatus | string): string {
  if (status in LABELS) {
    return LABELS[status as WikiRunRecordStatus];
  }
  return status;
}

export function runStatusTone(status: WikiRunRecordStatus | string): RunStatusTone {
  if (status in TONES) {
    return TONES[status as WikiRunRecordStatus];
  }
  return "default";
}
