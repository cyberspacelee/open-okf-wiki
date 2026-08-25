import path from "node:path";
import { realpath } from "node:fs/promises";
import type { CitationSource } from "./citations.js";
import { sourceIsIgnored, type WikiPinnedSourcePlan } from "./inspect.js";
import { isImplicitPinPath, isSafeWikiPagePath, isWikiTaxonomySlug } from "./path.js";
import { writeTargetAllows, writeTargetsOverlap, type WikiWriteTarget } from "./write-target.js";

export interface WikiWriteGuard {
  workspaceRoot: string;
  candidateRoot: string;
  handoffsRoot: string;
  sources: Array<CitationSource & { realPath: string }>;
  readCandidate: boolean;
  readableHandoffs: "all" | readonly string[];
  defaultSourceIgnores: boolean;
  excludes: string[];
  writeTarget?: WikiWriteTarget;
}

export function writeGuardFromPlan(plan: WikiPinnedSourcePlan, candidateRoot: string): WikiWriteGuard {
  const workspaceRoot = path.resolve(plan.workspaceRoot);
  const resolvedCandidate = path.resolve(candidateRoot);
  return {
    workspaceRoot,
    candidateRoot: resolvedCandidate,
    handoffsRoot: path.join(path.dirname(resolvedCandidate), "handoffs"),
    sources: plan.sources.map(({ scopeId, logicalPath, realPath, catalog }) => ({
      scopeId,
      logicalPath,
      realPath,
      ...(catalog ? { catalog } : {}),
    })),
    readCandidate: true,
    readableHandoffs: "all",
    defaultSourceIgnores: plan.defaultSourceIgnores,
    excludes: [...plan.excludes],
  };
}

/** Map a canonical Workspace-relative path onto the host filesystem. */
export function resolveToolPath(guard: WikiWriteGuard, input: string): string {
  const segments = workspacePathSegments(input);
  return segments[0] === "wiki"
    ? path.join(guard.candidateRoot, ...segments.slice(1))
    : path.join(guard.workspaceRoot, ...segments);
}

