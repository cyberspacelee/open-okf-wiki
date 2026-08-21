import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";
import { loadWikiWorkspace, sourceIsIgnored, type ResolvedWikiSource } from "./workspace.js";
import { IMPLICIT_SOURCE_SCOPE_ID, isImplicitPinPath } from "./path.js";

export interface WikiPinnedSource {
  scopeId: string;
  logicalPath: string;
  absolutePath: string;
  realPath: string;
  repositoryRoot: string;
  repositoryIdentity: string;
  origin: { type: "link"; localPath: string } | { type: "clone"; remoteUrl: string; ref?: string };
  head: string;
  dirtyFingerprint: string;
}

export interface WikiPinnedSourcePlan {
  workspaceRoot: string;
  workspaceRealPath: string;
  configPath: string;
  defaultSourceIgnores: boolean;
  excludes: string[];
  sources: WikiPinnedSource[];
  fingerprint: string;
}

interface SourceChange { status: string; paths: string[] }

function normalizePath(candidate: string): string { return candidate.replaceAll("\\", "/"); }

function parseNameStatus(output: string): SourceChange[] {
  const fields = output.split("\0");
  const changes: SourceChange[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) continue;
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(index, index + pathCount).map(normalizePath);
    index += pathCount;
    if (paths.length === pathCount && paths.every(Boolean)) changes.push({ status, paths });
  }
  return changes;
}

function parsePaths(output: string): string[] { return output.split("\0").filter(Boolean).map(normalizePath); }

