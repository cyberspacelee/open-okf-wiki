import { cp, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";
import { validateWikiTree } from "./validate-wiki.js";
import { countMarkdownFiles } from "./wiki-tree.js";

export type PublishStagingInput = {
  stagingDir: string;
  publicationPath: string;
  /** Optional run id for diagnostics / future release naming. */
  runId?: string;
  /**
   * Pinned Snapshot sources for mechanical Source Citation resolve (ADR 0008).
   * When set, validateWikiTree checks citations against these roots.
   */
  sources?: Array<{ id: string; path: string }>;
};

export type PublishStagingResult = {
  publicationPath: string;
  pageCount: number;
};

/**
 * Publish a staging Wiki tree to the stable Published Wiki path.
 *
 * Portable MVP (ADR 0017): materialize a complete tree under a sibling temp
 * directory, then expose it via same-parent renames so readers never see a
 * half-written publication path.
 *
 * 1. Absolute paths; staging is a real directory with ≥1 `.md`
 * 2. Reject symlink components on staging / publication / parent
 * 3. Copy staging → `{publicationPath}.next.{ts}` (complete candidate)
 * 4. If live publication exists → rename aside to `.prev.{ts}`
 * 5. Rename candidate → publicationPath
 * 6. On failure after moving live aside, best-effort restore from aside
 */
export async function publishStagingToPublication(
  input: PublishStagingInput,
): Promise<PublishStagingResult> {
  const stagingDir = path.resolve(assertAbsolutePath(input.stagingDir, "stagingDir"));
  const publicationPath = path.resolve(
    assertAbsolutePath(input.publicationPath, "publicationPath"),
  );

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

  // Mechanical wiki validation before any copy (frontmatter, citations, caps).
  const validation = await validateWikiTree(stagingDir, {
    ...(input.sources?.length ? { sources: input.sources } : {}),
  });
  if (!validation.ok) {
    throw new Error(`staging failed wiki validation: ${validation.errors.join("; ")}`);
  }
  const pageCount = validation.pageCount ?? (await countMarkdownFiles(stagingDir));
  if (pageCount < 1) {
    throw new Error(`staging has no markdown pages: ${stagingDir}`);
  }

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
