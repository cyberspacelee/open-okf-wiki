/**
 * Pi tool Operations write-scope / ignore wrappers (ADR 0030).
 *
 * Pure path policy for a run workdir:
 *   sources/  — snapshot mounts (read-only)
 *   skill/    — Producer Skill (read-only)
 *   wiki/     — Staging Wiki (writable for write roles)
 *   analysis/ — spec + receipts (writable for write roles)
 *
 * Host path guards are pure and unit-tested. When createAgentSession is given
 * `customTools` built here, write/edit are Operations-wrapped so the FS layer
 * cannot write outside wiki/ + analysis/. Read tools reject ignored source paths
 * when an ignore list is provided.
 */

import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { isPathInside, pathMatchesIgnore, resolveContainedPath } from "@okf-wiki/core";

/** Relative trees writable by write roles (trailing slash for prefix match). */
export const WRITE_SCOPE_PREFIXES = ["wiki/", "analysis/"] as const;

/** Relative trees that are never writable. */
export const READ_ONLY_PREFIXES = ["sources/", "skill/"] as const;

export type PathAccessMode = "read" | "write";

export type SourceIgnoreInput = ReadonlyMap<string, readonly string[]> | readonly string[];

export type AssertPathAllowedOptions = {
  mode: PathAccessMode;
  /**
   * Optional Effective Source Ignores applied when the path is under sources/.
   * - Map: per-sourceId patterns (repo-relative POSIX globs)
   * - Array: same patterns for every source mount
   */
  sourceIgnores?: SourceIgnoreInput;
};

/**
 * True if `candidate` is `dir` or a path strictly inside it
 * (resolved absolute comparison).
 */
export function isUnder(dir: string, candidate: string): boolean {
  return isPathInside(dir, candidate);
}