function uniqueChanges(changes: SourceChange[]): SourceChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.status}\0${change.paths.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function gitChanges(root: string, args: string[], source: ResolvedWikiSource, defaultsEnabled: boolean, excludes: readonly string[]): Promise<SourceChange[]> {
  const result = await git(root, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return parseNameStatus(result.stdout)
    .map((change) => ({ ...change, paths: change.paths.filter((candidate) => !sourceIsIgnored(source, candidate, defaultsEnabled, excludes)) }))
    .filter((change) => change.paths.length > 0);
}

async function untrackedChanges(root: string, source: ResolvedWikiSource, defaultsEnabled: boolean, excludes: readonly string[]): Promise<SourceChange[]> {
  const result = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return parsePaths(result.stdout)
    .filter((candidate) => !sourceIsIgnored(source, candidate, defaultsEnabled, excludes))
    .map((candidate) => ({ status: "??", paths: [candidate] }));
}

async function sourceState(source: ResolvedWikiSource, defaultsEnabled: boolean, excludes: readonly string[]) {
  const headResult = await git(source.repositoryRoot, ["rev-parse", "HEAD"]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : "";
  const staged = await gitChanges(source.repositoryRoot, ["diff", "--cached", "--name-status", "-z"], source, defaultsEnabled, excludes);
  const unstaged = await gitChanges(source.repositoryRoot, ["diff", "--name-status", "-z"], source, defaultsEnabled, excludes);
  const untracked = await untrackedChanges(source.repositoryRoot, source, defaultsEnabled, excludes);
  const changes = uniqueChanges([...staged, ...unstaged, ...untracked]);
  const hash = createHash("sha256");
  hash.update(source.path); hash.update("\0"); hash.update(head);
  for (const change of [...changes].sort((left, right) => `${left.status}\0${left.paths.join("\0")}`.localeCompare(`${right.status}\0${right.paths.join("\0")}`))) {
    hash.update(change.status); hash.update("\0");
    for (const relative of change.paths) {
      hash.update(relative); hash.update("\0");
      try { hash.update(await readFile(path.join(source.realPath, relative))); } catch { hash.update("missing"); }
      hash.update("\0");
    }
  }
  return { source, head, changes, fingerprint: hash.digest("hex") };
}

async function repositoryIdentity(repositoryRoot: string): Promise<string> {
  const common = await git(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0) throw new Error(common.stderr.trim() || "Unable to identify Git repository");
  const commonPath = path.resolve(repositoryRoot, common.stdout.trim());
  const physical = await realpath(commonPath);
  const identity = await stat(physical);
  return createHash("sha256")
    .update(await realpath(repositoryRoot)).update("\0")
    .update(physical).update("\0")
    .update(`${identity.dev}:${identity.ino}`)
    .digest("hex");
}

export function wikiSourceSlug(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  return isImplicitPinPath(normalized) ? IMPLICIT_SOURCE_SCOPE_ID : normalized;
}

async function pinnedSource(
  source: ResolvedWikiSource,
  head: string,
  dirtyFingerprint: string,
): Promise<WikiPinnedSource> {
  return {
    scopeId: wikiSourceSlug(source.path),
    logicalPath: source.path,
    absolutePath: path.resolve(source.absolutePath),
    realPath: await realpath(source.realPath),
    repositoryRoot: await realpath(source.repositoryRoot),
    repositoryIdentity: await repositoryIdentity(source.repositoryRoot),
    origin: structuredClone(source.origin),
    head,
    dirtyFingerprint,
  };
}

/** Inspect the complete declared source input for one full-generation run. */
export async function inspectWiki(cwd: string): Promise<WikiPinnedSourcePlan> {
  const workspace = await loadWikiWorkspace(cwd);
  if (workspace.sources.length === 0) throw new Error("workspace.yaml has no sources. Run /wiki source add first.");
  const states = await Promise.all(workspace.sources.map((source) => sourceState(source, workspace.defaultSourceIgnores, workspace.wiki.exclude)));
  const sources = await Promise.all(states.map(({ source, head, fingerprint }) => pinnedSource(source, head, fingerprint)));
  const sourceFingerprint = createHash("sha256").update(sources
    .map((source) => `${source.scopeId}\0${JSON.stringify(source.origin)}\0${source.realPath}\0${source.repositoryIdentity}\0${source.dirtyFingerprint}`)
    .sort().join("\0")).digest("hex");
  return {
    workspaceRoot: path.resolve(workspace.root),
    workspaceRealPath: await realpath(workspace.root),
    configPath: path.resolve(workspace.configPath),
    defaultSourceIgnores: workspace.defaultSourceIgnores,
    excludes: [...workspace.wiki.exclude],
    sources: sources.sort((left, right) => left.scopeId.localeCompare(right.scopeId)),
    fingerprint: sourceFingerprint,
  };
}

/** Re-check only the source identities and bytes pinned at run creation. */
export async function verifyPinnedSourcePlan(plan: WikiPinnedSourcePlan): Promise<void> {
  const workspacePhysical = await realpath(plan.workspaceRoot);
  if (workspacePhysical !== plan.workspaceRealPath) throw new Error("Pinned Wiki workspace identity changed");
  const current: WikiPinnedSource[] = [];
  for (const expected of plan.sources) {
    const physical = await realpath(expected.absolutePath);
    const repositoryRoot = await realpath(expected.repositoryRoot);
    if (physical !== expected.realPath || repositoryRoot !== expected.repositoryRoot) {
      throw new Error(`Pinned Wiki source identity changed: ${expected.scopeId}`);
    }
    const source: ResolvedWikiSource = {
      path: expected.logicalPath,
      origin: structuredClone(expected.origin),
      absolutePath: expected.absolutePath,
      realPath: expected.realPath,
      repositoryRoot: expected.repositoryRoot,
    };
    const state = await sourceState(source, plan.defaultSourceIgnores, plan.excludes);
    current.push(await pinnedSource(source, state.head, state.fingerprint));
  }
  for (const expected of plan.sources) {
    const actual = current.find((source) => source.scopeId === expected.scopeId)!;
    if (actual.repositoryIdentity !== expected.repositoryIdentity) throw new Error(`Pinned Wiki repository identity changed: ${expected.scopeId}`);
    if (actual.head !== expected.head || actual.dirtyFingerprint !== expected.dirtyFingerprint) {
      throw new Error("Repository sources changed while the Wiki run was active; start a new Wiki run");
    }
  }
  const fingerprint = createHash("sha256").update(current
    .map((source) => `${source.scopeId}\0${JSON.stringify(source.origin)}\0${source.realPath}\0${source.repositoryIdentity}\0${source.dirtyFingerprint}`)
    .sort().join("\0")).digest("hex");
  if (fingerprint !== plan.fingerprint) throw new Error("Pinned Wiki source fingerprint changed");
}
