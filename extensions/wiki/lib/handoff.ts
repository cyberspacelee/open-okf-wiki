import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeText } from "./files.js";

const BODY_MARKER = "<!-- wiki-handoff-body -->";

export interface HandoffEnvelope {
  executionId: string;
  boardTaskId: string;
  partition: string;
  agent: string;
  taskDigest: string;
  baseCandidateRevision: string;
  completedCandidateRevision?: string;
}

interface ParsedHandoff {
  envelope: HandoffEnvelope;
  body: string;
}

export function taskDigest(task: string): string {
  return createHash("sha256").update(task).digest("hex");
}

export function parseHandoff(text: string): ParsedHandoff | undefined {
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0) return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text.slice(0, lineEnd));
  } catch {
    return undefined;
  }
  if (!isEnvelope(envelope)) return undefined;
  const marker = `${BODY_MARKER}\n`;
  const offset = text.indexOf(marker);
  if (offset < 0) return undefined;
  return { envelope, body: text.slice(offset + marker.length) };
}

export function parseReviewVerdict(text: string): "pass" | "changes_requested" | undefined {
  const first = text.trimStart().split(/\r?\n/, 1)[0]?.trim();
  const match = /^verdict:\s*(pass|changes_requested)$/.exec(first ?? "");
  return match ? match[1] as "pass" | "changes_requested" : undefined;
}

export async function writeHandoff(input: {
  workspaceRoot: string;
  handoffsRoot: string;
  task: { id: string; boardTaskId: string; partition: string; agent: string; task: string };
  text: string;
  baseCandidateRevision: string;
  completedCandidateRevision?: string;
}): Promise<string> {
  await mkdir(input.handoffsRoot, { recursive: true });
  const location = path.join(input.handoffsRoot, `${input.task.id}.md`);
  const envelope: HandoffEnvelope = {
    executionId: input.task.id,
    boardTaskId: input.task.boardTaskId,
    partition: input.task.partition,
    agent: input.task.agent,
    taskDigest: taskDigest(input.task.task),
    baseCandidateRevision: input.baseCandidateRevision,
    ...(input.completedCandidateRevision ? { completedCandidateRevision: input.completedCandidateRevision } : {}),
  };
  await writeText(
    location,
    `${JSON.stringify(envelope)}\n# ${input.task.agent} handoff\n\nTask: ${input.task.task}\n\n${BODY_MARKER}\n${input.text.trim()}\n`,
  );
  return path.relative(input.workspaceRoot, location).replaceAll("\\", "/");
}

export async function verifyHandoff(
  location: string,
  expected: {
    executionId: string;
    boardTaskId: string;
    partition: string;
    agent: string;
    taskDigest: string;
    candidateRevision?: string;
  },
): Promise<{ envelope: HandoffEnvelope; body: string; sha256: string; verdict?: "pass" | "changes_requested" } | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(location);
  } catch {
    return undefined;
  }
  const parsed = parseHandoff(bytes.toString("utf8"));
  if (!parsed) return undefined;
  const { envelope, body } = parsed;
  if (
    envelope.executionId !== expected.executionId
    || envelope.boardTaskId !== expected.boardTaskId
    || envelope.partition !== expected.partition
    || envelope.agent !== expected.agent
    || envelope.taskDigest !== expected.taskDigest
  ) return undefined;
  if (expected.agent === "write" || expected.agent === "review") {
    if (!expected.candidateRevision || envelope.completedCandidateRevision !== expected.candidateRevision) {
      return undefined;
    }
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected.agent === "review") {
    if (envelope.baseCandidateRevision !== expected.candidateRevision) return undefined;
    const verdict = parseReviewVerdict(body);
    if (!verdict) return undefined;
    return { envelope, body, sha256, verdict };
  }
  return { envelope, body, sha256 };
}

function isEnvelope(value: unknown): value is HandoffEnvelope {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.executionId === "string"
    && typeof raw.boardTaskId === "string"
    && typeof raw.partition === "string"
    && typeof raw.agent === "string"
    && typeof raw.taskDigest === "string"
    && typeof raw.baseCandidateRevision === "string"
    && (raw.completedCandidateRevision === undefined || typeof raw.completedCandidateRevision === "string");
}