/** Normalize a workdir-relative path to POSIX segments without leading `./`. */
export function normalizeRelPath(relPath: string): string {
  if (typeof relPath !== "string") {
    throw new Error("path must be a string");
  }
  let n = relPath.trim().replace(/\\/g, "/");
  while (n.startsWith("./")) {
    n = n.slice(2);
  }
  if (n === "." || n === "") {
    return "";
  }
  // Strip trailing slash except for pure roots we don't use here.
  if (n.length > 1 && n.endsWith("/")) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * True when a run-workdir-relative path is inside the write scope
 * (`wiki/**` or `analysis/**`).
 */
export function isWriteScopeRel(relPath: string): boolean {
  const n = normalizeRelPath(relPath);
  if (n === "wiki" || n === "analysis") {
    return true;
  }
  return n.startsWith("wiki/") || n.startsWith("analysis/");
}

/** True when path is under sources/ or skill/ (read-only trees). */
export function isReadOnlyTreeRel(relPath: string): boolean {
  const n = normalizeRelPath(relPath);
  if (n === "sources" || n === "skill") {
    return true;
  }
  return n.startsWith("sources/") || n.startsWith("skill/");
}

/**
 * Parse `sources/<id>/...` into source id + repo-relative path.
 * Returns null when not under sources/.
 */
export function parseSourceMountPath(
  relPath: string,
): { sourceId: string; repoRel: string } | null {
  const n = normalizeRelPath(relPath);
  if (n === "sources") {
    return null;
  }
  if (!n.startsWith("sources/")) {
    return null;
  }
  const rest = n.slice("sources/".length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    // sources/<id> (mount root itself)
    return { sourceId: rest, repoRel: "" };
  }
  return {
    sourceId: rest.slice(0, slash),
    repoRel: rest.slice(slash + 1),
  };
}

function patternsForSource(
  sourceId: string,
  sourceIgnores: SourceIgnoreInput | undefined,
): readonly string[] | undefined {
  if (!sourceIgnores) {
    return undefined;
  }
  if (Array.isArray(sourceIgnores)) {
    return sourceIgnores;
  }
  const map = sourceIgnores as ReadonlyMap<string, readonly string[]>;
  return map.get(sourceId);
}

/**
 * True when a run-workdir-relative path under sources/ matches Effective Source Ignores.
 * Paths outside sources/ (or empty ignore list) are never ignored by this helper.
 */
export function isIgnoredSourceRel(
  relPath: string,
  sourceIgnores: SourceIgnoreInput | undefined,
): boolean {
  if (!sourceIgnores) {
    return false;
  }
  const parsed = parseSourceMountPath(relPath);
  if (!parsed || !parsed.repoRel) {
    return false;
  }
  const patterns = patternsForSource(parsed.sourceId, sourceIgnores);
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return pathMatchesIgnore(parsed.repoRel, patterns);
}

/**
 * Assert that `relPath` is allowed under `runWorkDir` for the given access mode.
 * Returns the resolved absolute path on success; throws on denial.
 */
export function assertPathAllowed(
  runWorkDir: string,
  relPath: string,
  options: AssertPathAllowedOptions,
): string {
  if (typeof runWorkDir !== "string" || runWorkDir.trim() === "") {
    throw new Error("runWorkDir must be a non-empty absolute path");
  }
  const root = path.resolve(runWorkDir);
  const abs = resolveContainedPath(root, relPath ?? "");
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  const norm = rel === "" ? "" : normalizeRelPath(rel);

  if (options.mode === "write") {
    if (!norm) {
      throw new Error("write path must be under wiki/ or analysis/");
    }
    if (isReadOnlyTreeRel(norm)) {
      throw new Error(`write denied: sources/ and skill/ are read-only (${norm})`);
    }
    if (!isWriteScopeRel(norm)) {
      throw new Error(`write denied: path must be under wiki/ or analysis/ (got ${norm})`);
    }
    return abs;
  }

  // read
  if (norm && isIgnoredSourceRel(norm, options.sourceIgnores)) {
    throw new Error(`read denied: path is ignored by Source Ignores (${norm})`);
  }
  return abs;
}

/**
 * Same policy as {@link assertPathAllowed}, but for absolute paths already
 * resolved by Pi tools (Operations receive absolute paths).
 */
export function assertAbsolutePathAllowed(
  runWorkDir: string,
  absolutePath: string,
  options: AssertPathAllowedOptions,
): string {
  const root = path.resolve(runWorkDir);
  const abs = path.resolve(absolutePath);
  if (!isUnder(root, abs)) {
    throw new Error(`path escapes run workdir: ${absolutePath}`);
  }
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  return assertPathAllowed(root, rel === "" ? "." : rel, options);
}

// --- Pi Operations wrappers -------------------------------------------------

export type WikiToolOperationsOptions = {
  runWorkDir: string;
  sourceIgnores?: SourceIgnoreInput;
};

function guardAbs(
  runWorkDir: string,
  absolutePath: string,
  mode: PathAccessMode,
  sourceIgnores?: SourceIgnoreInput,
): string {
  return assertAbsolutePathAllowed(runWorkDir, absolutePath, {
    mode,
    sourceIgnores,
  });
}

/** Read Operations: contain to runWorkDir + optional source ignores. */
export function createWikiReadOperations(options: WikiToolOperationsOptions): ReadOperations {
  const { runWorkDir, sourceIgnores } = options;
  return {
    async readFile(absolutePath) {
      guardAbs(runWorkDir, absolutePath, "read", sourceIgnores);
      return readFile(absolutePath);
    },
    async access(absolutePath) {
      guardAbs(runWorkDir, absolutePath, "read", sourceIgnores);
      await access(absolutePath, constants.R_OK);
    },
  };
}

/** Write Operations: only wiki/ + analysis/. */
export function createWikiWriteOperations(options: WikiToolOperationsOptions): WriteOperations {
  const { runWorkDir } = options;
  return {
    async writeFile(absolutePath, content) {
      guardAbs(runWorkDir, absolutePath, "write");
      await writeFile(absolutePath, content, "utf8");
    },
    async mkdir(dir) {
      guardAbs(runWorkDir, dir, "write");
      await mkdir(dir, { recursive: true });
    },
  };
}

/** Edit Operations: read+write under write scope only. */
export function createWikiEditOperations(options: WikiToolOperationsOptions): EditOperations {
  const { runWorkDir } = options;
  return {
    async readFile(absolutePath) {
      // edit only targets files that may be written
      guardAbs(runWorkDir, absolutePath, "write");
      return readFile(absolutePath);
    },
    async writeFile(absolutePath, content) {
      guardAbs(runWorkDir, absolutePath, "write");
      await writeFile(absolutePath, content, "utf8");
    },
    async access(absolutePath) {
      guardAbs(runWorkDir, absolutePath, "write");
      await access(absolutePath, constants.R_OK | constants.W_OK);
    },
  };
}

/** Ls Operations: contain + hide ignored source entries when listing. */
export function createWikiLsOperations(options: WikiToolOperationsOptions): LsOperations {
  const { runWorkDir, sourceIgnores } = options;
  const root = path.resolve(runWorkDir);
  return {
    exists(absolutePath) {
      try {
        guardAbs(runWorkDir, absolutePath, "read", sourceIgnores);
        return true;
      } catch {
        return false;
      }
    },
    async stat(absolutePath) {
      guardAbs(runWorkDir, absolutePath, "read", sourceIgnores);
      const info = await stat(absolutePath);
      return { isDirectory: () => info.isDirectory() };
    },
    async readdir(absolutePath) {
      guardAbs(runWorkDir, absolutePath, "read", sourceIgnores);
      const names = await readdir(absolutePath);
      if (!sourceIgnores) {
        return names;
      }
      const parentRel = path.relative(root, absolutePath).replace(/\\/g, "/");
      return names.filter((name) => {
        const childRel = parentRel ? `${parentRel}/${name}` : name;
        return !isIgnoredSourceRel(childRel, sourceIgnores);
      });
    },
  };
}

/** Grep Operations: path containment + ignore on readFile. */
export function createWikiGrepOperations(options: WikiToolOperationsOptions): GrepOperations {
  const { runWorkDir, sourceIgnores } = options;
  return {
    async isDirectory(absolutePath) {
      guardAbs(runWorkDir, absolutePath, "read", sourceIgnores);
      const info = await stat(absolutePath);
      return info.isDirectory();
    },
    async readFile(absolutePath) {
      guardAbs(runWorkDir, absolutePath, "read", sourceIgnores);
      return readFile(absolutePath, "utf8");
    },
  };
}

export type BuildWikiScopedToolsInput = {
  runWorkDir: string;
  /** When true, include write + edit tool definitions. */
  mayWrite: boolean;
  sourceIgnores?: SourceIgnoreInput;
};

/**
 * Build Pi ToolDefinitions that override built-ins via `customTools`.
 * Names match the allowlist from tool-policy (`read`, `ls`, `grep`, `find`,
 * and optionally `write` / `edit`).
 *
 * `find` uses stock Pi implementation (fd) — full ignore filtering for recursive
 * name search is optional and applied on direct path guards for read/ls/grep.
 * Return type is loose so heterogeneous ToolDefinition generics can share an array
 * (same pattern as createAgentSession `customTools`).
 */
export function buildWikiScopedToolDefinitions(
  input: BuildWikiScopedToolsInput,
): ToolDefinition<any, any>[] {
  const runWorkDir = path.resolve(input.runWorkDir);
  const opsOpts: WikiToolOperationsOptions = {
    runWorkDir,
    sourceIgnores: input.sourceIgnores,
  };

  const defs: ToolDefinition<any, any>[] = [
    createReadToolDefinition(runWorkDir, {
      operations: createWikiReadOperations(opsOpts),
    }),
    createLsToolDefinition(runWorkDir, {
      operations: createWikiLsOperations(opsOpts),
    }),
    createGrepToolDefinition(runWorkDir, {
      operations: createWikiGrepOperations(opsOpts),
    }),
    // Stock find (no custom Operations) — still constrained by cwd + tool allowlist.
    createFindToolDefinition(runWorkDir),
  ];

  if (input.mayWrite) {
    defs.push(
      createWriteToolDefinition(runWorkDir, {
        operations: createWikiWriteOperations(opsOpts),
      }),
      createEditToolDefinition(runWorkDir, {
        operations: createWikiEditOperations(opsOpts),
      }),
    );
  }

  return defs;
}
