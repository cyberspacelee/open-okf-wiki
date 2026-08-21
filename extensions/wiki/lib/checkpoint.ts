import type { WikiBoard } from "./board.js";
import { formatBoard } from "./board.js";

const MAX_CHECKPOINT_TOKENS = 4_096;

export interface CheckpointExecution {
  id: string;
  boardTaskId: string;
  partition: string;
  agent: string;
  status: "running" | "complete" | "failed" | "interrupted";
  handoff?: { path: string; sha256: string };
  error?: string;
}

export interface CheckpointReview {
  verdict: "pass" | "changes_requested";
  candidateRevision: string;
  status: "current" | "stale";
  handoff: { path: string; sha256: string };
}

export interface LeadCheckpointInput {
  runId: string;
  focus?: string;
  board: WikiBoard;
  sourceFingerprint: string;
  templateFingerprint?: string;
  candidateRevision: string;
  pageCount: number;
  executions: readonly CheckpointExecution[];
  review?: CheckpointReview;
  check?: { candidateRevision: string; ok: boolean; issueCount: number; status: "current" | "stale" };
  repairAttempts?: number;
}

export function formatLeadCheckpoint(input: LeadCheckpointInput): string {
  const current = input.executions.filter((entry) => entry.status !== "complete");
  const completed = input.executions.filter((entry) => entry.status === "complete" && entry.handoff);
  const review = input.review
    ? `${input.review.verdict} (${input.review.status}); candidate ${short(input.review.candidateRevision)}; ${input.review.handoff.path}`
    : "missing";
  const check = input.check
    ? `${input.check.ok ? "pass" : `failed with ${input.check.issueCount} issues`} (${input.check.status}); candidate ${short(input.check.candidateRevision)}`
    : "not run";
  const mandatory = [
    "<wiki_checkpoint>",
    `Run: ${input.runId}`,
    ...(input.focus ? [`Focus: ${input.focus}`] : []),
    `Source fingerprint: ${short(input.sourceFingerprint)}`,
    `Template fingerprint: ${input.templateFingerprint ? short(input.templateFingerprint) : "unrecorded"}`,
    `Candidate: ${short(input.candidateRevision)}; ${input.pageCount} files`,
    `Deterministic check: ${check}`,
    `Review: ${review}`,
    `Repair attempts: ${input.repairAttempts ?? 0}/2${(input.repairAttempts ?? 0) >= 2 ? "; do not start another write repair; leave durable failure diagnostics" : ""}`,
    "",
    formatBoard(input.board),
    "",
    "Active, failed, or interrupted executions:",
    ...(current.length ? current.map(formatExecution) : ["- none"]),
  ];
  const suffix = [
    "Resume from these durable facts. Do not repeat completed partitions. Read referenced handoffs only when needed.",
    "</wiki_checkpoint>",
  ];
  if (estimateTokens([...mandatory, ...suffix].join("\n")) > MAX_CHECKPOINT_TOKENS) {
    throw new Error("context_checkpoint_too_large: mandatory Run state exceeds 4096 estimated tokens");
  }
  const lines = mandatory.slice();
  if (completed.length) lines.push("", "Completed artifacts:");
  let included = 0;
  for (const entry of completed.slice().reverse()) {
    const next = `- ${entry.boardTaskId}/${entry.partition}: ${entry.handoff!.path} (${short(entry.handoff!.sha256)})`;
    if (estimateTokens([...lines, next, ...suffix].join("\n")) > MAX_CHECKPOINT_TOKENS) break;
    lines.push(next);
    included += 1;
  }
  if (included < completed.length) {
    const omitted = `- ${completed.length - included} older completed artifact references omitted from this bounded frame.`;
    if (estimateTokens([...lines, omitted, ...suffix].join("\n")) <= MAX_CHECKPOINT_TOKENS) lines.push(omitted);
  }
  lines.push(...suffix);
  return lines.join("\n");
}

function formatExecution(entry: CheckpointExecution): string {
  const artifact = entry.handoff ? `; ${entry.handoff.path}` : "";
  const error = entry.error ? `; ${truncate(entry.error, 240)}` : "";
  return `- ${entry.id}: ${entry.agent} ${entry.boardTaskId}/${entry.partition} ${entry.status}${artifact}${error}`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function short(value: string): string {
  return value.slice(0, 12);
}