export function assertReadable(guard: WikiWriteGuard, input: string): string {
  const resolved = resolveToolPath(guard, input);
  if (contained(guard.candidateRoot, resolved) && input !== "wiki" && !input.startsWith("wiki/")) {
    throw new Error(`Use the Candidate's Workspace-relative wiki/... path: ${input}`);
  }
  const relative = path.relative(guard.workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the Wiki workspace: ${input}`);
  }
  if (pathIsIgnored(guard, resolved)) {
    throw new Error(`Path is excluded by source ignore rules: ${input}`);
  }
  if (!readRoot(guard, resolved)) {
    throw new Error(`Path is outside the current Run evidence view: ${input}`);
  }
  return resolved;
}

/** Verify filesystem resolution as well as lexical containment before a tool reads an entry. */
export async function assertReadableEntry(guard: WikiWriteGuard, input: string): Promise<string> {
  const resolved = assertReadable(guard, input);
  await assertReadableNativeEntry(guard, resolved, input);
  return resolved;
}

/** Validate a path already mapped by the host without accepting host paths from the model. */
export async function assertReadableNativeEntry(
  guard: WikiWriteGuard,
  resolved: string,
  display = workspaceRelativePath(guard, resolved) ?? "requested path",
): Promise<string> {
  if (!path.isAbsolute(resolved)) throw new Error("Internal Wiki tool path must be absolute");
  const root = readRoot(guard, resolved);
  if (!root) throw new Error(`Path is outside the current Run evidence view: ${display}`);
  let actual: string;
  try {
    actual = await realpath(resolved);
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
  const actualRoot = await realpath(root);
  if (!contained(actualRoot, actual)) {
    throw new Error(`Path resolves outside the current Run evidence view: ${display}`);
  }
  return resolved;
}

/** Convert an authorized native path back to the one model-facing coordinate system. */
export function workspaceRelativePath(guard: WikiWriteGuard, absolutePath: string): string | undefined {
  const resolved = path.resolve(absolutePath);
  const candidate = relativeInside(guard.candidateRoot, resolved);
  if (candidate !== undefined) return joinPosix("wiki", candidate);
  const handoff = relativeInside(guard.handoffsRoot, resolved);
  if (handoff !== undefined) {
    const root = path.relative(guard.workspaceRoot, guard.handoffsRoot).replaceAll("\\", "/");
    return joinPosix(root, handoff);
  }
  for (const source of guard.sources) {
    const logicalRoot = path.join(guard.workspaceRoot, ...source.logicalPath.split("/"));
    const logical = relativeInside(logicalRoot, resolved);
    if (logical !== undefined) return joinPosix(source.logicalPath, logical);
    const physical = relativeInside(source.realPath, resolved);
    if (physical !== undefined) return joinPosix(source.logicalPath, physical);
  }
  const workspace = relativeInside(guard.workspaceRoot, resolved);
  return workspace === undefined ? undefined : workspace || ".";
}

export function pathIsIgnored(guard: WikiWriteGuard, absolutePath: string): boolean {
  const resolved = path.resolve(absolutePath);
  if (contained(guard.candidateRoot, resolved) || contained(guard.handoffsRoot, resolved)) return false;
  for (const { logicalPath: sourcePath } of guard.sources) {
    const root = path.resolve(guard.workspaceRoot, sourcePath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    return sourceIsIgnored(
      { path: sourcePath },
      relative === "" ? "." : relative,
      guard.defaultSourceIgnores,
      guard.excludes,
    );
  }
  return false;
}

function readRoot(guard: WikiWriteGuard, resolved: string): string | undefined {
  if (guard.readCandidate && contained(guard.candidateRoot, resolved)) return guard.candidateRoot;
  if (contained(guard.handoffsRoot, resolved) && handoffIsReadable(guard, resolved)) return guard.handoffsRoot;
  for (const source of guard.sources) {
    const logicalRoot = path.join(guard.workspaceRoot, ...source.logicalPath.split("/"));
    if (contained(logicalRoot, resolved) || contained(source.realPath, resolved)) return source.realPath;
  }
  return undefined;
}

function handoffIsReadable(guard: WikiWriteGuard, resolved: string): boolean {
  if (guard.readableHandoffs === "all") return true;
  return guard.readableHandoffs.some((location) => resolveToolPath(guard, location) === resolved);
}

function workspacePathSegments(input: string): string[] {
  if (input === ".") return [];
  if (
    !input
    || input.includes("\\")
    || input.includes("\0")
    || input.startsWith("/")
    || /^[A-Za-z]:/.test(input)
  ) throw invalidWorkspacePath(input);
  const segments = input.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalidWorkspacePath(input);
  }
  return segments;
}

function invalidWorkspacePath(input: string): Error {
  return new Error(`Use a POSIX Workspace-relative path without a leading slash: ${input || "(empty)"}`);
}

function relativeInside(root: string, candidate: string): string | undefined {
  const relative = path.relative(path.resolve(root), candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.replaceAll("\\", "/");
}

function joinPosix(root: string, suffix: string): string {
  if (!root || root === ".") return suffix || ".";
  return suffix ? `${root}/${suffix}` : root;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertAgentPartition(
  agent: string,
  partition: string,
  plan: WikiPinnedSourcePlan,
  writeMode?: WikiWriteTarget["mode"],
): void {
  if (!plan.sources.length) return;
  const implicit = plan.sources.length === 1 && isImplicitPinPath(plan.sources[0]?.logicalPath ?? "");
  const scopeIds = new Set(plan.sources.map((source) => source.scopeId));
  if (agent === "survey") {
    if (!scopeIds.has(partition)) throw new Error(`survey partition must be a pinned Source id: ${partition}`);
    return;
  }
  if (agent === "synthesize") {
    if (partition !== "workspace-analysis") throw new Error("synthesize partition must be workspace-analysis");
    return;
  }
  if (agent === "review") {
    if (partition !== "candidate") throw new Error("review partition must be candidate");
    return;
  }
  if (agent !== "write") return;
  if (!writeMode) throw new Error("write assignment requires writeMode subtree or directory");
  if (partition === "wiki-root") {
    if (writeMode === "directory") return;
    throw new Error("wiki-root write target must use directory mode");
  }
  const segments = partition.split("/");
  if (implicit) {
    if (writeMode === "subtree" && segments.length === 1 && isWikiTaxonomySlug(partition)) return;
    throw new Error(`implicit write target must be one Domain subtree or wiki-root directory: ${writeMode}:${partition}`);
  }
  if (writeMode === "directory" && segments.length === 1 && scopeIds.has(partition)) return;
  if (writeMode === "subtree" && segments.length === 2 && scopeIds.has(segments[0]!) && isWikiTaxonomySlug(segments[1]!)) return;
  throw new Error(`explicit write target must be one Repository directory or Domain subtree: ${writeMode}:${partition}`);
}

export function guardForWorker(
  guard: WikiWriteGuard,
  agent: string,
  partition: string,
  handoffs: readonly string[],
): WikiWriteGuard {
  const implicit = guard.sources.length === 1 && guard.sources[0]?.logicalPath === ".";
  const owner = implicit
    ? guard.sources[0]
    : guard.sources.find((source) => partition === source.scopeId || partition.startsWith(`${source.scopeId}/`));
  const sources = agent === "synthesize" || agent === "review" || (agent === "write" && partition === "wiki-root")
    ? guard.sources
    : owner ? [owner] : [];
  return {
    ...guard,
    sources,
    readCandidate: agent === "write" || agent === "review",
    readableHandoffs: agent === "survey" ? [] : [...handoffs],
  };
}

export { writeTargetAllows, writeTargetsOverlap };

export function assertWritable(guard: WikiWriteGuard, input: string): string {
  const resolved = assertReadable(guard, input);
  const relative = path.relative(guard.candidateRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Wiki writes must stay in the unpublished Candidate (use wiki/ paths)");
  }
  const posix = relative.replaceAll("\\", "/");
  if (!writeTargetAllows(guard.writeTarget, posix)) {
    throw new Error(`Wiki writes for target ${guard.writeTarget?.mode}:${guard.writeTarget?.path} cannot include ${relative}`);
  }
  if (!isSafeWikiPagePath(posix)) {
    throw new Error(`Illegal Wiki page path: ${posix}`);
  }
  const ledger = path.join(guard.workspaceRoot, ".okf-wiki");
  const fromLedger = path.relative(ledger, resolved);
  if (fromLedger && !fromLedger.startsWith("..") && !path.isAbsolute(fromLedger)) {
    const fromCandidate = path.relative(guard.candidateRoot, resolved);
    if (fromCandidate.startsWith("..") || path.isAbsolute(fromCandidate)) {
      throw new Error("Do not edit Wiki run ledgers");
    }
  }
  return resolved;
}
