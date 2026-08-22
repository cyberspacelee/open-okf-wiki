import path from "node:path";
import type { CitationSource } from "./citations.js";
import { sourceIsIgnored, type WikiPinnedSourcePlan } from "./inspect.js";
import { isImplicitPinPath, isSafeWikiPagePath, isWikiTaxonomySlug } from "./path.js";

export interface WikiWriteGuard {
  workspaceRoot: string;
  candidateRoot: string;
  publishedWikiRoot: string;
  handoffsRoot: string;
  sources: CitationSource[];
  defaultSourceIgnores: boolean;
  excludes: string[];
  writePartition?: string;
}

export function writeGuardFromPlan(plan: WikiPinnedSourcePlan, candidateRoot: string): WikiWriteGuard {
  const workspaceRoot = path.resolve(plan.workspaceRoot);
  const resolvedCandidate = path.resolve(candidateRoot);
  return {
    workspaceRoot,
    candidateRoot: resolvedCandidate,
    publishedWikiRoot: path.join(workspaceRoot, "wiki"),
    handoffsRoot: path.join(path.dirname(resolvedCandidate), "handoffs"),
    sources: plan.sources.map(({ scopeId, logicalPath }) => ({ scopeId, logicalPath })),
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

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function writePartitionAllows(partition: string | undefined, relative: string): boolean {
  if (!partition || partition === "candidate" || partition === "wiki") return true;
  const posix = relative.replaceAll("\\", "/");
  if (partition === "wiki-root") return !posix.includes("/");
  return posix === partition || posix.startsWith(`${partition}/`);
}

export function assertAgentPartition(agent: string, partition: string, plan: WikiPinnedSourcePlan): void {
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
  if (partition === "wiki-root" || partition === "candidate" || partition === "wiki") return;
  if (implicit) {
    if (isWikiTaxonomySlug(partition)) return;
    throw new Error(`write partition is not a domain prefix: ${partition}`);
  }
  if (scopeIds.has(partition)) return;
  throw new Error(`write partition is not a Repository Section: ${partition}`);
}

export function writePartitionsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  if (left === "wiki-root" || right === "wiki-root") return false;
  if (left === "candidate" || left === "wiki" || right === "candidate" || right === "wiki") return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function assertWritable(guard: WikiWriteGuard, input: string): string {
  const resolved = assertReadable(guard, input);
  const relative = path.relative(guard.candidateRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Wiki writes must stay in the unpublished Candidate (use wiki/ paths)");
  }
  const posix = relative.replaceAll("\\", "/");
  if (!writePartitionAllows(guard.writePartition, posix)) {
    throw new Error(`Wiki writes for partition ${guard.writePartition} cannot include ${relative}`);
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
