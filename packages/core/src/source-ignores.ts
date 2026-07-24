/**
 * Host-owned Default Source Ignores and effective ignore expansion.
 * Patterns are repository-relative POSIX globs (product contract, not OS paths).
 *
 * Semantics (ADR 0015):
 * - Defaults apply when applyDefaultIgnores is true (product default).
 * - User ignore is always additive; a non-empty list never turns defaults off.
 * - No `!` re-include / gitignore import.
 * - Tests are NOT excluded by default; operators add them via ignore or presets.
 *
 * Matching is enforced by the Run Boundary on Pi read tools (`ls`, `find`,
 * `grep`, `read`) via Operations wrappers during Wiki generation (not prompt-only).
 *
 * Glob engine: Node `path.matchesGlob` (Node >=22, engines.node). Product semantics
 * layered on top when native matching alone is weaker:
 * - bare directory names match the whole tree (`node_modules` → `node_modules/foo`)
 * - trailing `/**` also matches the directory itself (native often needs a trailing `/`)
 * - path normalization (`\`, `./`, leading `/`, trailing `/`)
 */

import path from "node:path";
import {
  IGNORE_PRESETS as CONTRACT_IGNORE_PRESETS,
  type WorkspaceSource,
} from "@okf-wiki/contract";

/**
 * Product Default Source Ignores — dependency/build/cache noise.
 * Intentionally does not exclude test trees.
 */
export const DEFAULT_SOURCE_IGNORES: readonly string[] = Object.freeze([
  ".git/**",
  "node_modules/**",
  ".pnpm-store/**",
  "dist/**",
  "build/**",
  "out/**",
  "target/**",
  ".venv/**",
  "venv/**",
  "__pycache__/**",
  "*.pyc",
  ".mypy_cache/**",
  ".pytest_cache/**",
  ".tox/**",
  ".coverage/**",
  "coverage/**",
  ".nyc_output/**",
  ".idea/**",
  ".vscode/**",
  ".gradle/**",
  ".mvn/**",
  "*.class",
  "*.o",
  "*.so",
  "*.dylib",
  "*.dll",
  ".DS_Store",
  "Thumbs.db",
]);

/** Re-export contract presets as pattern lists for host matching helpers. */
export const IGNORE_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CONTRACT_IGNORE_PRESETS).map(([id, meta]) => [id, meta.patterns]),
  ),
);

export type IgnorePresetId = keyof typeof CONTRACT_IGNORE_PRESETS;

/** Expand defaults + user ignore for one source (frozen Effective Source Ignores). */
export function effectiveSourceIgnores(source: {
  applyDefaultIgnores?: boolean;
  ignore?: readonly string[];
}): string[] {
  const user = (source.ignore ?? []).map((p) => p.trim()).filter(Boolean);
  const applyDefaults = source.applyDefaultIgnores !== false;
  const base = applyDefaults ? [...DEFAULT_SOURCE_IGNORES] : [];
  // Preserve order: defaults first, then user; de-dupe.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of [...base, ...user]) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/**
 * Match a repository-relative POSIX path against product ignore globs.
 * Supports `*`, `?`, and `**` (including trailing `/**` directory forms).
 *
 * A path is ignored when:
 * - it matches a pattern directly, or
 * - any ancestor directory matches a directory pattern (dir or dir/**), or
 * - it sits under a directory matched by a trailing-/** pattern (e.g. java test trees).
 */
export function pathMatchesIgnore(relativePath: string, patterns: readonly string[]): boolean {
  const repoPath = normalizeRepoRelative(relativePath);
  if (!repoPath) {
    return false;
  }
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (matchIgnoreGlob(repoPath, pattern)) {
      return true;
    }
  }
  return false;
}

/** True when a directory listing entry under `parentRel` should be hidden. */
export function entryMatchesIgnore(
  parentRel: string,
  entryName: string,
  isDirectory: boolean,
  patterns: readonly string[],
): boolean {
  const parent = normalizeRepoRelative(parentRel);
  const base = parent ? `${parent}/${entryName}` : entryName;
  // Directories: hide when the dir itself or anything under it is covered.
  // Files: hide only when the file path matches.
  if (isDirectory) {
    return (
      pathMatchesIgnore(base, patterns) ||
      pathMatchesIgnore(`${base}/`, patterns) ||
      // Pattern may only name children (e.g. base/**); still hide the folder.
      patterns.some((p) => {
        const pattern = normalizeRepoRelative(p.trim());
        if (!pattern.endsWith("/**")) return false;
        const dirPat = pattern.slice(0, -3);
        return matchIgnoreGlob(base, dirPat) || matchIgnoreGlob(base, pattern);
      })
    );
  }
  return pathMatchesIgnore(base, patterns);
}

export function resolveIgnorePreset(id: string): string[] | null {
  const list = IGNORE_PRESETS[id];
  return list ? [...list] : null;
}

function normalizeRepoRelative(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Product ignore match for a normalized repository-relative path.
 * Uses Node `path.matchesGlob` for `*` / `?` / `**`; keeps bare-dir and
 * trailing-`/**` directory-tree semantics that native matching does not provide.
 */
function matchIgnoreGlob(repoPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRepoRelative(pattern);
  if (!normalizedPattern) {
    return false;
  }

  // Directory tree pattern: "foo/**" or "**/src/test/**"
  if (normalizedPattern.endsWith("/**")) {
    const dirPattern = normalizedPattern.slice(0, -3);
    // Exact directory (or glob-equivalent directory) matches.
    if (dirPattern && nativeGlobMatch(repoPath, dirPattern)) {
      return true;
    }
    // Path under a matching directory: any ancestor matches dirPattern.
    const parts = repoPath.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (dirPattern && nativeGlobMatch(ancestor, dirPattern)) {
        return true;
      }
    }
    // Full path against the original ** pattern (files deep under).
    if (nativeGlobMatch(repoPath, normalizedPattern)) {
      return true;
    }
    // Native quirk: "dir/**" often matches "dir/" but not bare "dir".
    if (nativeGlobMatch(`${repoPath}/`, normalizedPattern)) {
      return true;
    }
    return false;
  }

  // Bare directory name as pattern: treat as that tree (ADR-style noise dirs).
  // Only when pattern has no glob metacharacters and path is dir or under it.
  if (!hasGlobMeta(normalizedPattern)) {
    if (repoPath === normalizedPattern || repoPath.startsWith(`${normalizedPattern}/`)) {
      return true;
    }
  }

  return nativeGlobMatch(repoPath, normalizedPattern);
}

function hasGlobMeta(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/** Native glob match; returns false on invalid patterns rather than throwing. */
function nativeGlobMatch(repoPath: string, pattern: string): boolean {
  try {
    // Repository-relative paths are POSIX-style; prefer posix matcher when present.
    const matcher = path.posix.matchesGlob ?? path.matchesGlob;
    return matcher(repoPath, pattern);
  } catch {
    return false;
  }
}

/** Convenience: effective ignores for a full WorkspaceSource. */
export function effectiveIgnoresForSource(source: WorkspaceSource): string[] {
  return effectiveSourceIgnores(source);
}
