import { lstat, readdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePage, stringifyPage } from "../frontmatter.js";
import { readText } from "../files.js";
import { formatIssue, type WikiFinalization } from "../types.js";
import type { WikiSpec } from "./spec.js";
import {
  materializeWikiIndexes,
  removeRegularWikiFile,
  resolveWikiRoots,
  safeWikiPath,
  scanWikiTree,
  specPagePaths,
  type ResolvedWikiRoots,
} from "./indexes.js";
import { isReservedWikiPagePath } from "./path.js";
import {
  GENERATED_BY,
  VERIFIED_BY,
  isIsoTimestamp,
  isPublisherActor,
  sameStrings,
  validateWikiCandidate,
} from "./validate.js";

export type WikiFinalizeFaultPoint =
  | "afterValidation"
  | "afterObsoleteRemoval"
  | "afterStamp"
  | "afterIndexes"
  | "afterCleanup";

export interface WikiFinalizeOptions {
  fault?: (point: WikiFinalizeFaultPoint) => void | Promise<void>;
  pinnedRoots?: ResolvedWikiRoots;
}

/**
 * Apply the deterministic Wiki lifecycle after semantic review has passed.
 * A failed operation throws and can be retried without relying on saved state.
 */
export async function finalizeWiki(
  root: string,
  spec: WikiSpec,
  wikiDirectory = "wiki",
  publicationAt = new Date().toISOString(),
  requiredSections: readonly string[] = [],
  options: WikiFinalizeOptions = {},
): Promise<WikiFinalization> {
  assertPublicationTimestamp(publicationAt);
  const validation = await validateWikiCandidate(root, spec, wikiDirectory, false, undefined, requiredSections, options.pinnedRoots);
  if (!validation.ok) {
    throw new Error(`Wiki finalization requires a valid target Wiki: ${validation.issues.map(formatIssue).join("; ")}`);
  }

  const targetPages = specPagePaths(spec);
  if (!sameStrings(validation.pages, targetPages)) {
    throw new Error("Wiki finalization requires every target page to exist");
  }
  await options.fault?.("afterValidation");

  const roots = options.pinnedRoots ?? await resolveWikiRoots(root, wikiDirectory);
  const before = await scanWikiTree(roots.wiki);
  if (before.issues.length) throw new Error(`Unsafe Wiki tree: ${before.issues.map(formatIssue).join("; ")}`);
  const obsoletePages = [...validation.obsoletePages];
  const removedPages: string[] = [];

  for (const page of obsoletePages) {
    const removed = await removeRegularWikiFile(roots.wiki, page);
    if (removed) removedPages.push(page);
  }
  await options.fault?.("afterObsoleteRemoval");

  await stampWikiPages(roots.wiki, targetPages, publicationAt);
  await options.fault?.("afterStamp");
  const rebuiltIndexes = await materializeWikiIndexes(root, spec, wikiDirectory, roots);
  await options.fault?.("afterIndexes");
  await removeEmptyWikiDirectories(roots.wiki);
  await options.fault?.("afterCleanup");

  const after = await scanWikiTree(roots.wiki);
  if (after.issues.length) throw new Error(`Unsafe Wiki tree after finalization: ${after.issues.map(formatIssue).join("; ")}`);
  const finalPages = after.markdown.filter((page) => !isReservedWikiPagePath(page)).sort();
  const finalIndexes = after.markdown.filter((page) => path.posix.basename(page) === "index.md").sort();
  if (!sameStrings(finalPages, targetPages)) throw new Error("Final Wiki page set does not exactly match the WikiSpec");
  if (!sameStrings(finalIndexes, rebuiltIndexes)) throw new Error("Final Wiki index set does not match the target page tree");

  return {
    pages: targetPages,
    obsoletePages,
    removedPages: removedPages.sort(),
    rebuiltIndexes,
  };
}

/** Build review navigation only after every current Spec page passes deterministic validation. */
export async function materializeValidatedWikiIndexes(
  root: string,
  spec: WikiSpec,
  wikiDirectory = "wiki",
  excludedPaths?: readonly string[],
  requiredSections: readonly string[] = [],
  pinnedRoots?: ResolvedWikiRoots,
): Promise<string[]> {
  const validation = await validateWikiCandidate(root, spec, wikiDirectory, false, excludedPaths, requiredSections, pinnedRoots);
  if (!validation.ok) {
    throw new Error(`Wiki indexes require valid target pages: ${validation.issues.map(formatIssue).join("; ")}`);
  }
  const targetPages = specPagePaths(spec);
  if (!sameStrings(validation.pages, targetPages)) {
    throw new Error("Wiki indexes require every target page to exist");
  }
  return materializeWikiIndexes(root, spec, wikiDirectory, pinnedRoots);
}

async function stampWikiPages(wikiRoot: string, targetPages: readonly string[], publicationAt: string): Promise<void> {
  const stamped: Array<{ absolute: string; content: string }> = [];
  for (const page of targetPages) {
    const absolute = safeWikiPath(wikiRoot, page);
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Cannot stamp a non-regular Wiki page: ${page}`);
    const parsed = parsePage(await readText(absolute));
    if (!isPublisherActor(parsed.frontmatter.generated, GENERATED_BY, true)) {
      parsed.frontmatter.generated = { by: GENERATED_BY, at: publicationAt };
    }
    parsed.frontmatter.verified = { by: VERIFIED_BY, at: publicationAt };
    stamped.push({ absolute, content: stringifyPage(parsed) });
  }
  for (const page of stamped) await writeFile(page.absolute, page.content, "utf8");
}

function assertPublicationTimestamp(value: string): void {
  if (!isIsoTimestamp(value)) throw new Error(`Wiki publication timestamp must be an ISO-8601 date-time: ${value}`);
}

async function removeEmptyWikiDirectories(wikiRoot: string, relative = ""): Promise<void> {
  const directory = relative ? safeWikiPath(wikiRoot, relative) : wikiRoot;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    await removeEmptyWikiDirectories(wikiRoot, child);
  }
  if (relative && (await readdir(directory)).length === 0) await rmdir(directory);
}
