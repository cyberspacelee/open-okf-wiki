import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { claimText } from "./files.js";
import { markdownOutsideCodeFences, markdownStructure, sectionHasContent } from "./markdown-structure.js";
import type { WikiWriteMode } from "./write-target.js";

const BODY_MARKER = "<!-- wiki-handoff-body -->";

export interface HandoffEnvelope {
  executionId: string;
  boardTaskId: string;
  partition: string;
  writeMode?: WikiWriteMode;
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

export function parseWriteStatus(text: string): "complete" | "blocked" | undefined {
  const status = sectionText(markdownStructure(text).sections, "Status").toLowerCase();
  return status === "complete" || status === "blocked" ? status : undefined;
}

const REQUIRED_OUTPUT_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  survey: ["Source", "Domains", "Concepts", "Cross-Source leads", "Contract hints", "Tables", "Survey gaps"],
  synthesize: ["Workspace", "Relationships", "End-to-end flows", "Shared contracts", "Gaps"],
  write: ["Status", "Written", "Rejected hints", "Evidence gaps"],
};

export function workerOutputSkeleton(agent: string): string {
  if (agent === "review") return "verdict: pending\n\n## Coverage\n\npending\n\n## Repairs\n\npending\n";
  const sections = REQUIRED_OUTPUT_SECTIONS[agent];
  if (!sections) throw new Error(`Unsupported Wiki agent output contract: ${agent}`);
  return `${sections.map((title) => `## ${title}\n\npending`).join("\n\n")}\n`;
}

export function reviewCandidatePages(files: readonly string[]): string[] {
  return files
    .filter((file) => file.endsWith(".md"))
    .map((file) => `wiki/${file}`)
    .sort();
}

