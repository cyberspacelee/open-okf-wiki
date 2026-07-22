/**
 * Source Citation parse + mechanical placement/format checks (ADR 0028).
 *
 * Producer form (under page section `# Citations` only):
 *   single repo:  [label](repo:path/to/file.py#L10-L20)
 *   multi repo:   [label](repo:repository-id/path/to/file.py#L10-L20)
 *
 * Snapshot path/line resolve remains available as an optional soft helper
 * ({@link validateCitationResolve}); the Run Boundary hard gate does not use it.
 */

import { lstat, open } from "node:fs/promises";
import path from "node:path";

/** One parsed Source Citation. */
export type SourceCitation = {
  /** Full match text, e.g. `[Source](repo:foo.ts#L1-L2)`. */
  raw: string;
  /** Path after `repo:` (may include repository-id/ prefix). */
  target: string;
  /** One-based inclusive start line when present. */
  lineStart?: number;
  /** One-based inclusive end line when present. */
  lineEnd?: number;
  /** Character offset in the page body. */
  index: number;
};

/**
 * Match Markdown links whose target is a `repo:` URI.
 * Line range is optional; when present must be #Lstart or #Lstart-Lend.
 * Label is unrestricted (Skill often uses `Source`; OKF lists use short labels).
 */
export const SOURCE_CITATION_RE =
  /\[[^\]]*\]\(repo:([^)\s#]+)(?:#L(\d+)(?:-L(\d+))?)?\)/g;

/**
 * Parse all Source Citations from Markdown page content.
 */
export function parseSourceCitations(content: string): SourceCitation[] {
  const out: SourceCitation[] = [];
  const re = new RegExp(SOURCE_CITATION_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const target = match[1]!.trim();
    if (!target) {
      continue;
    }
    const lineStart = match[2] ? Number(match[2]) : undefined;
    const lineEnd = match[3] ? Number(match[3]) : undefined;
    out.push({
      raw: match[0],
      target,
      ...(lineStart !== undefined && Number.isFinite(lineStart)
        ? { lineStart }
        : {}),
      ...(lineEnd !== undefined && Number.isFinite(lineEnd) ? { lineEnd } : {}),
      index: match.index,
    });
  }
  return out;
}

/**
 * Locate the `# Citations` section body range (content after the heading line
 * until the next ATX H1 or EOF). Returns null when the heading is absent.
 */
export function findCitationsSectionRange(
  content: string,
): { start: number; end: number } | null {
  const heading = /^# Citations[ \t]*$/m.exec(content);
  if (!heading || heading.index === undefined) {
    return null;
  }
  const afterHeadingLine = heading.index + heading[0].length;
  // Skip the newline after the heading when present.
  let start = afterHeadingLine;
  if (content[start] === "\r") {
    start += 1;
  }
  if (content[start] === "\n") {
    start += 1;
  }
  const rest = content.slice(start);
  const nextH1 = /^# /m.exec(rest);
  const end = nextH1 && nextH1.index !== undefined ? start + nextH1.index : content.length;
  return { start, end };
}

/**
 * Format-only validation (no filesystem). Returns error strings.
 */
export function validateCitationFormat(
  citations: SourceCitation[],
  pageLabel: string,
): string[] {
  const errors: string[] = [];
  for (const c of citations) {
    if (c.target.includes("..") || c.target.startsWith("/")) {
      errors.push(
        `${pageLabel}: citation path must be repository-relative POSIX (got ${c.target})`,
      );
    }
    if (c.lineStart !== undefined && c.lineStart < 1) {
      errors.push(`${pageLabel}: citation line start must be ≥ 1 (${c.raw})`);
    }
    if (
      c.lineStart !== undefined &&
      c.lineEnd !== undefined &&
      c.lineEnd < c.lineStart
    ) {
      errors.push(
        `${pageLabel}: citation line end before start (${c.raw})`,
      );
    }
  }
  return errors;
}

/**
 * Hard-gate placement: every `repo:` citation must sit under `# Citations`.
 * Pages with no `repo:` links need not include the section.
 */
export function validateCitationPlacement(
  citations: SourceCitation[],
  content: string,
  pageLabel: string,
): string[] {
  if (citations.length === 0) {
    return [];
  }
  const range = findCitationsSectionRange(content);
  if (!range) {
    return [
      `${pageLabel}: repo: citations require a # Citations section (inline placement not allowed)`,
    ];
  }
  const errors: string[] = [];
  for (const c of citations) {
    const citeStart = c.index;
    const citeEnd = c.index + c.raw.length;
    if (citeStart < range.start || citeEnd > range.end) {
      errors.push(
        `${pageLabel}: citation must be under # Citations (inline placement not allowed): ${c.raw}`,
      );
    }
  }
  return errors;
}

export type SourceRootMap = {
  /**
   * sourceId → absolute checkout path.
   * Empty map = format-only checks.
   */
  roots: Map<string, string>;
  /**
   * When the Snapshot Set has exactly one source, bare `repo:path` resolves
   * against this root without requiring a repository-id prefix.
   */
  singleRoot?: { id: string; path: string };
};

/**
 * Resolve citation target to absolute file path under a pinned source root.
 * Returns null when the map is empty (caller should skip resolve).
 */
export function resolveCitationFile(
  citation: SourceCitation,
  sources: SourceRootMap,
): { absPath: string; sourceId: string; relPath: string } | { error: string } | null {
  if (sources.roots.size === 0 && !sources.singleRoot) {
    return null;
  }

  const target = citation.target.replace(/\\/g, "/");
  const segments = target.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { error: `empty citation path: ${citation.raw}` };
  }

  // Prefer explicit source id prefix when it matches a registered root.
  if (segments.length >= 2 && sources.roots.has(segments[0]!)) {
    const sourceId = segments[0]!;
    const relPath = segments.slice(1).join("/");
    const root = sources.roots.get(sourceId)!;
    return {
      absPath: path.resolve(root, relPath),
      sourceId,
      relPath,
    };
  }

  if (sources.singleRoot) {
    return {
      absPath: path.resolve(sources.singleRoot.path, target),
      sourceId: sources.singleRoot.id,
      relPath: target,
    };
  }

  // Multi-source without matching id prefix.
  if (sources.roots.size > 1) {
    return {
      error: `multi-source citation must start with a source id: ${citation.raw}`,
    };
  }

  // Single entry in map but singleRoot not set — use the only root.
  if (sources.roots.size === 1) {
    const [sourceId, root] = [...sources.roots.entries()][0]!;
    return {
      absPath: path.resolve(root, target),
      sourceId,
      relPath: target,
    };
  }

  return { error: `cannot resolve citation (no sources): ${citation.raw}` };
}

async function countFileLines(absPath: string): Promise<number> {
  const fh = await open(absPath, "r");
  try {
    let lines = 0;
    let partial = false;
    for await (const chunk of fh.createReadStream({ encoding: "utf8" })) {
      const s = String(chunk);
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "\n") {
          lines += 1;
          partial = false;
        } else {
          partial = true;
        }
      }
    }
    if (partial) {
      lines += 1;
    }
    return lines;
  } finally {
    await fh.close();
  }
}

