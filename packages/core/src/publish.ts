import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";
import { validateWikiTree } from "./validate-wiki.js";
import { generateWikiIndexes } from "./wiki-index.js";
import {
  appendRootLog,
  diffConceptSnapshots,
  listConceptContentHashes,
} from "./wiki-log.js";

export type PublishStagingInput = {
  stagingDir: string;
  publicationPath: string;
  /** Workspace display name — root `index.md` H1 (required). */
  workspaceName: string;
  /** Optional run id recorded in root `log.md`. */
  runId?: string;
  /**
   * Skill digest/version label for root `log.md` (defaults to `unknown`).
   */
  skill?: string;
  /**
   * @deprecated Not used by the hard gate (ADR 0028: format/placement only).
   * Kept for call-site compatibility until agent wiring drops it.
   */
  sources?: Array<{ id: string; path: string }>;
};

export type PublishStagingResult = {
  publicationPath: string;
  /** Concept page count (excludes reserved index/log). */
  pageCount: number;
};

// Re-export for callers that imported from publish historically.
export { assertNoSymlinkComponents } from "./paths.js";

/** Count `.md` files under `dir` (recursive). */
export async function countMarkdownFiles(dir: string): Promise<number> {
  let count = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Do not follow symlinks when counting pages.
      continue;
    }
    if (entry.isDirectory()) {
      count += await countMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      count += 1;
    }
  }
  return count;
}

/**
 * Publish a staging Wiki tree to the stable Published Wiki path.
 *
 * ADR 0028 pipeline:
 * 1. Generate/overwrite deterministic `index.md` on Staging (`workspaceName`)
 * 2. `validateWikiTree` hard checks
 * 3. Atomic copy/rename to `publicationPath` (ADR 0017)
 * 4. On the candidate (before rename): append root `log.md` from concept diff
 *    vs previous Published — so Published includes the new log entry.
 *    Any failure before successful replace leaves prior Published unchanged.
 */
export async function publishStagingToPublication(
  input: PublishStagingInput,
): Promise<PublishStagingResult> {
  const stagingDir = path.resolve(
    assertAbsolutePath(input.stagingDir, "stagingDir"),
  );
  const publicationPath = path.resolve(
    assertAbsolutePath(input.publicationPath, "publicationPath"),
  );
  const workspaceName = input.workspaceName?.trim() ?? "";
  if (!workspaceName) {
    throw new Error("workspaceName must be a non-empty string");
  }

  let stagingInfo;
  try {
    stagingInfo = await lstat(stagingDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(`staging directory does not exist: ${stagingDir}`);
    }
    throw error;
  }
  if (stagingInfo.isSymbolicLink()) {
    throw new Error(`stagingDir is a symlink: ${stagingDir}`);
  }
  if (!stagingInfo.isDirectory()) {
    throw new Error(`stagingDir is not a directory: ${stagingDir}`);
  }

  await assertNoSymlinkComponents(stagingDir, "stagingDir");
  await assertNoSymlinkComponents(publicationPath, "publicationPath");

  try {
    const pubInfo = await lstat(publicationPath);
    if (pubInfo.isSymbolicLink()) {
      throw new Error(`publicationPath is a symlink: ${publicationPath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  // 1. Deterministic indexes on Staging (before concept hard gates).
  await generateWikiIndexes({
    wikiRoot: stagingDir,
    workspaceName,
  });

  // 2. Mechanical OKF validation (FM, links, citations placement, reserved, caps).
  const validation = await validateWikiTree(stagingDir);
  if (!validation.ok) {
    throw new Error(
      `staging failed wiki validation: ${validation.errors.join("; ")}`,
    );
  }
  const pageCount =
    validation.conceptCount ?? validation.pageCount ?? 0;
  if (pageCount < 1) {
    throw new Error(`staging has no concept pages: ${stagingDir}`);
  }

  // Snapshot previous Published concepts for log diff (before replace).
  let previousConcepts = new Map<string, string>();
  try {
    const pubInfo = await lstat(publicationPath);
    if (pubInfo.isDirectory() && !pubInfo.isSymbolicLink()) {
      previousConcepts = await listConceptContentHashes(publicationPath);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const nextConcepts = await listConceptContentHashes(stagingDir);
  const diff = diffConceptSnapshots(previousConcepts, nextConcepts);

  const parent = path.dirname(publicationPath);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkComponents(parent, "publicationPath parent");

  const stamp = Date.now();
  const candidate = `${publicationPath}.next.${stamp}`;
  const aside = `${publicationPath}.prev.${stamp}`;

  // Clean leftover candidate if a previous crash left one.
  await rm(candidate, { recursive: true, force: true });

  await cp(stagingDir, candidate, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  const candidateInfo = await lstat(candidate);
  if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()) {
    await rm(candidate, { recursive: true, force: true });
    throw new Error(`candidate release is not a directory: ${candidate}`);
  }
  const candidatePages = await countMarkdownFiles(candidate);
  if (candidatePages < 1) {
    await rm(candidate, { recursive: true, force: true });
    throw new Error(`candidate release has no markdown pages: ${candidate}`);
  }

  // 3b. Append root log on the candidate so Published includes the entry.
  //     Seed from prior Published log first — staging is concept-only and must
  //     not wipe history. Prior Published stays live until rename succeeds.
  const candidateLog = path.join(candidate, "log.md");
  try {
    const prevLog = await readFile(path.join(publicationPath, "log.md"), "utf8");
    await writeFile(candidateLog, prevLog, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      await rm(candidate, { recursive: true, force: true });
      throw error;
    }
    // First publish or no prior log: drop any agent-staged log so append creates clean.
    await rm(candidateLog, { force: true });
  }

  await appendRootLog(candidate, {
    runId: input.runId ?? "unknown",
    skill: input.skill ?? "unknown",
    added: diff.added,
    updated: diff.updated,
    removed: diff.removed,
  });

  let movedAside = false;
  try {
    await stat(publicationPath);
    await rename(publicationPath, aside);
    movedAside = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      await rm(candidate, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    await rename(candidate, publicationPath);
  } catch (error) {
    // Best-effort restore previous live tree if we moved it aside.
    if (movedAside) {
      try {
        await rename(aside, publicationPath);
      } catch {
        // Leave aside + candidate for operator recovery.
      }
    }
    await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const finalInfo = await lstat(publicationPath);
  if (finalInfo.isSymbolicLink()) {
    throw new Error(`publicationPath became a symlink after publish: ${publicationPath}`);
  }
  if (!finalInfo.isDirectory()) {
    throw new Error(`publicationPath is not a directory after publish: ${publicationPath}`);
  }

  return {
    publicationPath,
    pageCount,
  };
}
