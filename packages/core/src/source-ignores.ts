/**
 * Host-owned Default Source Ignores and effective ignore expansion.
 * Patterns are repository-relative POSIX globs (product contract, not OS paths).
 *
 * Semantics (ADR 0015):
 * - Defaults apply when applyDefaultIgnores is true (product default).
 * - User ignore is always additive; a non-empty list never turns defaults off.
 * - No `!` re-include / gitignore import.
 * - Tests are NOT excluded by default; operators add them via ignore or presets.
 */

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
 */
export function pathMatchesIgnore(relativePath: string, patterns: readonly string[]): boolean {
  const path = normalizeRepoRelative(relativePath);
  if (!path) {
    return false;
  }
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (matchGlob(path, pattern)) {
      return true;
    }
  }
  return false;
}

/** True when a list_source entry name under `parentRel` should be hidden. */
export function entryMatchesIgnore(
  parentRel: string,
  entryName: string,
  isDirectory: boolean,
  patterns: readonly string[],
): boolean {
  const parent = normalizeRepoRelative(parentRel);
  const base = parent ? `${parent}/${entryName}` : entryName;
  const candidates = isDirectory ? [base, `${base}/`] : [base];
  for (const candidate of candidates) {
    if (pathMatchesIgnore(candidate, patterns)) {
      return true;
    }
  }
  return false;
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
 * Minimal glob matcher for repository-relative paths.
 * `**` matches across `/`; `*` does not match `/`; `?` is one non-slash char.
 */
function matchGlob(path: string, pattern: string): boolean {
  const normalizedPattern = normalizeRepoRelative(pattern);
  // Directory-only pattern "foo/**" also matches the directory "foo".
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  const re = globToRegExp(normalizedPattern);
  return re.test(path);
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      // ** or **/
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if ("+^$()[]{}|.\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

/** Convenience: effective ignores for a full WorkspaceSource. */
export function effectiveIgnoresForSource(source: WorkspaceSource): string[] {
  return effectiveSourceIgnores(source);
}