/**
 * Optional soft helper: resolve citations against pinned source roots
 * (file exists + line range in bounds). Not used by the Run Boundary hard gate.
 */
export async function validateCitationResolve(
  citations: SourceCitation[],
  pageLabel: string,
  sources: SourceRootMap,
): Promise<string[]> {
  if (sources.roots.size === 0 && !sources.singleRoot) {
    return [];
  }
  const errors: string[] = [];
  for (const c of citations) {
    const resolved = resolveCitationFile(c, sources);
    if (resolved === null) {
      continue;
    }
    if ("error" in resolved) {
      errors.push(`${pageLabel}: ${resolved.error}`);
      continue;
    }
    // Containment: resolved path must stay under the source root.
    const root = sources.roots.get(resolved.sourceId) ?? sources.singleRoot?.path;
    if (!root) {
      errors.push(`${pageLabel}: unknown source for ${c.raw}`);
      continue;
    }
    const rootResolved = path.resolve(root);
    if (
      resolved.absPath !== rootResolved &&
      !resolved.absPath.startsWith(rootResolved + path.sep)
    ) {
      errors.push(
        `${pageLabel}: citation escapes source root (${c.raw})`,
      );
      continue;
    }
    try {
      const st = await lstat(resolved.absPath);
      if (st.isSymbolicLink()) {
        errors.push(
          `${pageLabel}: citation target is a symlink (${c.raw})`,
        );
        continue;
      }
      if (!st.isFile()) {
        errors.push(
          `${pageLabel}: citation target is not a file (${c.raw})`,
        );
        continue;
      }
    } catch {
      errors.push(
        `${pageLabel}: citation target not found in Snapshot (${c.raw})`,
      );
      continue;
    }
    if (c.lineStart !== undefined) {
      try {
        const lineCount = await countFileLines(resolved.absPath);
        const end = c.lineEnd ?? c.lineStart;
        if (c.lineStart > lineCount || end > lineCount) {
          errors.push(
            `${pageLabel}: citation line range out of bounds (${c.raw}; file has ${lineCount} lines)`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(
          `${pageLabel}: cannot read citation target (${c.raw}): ${message}`,
        );
      }
    }
  }
  return errors;
}

/**
 * Build SourceRootMap from workspace-like source list.
 */
export function sourceRootMapFromSources(
  sources: Array<{ id: string; path: string }>,
): SourceRootMap {
  const roots = new Map<string, string>();
  for (const s of sources) {
    roots.set(s.id, path.resolve(s.path));
  }
  if (sources.length === 1) {
    return {
      roots,
      singleRoot: {
        id: sources[0]!.id,
        path: path.resolve(sources[0]!.path),
      },
    };
  }
  return { roots };
}
