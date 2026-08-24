import path from "node:path";
import { realpath } from "node:fs/promises";
import type { CitationSource } from "./citations.js";
import { sourceIsIgnored, type WikiPinnedSourcePlan } from "./inspect.js";
import { isImplicitPinPath, isSafeWikiPagePath, isWikiTaxonomySlug } from "./path.js";
import { writeTargetAllows, writeTargetsOverlap, type WikiWriteTarget } from "./write-target.js";

export interface WikiWriteGuard {
  workspaceRoot: string;
  candidateRoot: string;
  publishedWikiRoot: string;
  handoffsRoot: string;
  sources: Array<CitationSource & { realPath: string }>;
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
    publishedWikiRoot: path.join(workspaceRoot, "wiki"),
    handoffsRoot: path.join(path.dirname(resolvedCandidate), "handoffs"),
    sources: plan.sources.map(({ scopeId, logicalPath, realPath }) => ({ scopeId, logicalPath, realPath })),
    defaultSourceIgnores: plan.defaultSourceIgnores,
    excludes: [...plan.excludes],
  };
}

/** Map a model-facing `wiki/...` path onto the unpublished Candidate. */
export function resolveToolPath(guard: WikiWriteGuard, input: string): string {
  const absolute = path.resolve(guard.workspaceRoot, input);
  const published = path.resolve(guard.publishedWikiRoot);
  const relative = path.relative(published, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.resolve(guard.candidateRoot, relative);
  }
  return absolute;
}

export function assertReadable(guard: WikiWriteGuard, input: string): string {
  const resolved = resolveToolPath(guard, input);
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
  let actual: string;
  try {
    actual = await realpath(resolved);
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw error;
  }
  const root = readRoot(guard, resolved);
  if (!root) throw new Error(`Path is outside the current Run evidence view: ${input}`);
  const actualRoot = await realpath(root);
  if (!contained(actualRoot, actual)) {
    throw new Error(`Path resolves outside the current Run evidence view: ${input}`);
  }
  return resolved;
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
  if (contained(guard.candidateRoot, resolved)) return guard.candidateRoot;
  if (contained(guard.handoffsRoot, resolved)) return guard.handoffsRoot;
  for (const source of guard.sources) {
    const logicalRoot = path.resolve(guard.workspaceRoot, source.logicalPath);
    if (contained(logicalRoot, resolved)) return source.realPath;
  }
  return undefined;
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
