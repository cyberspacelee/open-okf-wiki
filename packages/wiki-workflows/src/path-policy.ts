import path from "node:path";
import type { WikiPinnedSourcePlan } from "./inspect.js";

export interface WikiWriteGuard {
  workspaceRoot: string;
  candidateRoot: string;
  publishedWikiRoot: string;
  sourceRoots: Map<string, string>;
}

export function writeGuardFromPlan(plan: WikiPinnedSourcePlan, candidateRoot: string): WikiWriteGuard {
  const workspaceRoot = path.resolve(plan.workspaceRoot);
  return {
    workspaceRoot,
    candidateRoot: path.resolve(candidateRoot),
    publishedWikiRoot: path.join(workspaceRoot, "wiki"),
    sourceRoots: new Map(plan.sources.map((source) => [source.scopeId, source.realPath])),
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
  return resolved;
}

export function assertWritable(guard: WikiWriteGuard, input: string): string {
  const resolved = assertReadable(guard, input);
  const relative = path.relative(guard.candidateRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Wiki writes must stay in the unpublished Candidate (use wiki/ paths)");
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