export function workerOutputIssues(agent: string, text: string, candidatePages: readonly string[] = []): string[] {
  if (agent === "review") return reviewOutputIssues(text, candidatePages);
  const required = REQUIRED_OUTPUT_SECTIONS[agent];
  if (!required) return [`Unsupported Wiki agent output contract: ${agent}`];
  const sections = markdownStructure(text).sections;
  const issues: string[] = [];
  const visible = markdownOutsideCodeFences(text);
  const firstH2 = visible.search(/^ {0,3}##[ \t]+/m);
  if (firstH2 > 0 && visible.slice(0, firstH2).trim()) {
    issues.push("Receipt must start with its first required H2; preamble text is not allowed");
  }
  const actual = sections.map((section) => section.title);
  if (actual.length !== required.length || actual.some((title, index) => title !== required[index])) {
    issues.push(`H2 sections must be exactly: ${required.join(" | ")}`);
  }
  for (const title of required) {
    const matches = sections.filter((section) => section.title === title);
    if (matches.length !== 1) issues.push(`Expected exactly one \`## ${title}\` section`);
    else if (!sectionHasContent(matches[0]!)) issues.push(`\`## ${title}\` must contain a result`);
  }
  if (agent === "write") {
    const status = parseWriteStatus(text);
    if (!status) issues.push("`## Status` must be exactly `complete` or `blocked`");
    const gaps = sectionText(sections, "Evidence gaps").toLowerCase().replace(/[.]+$/, "");
    if (status === "complete" && gaps !== "none") {
      issues.push("`## Evidence gaps` must be exactly `none` before completion");
    }
    if (status === "blocked" && gaps === "none") {
      issues.push("`blocked` requires a concrete `## Evidence gaps` result");
    }
  }
  return issues;
}

function reviewOutputIssues(text: string, candidatePages: readonly string[]): string[] {
  const verdict = parseReviewVerdict(text);
  const issues: string[] = [];
  if (!verdict) issues.push("The first nonblank line must be exactly `verdict: pass` or `verdict: changes_requested`");
  if (!candidatePages.length) issues.push("Review requires a non-empty frozen Candidate page manifest");
  const sections = markdownStructure(text).sections;
  const required = ["Coverage", "Repairs"];
  const actual = sections.map((section) => section.title);
  if (actual.length !== required.length || actual.some((title, index) => title !== required[index])) {
    issues.push(`H2 sections must be exactly: ${required.join(" | ")}`);
  }
  for (const title of required) {
    const matches = sections.filter((section) => section.title === title);
    if (matches.length !== 1) issues.push(`Expected exactly one \`## ${title}\` section`);
    else if (!sectionHasContent(matches[0]!)) issues.push(`\`## ${title}\` must contain a result`);
  }
  const expected = new Set(candidatePages);
  const seen = new Map<string, "pass" | "changes_requested">();
  const coveragePattern = /^- page: (wiki\/[A-Za-z0-9._/-]+\.md) \| result: (pass|changes_requested) \| evidence: (.+)$/;
  for (const line of sectionText(sections, "Coverage").split(/\r?\n/).filter((entry) => entry.trim())) {
    const match = coveragePattern.exec(line);
    if (!match) {
      issues.push(`Invalid review coverage row: ${line}`);
      continue;
    }
    const page = match[1]!;
    const result = match[2]! as "pass" | "changes_requested";
    const evidence = match[3]!.trim();
    if (seen.has(page)) issues.push(`Duplicate review coverage for ${page}`);
    else seen.set(page, result);
    if (!evidence || /^none\.?$/i.test(evidence)) issues.push(`Review coverage for ${page} requires reopened evidence or a concrete gap`);
  }
  for (const page of candidatePages) if (!seen.has(page)) issues.push(`Missing review coverage for ${page}`);
  for (const page of seen.keys()) if (!expected.has(page)) issues.push(`Review coverage names unknown Candidate page ${page}`);
  const failed = [...seen].filter(([, result]) => result === "changes_requested").map(([page]) => page);
  if (verdict === "pass") {
    if (failed.length) issues.push("A pass verdict cannot contain changes_requested page results");
    if (sectionText(sections, "Repairs").toLowerCase().replace(/[.]+$/, "") !== "none") {
      issues.push("A pass verdict requires `## Repairs` to be exactly `none`");
    }
  }
  if (verdict === "changes_requested") {
    if (!failed.length) issues.push("A changes_requested verdict requires at least one changes_requested page result");
    const repaired = repairRecordPages(sectionText(sections, "Repairs"), issues);
    for (const page of failed) if (!repaired.has(page)) issues.push(`Missing repair record for ${page}`);
    for (const page of repaired) if (!failed.includes(page)) issues.push(`Repair record names a page that did not fail coverage: ${page}`);
  }
  return issues;
}

function repairRecordPages(text: string, issues: string[]): Set<string> {
  const pages = new Set<string>();
  const fields = ["partition", "page", "obligation", "defect", "evidence", "acceptance"];
  for (const block of text.trim().split(/\r?\n\s*\r?\n/).filter(Boolean)) {
    const lines = block.split(/\r?\n/);
    const values = new Map<string, string>();
    for (const line of lines) {
      const match = /^([a-z]+):\s*(\S.*)$/.exec(line);
      if (!match || !fields.includes(match[1]!)) {
        issues.push(`Invalid review repair field: ${line}`);
        continue;
      }
      if (values.has(match[1]!)) issues.push(`Duplicate \`${match[1]}:\` field in one repair record`);
      values.set(match[1]!, match[2]!);
    }
    for (const field of fields) if (!values.has(field)) issues.push(`Review repair record requires a \`${field}:\` field`);
    const page = values.get("page");
    if (page) {
      if (pages.has(page)) issues.push(`Duplicate repair record for ${page}`);
      pages.add(page);
    }
  }
  return pages;
}

function sectionText(sections: ReturnType<typeof markdownStructure>["sections"], title: string): string {
  return sections.find((section) => section.title === title)?.lines.join("\n").trim() ?? "";
}

export async function sealHandoff(input: {
  workspaceRoot: string;
  handoffsRoot: string;
  task: { id: string; boardTaskId: string; partition: string; writeMode?: WikiWriteMode; agent: string; task: string };
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
    ...(input.task.writeMode ? { writeMode: input.task.writeMode } : {}),
    agent: input.task.agent,
    taskDigest: taskDigest(input.task.task),
    baseCandidateRevision: input.baseCandidateRevision,
    ...(input.completedCandidateRevision ? { completedCandidateRevision: input.completedCandidateRevision } : {}),
  };
  await claimText(
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
    writeMode?: WikiWriteMode;
    agent: string;
    taskDigest: string;
    candidateRevision?: string;
    candidatePages?: readonly string[];
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
    || envelope.writeMode !== expected.writeMode
    || envelope.agent !== expected.agent
    || envelope.taskDigest !== expected.taskDigest
  ) return undefined;
  if (expected.agent === "write" || expected.agent === "review") {
    if (!expected.candidateRevision || envelope.completedCandidateRevision !== expected.candidateRevision) {
      return undefined;
    }
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (workerOutputIssues(expected.agent, body, expected.candidatePages).length) return undefined;
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
    && (raw.writeMode === undefined || raw.writeMode === "subtree" || raw.writeMode === "directory")
    && typeof raw.agent === "string"
    && typeof raw.taskDigest === "string"
    && typeof raw.baseCandidateRevision === "string"
    && (raw.completedCandidateRevision === undefined || typeof raw.completedCandidateRevision === "string");
}
