import { createTool } from "@mastra/core/tools";
import {
  entryMatchesIgnore,
  pathMatchesIgnore,
} from "@okf-wiki/core";
import { z } from "zod";
import {
  listDirContained,
  readFileContained,
  writeFileContained,
} from "./fs-ops.js";
import { WikiRunSpecSchema } from "@okf-wiki/contract";
import { readWikiRunSpec, writeWikiRunSpec } from "./spec-store.js";

export type WikiRunToolRoots = {
  /** source id → absolute path */
  sources: Map<string, string>;
  /**
   * source id → effective ignore globs (defaults + user), frozen at Wiki Run start.
   * Host-enforced on every list_source / read_source during generation.
   */
  sourceIgnores: Map<string, readonly string[]>;
  skillRoot: string;
  wikiRoot: string;
  /**
   * When set with runId, Root gets read_spec / write_spec via spec-store
   * (living WikiRunSpec under analysis scratch).
   */
  workspaceRoot?: string;
  runId?: string;
};

/** Default max lines returned by read_source when limit is omitted. */
export const READ_SOURCE_DEFAULT_LIMIT = 500;
/** Hard cap on glob_source results. */
export const GLOB_SOURCE_MAX_RESULTS = 200;
/** Hard cap on search_source matches. */
export const SEARCH_SOURCE_MAX_MATCHES = 50;
/** Max files scanned by search_source before stopping. */
export const SEARCH_SOURCE_MAX_FILES = 2_000;

function resolveSourceRoot(
  sources: Map<string, string>,
  sourceId: string | undefined,
): { id: string; root: string } {
  if (sources.size === 0) {
    throw new Error("no sources configured");
  }
  if (sourceId && sourceId.trim()) {
    const root = sources.get(sourceId.trim());
    if (!root) {
      throw new Error(
        `unknown source id "${sourceId}"; known: ${[...sources.keys()].join(", ")}`,
      );
    }
    return { id: sourceId.trim(), root };
  }
  if (sources.size === 1) {
    const [id, root] = [...sources.entries()][0]!;
    return { id, root };
  }
  throw new Error(
    `sourceId is required when multiple sources are configured (${[...sources.keys()].join(", ")})`,
  );
}

function ignoresFor(
  roots: WikiRunToolRoots,
  sourceId: string,
): readonly string[] {
  // Missing map entry → empty (caller should always populate via buildSourceIgnoreMap).
  return roots.sourceIgnores.get(sourceId) ?? [];
}

/** Normalize tool-relative paths before ignore matching. */
function normalizeToolPath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Split file content into lines (keeps trailing empty line semantics like lineCount). */
export function splitFileLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  // Trailing newline produces a final empty segment that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Format a 1-based inclusive line window with OpenCode-style prefixes.
 * Prefixes are metadata for the model — not part of the source file.
 */
export function formatNumberedLines(
  lines: string[],
  startLine: number,
): string {
  return lines
    .map((line, i) => `${startLine + i}| ${line}`)
    .join("\n");
}

/** Simple glob → RegExp (`*`, `**`, `?`). Anchored full-path match. */
export function globPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\/+/, "");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === "*" && normalized[i + 1] === "*") {
      // ** or **/
      if (normalized[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if ("+.^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

async function walkSourceFiles(
  root: string,
  baseRel: string,
  patterns: readonly string[],
  onFile: (relPath: string) => void | Promise<void>,
  options?: { maxFiles?: number },
): Promise<{ truncated: boolean; filesVisited: number }> {
  const maxFiles = options?.maxFiles ?? Number.POSITIVE_INFINITY;
  let filesVisited = 0;
  let truncated = false;

  async function walk(rel: string): Promise<void> {
    if (truncated) {
      return;
    }
    if (rel && pathMatchesIgnore(rel, patterns)) {
      return;
    }
    let entries;
    try {
      entries = await listDirContained(root, rel);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      if (!entryMatchesIgnore(rel, entry.name, entry.type === "directory", patterns)) {
        if (entry.type === "directory") {
          await walk(entry.path);
        } else if (entry.type === "file") {
          filesVisited += 1;
          if (filesVisited > maxFiles) {
            truncated = true;
            return;
          }
          await onFile(entry.path);
        }
      }
    }
  }

  await walk(baseRel);
  return { truncated, filesVisited };
}

/**
 * Path-policy tools for a Wiki Run: source/skill read-only, wiki staging write.
 * Source tools honor Effective Source Ignores (defaults + user patterns) so
 * ignored paths are never listed or readable during wiki generation.
 */
export function createWikiRunTools(roots: WikiRunToolRoots) {
  const list_source = createTool({
    id: "list_source",
    description:
      "List files/directories under a source repository. Paths are relative to the source root. " +
      "When multiple sources exist, pass sourceId. " +
      "Entries matching Effective Source Ignores (workspace defaults + per-source ignore rules) are omitted by the host — do not try to re-list them. " +
      "Prefer glob_source for recursive name patterns and search_source for content search.",
    inputSchema: z.object({
      path: z.string().default("").describe("Relative directory path under the source"),
      sourceId: z.string().optional().describe("Source id when multiple sources are configured"),
    }),
    execute: async (input) => {
      const { id, root } = resolveSourceRoot(roots.sources, input.sourceId);
      const rel = normalizeToolPath(input.path ?? "");
      const patterns = ignoresFor(roots, id);
      // Refuse listing under an ignored path (empty result, not a leak).
      if (rel && pathMatchesIgnore(rel, patterns)) {
        return { sourceId: id, entries: [], ignored: true as const };
      }
      const entries = await listDirContained(root, rel);
      const filtered = entries.filter((entry) => {
        const isDir = entry.type === "directory";
        return !entryMatchesIgnore(rel, entry.name, isDir, patterns);
      });
      return { sourceId: id, entries: filtered };
    },
  });

  const read_source = createTool({
    id: "read_source",
    description:
      "Read a text file from a source repository with 1-based line numbers. " +
      "Each content line is prefixed as `N| text` (metadata only — do not copy prefixes into wiki). " +
      "Returns lineCount for citation bounds. Use offset/limit for large files. " +
      "Source Citations must use one-based inclusive ranges within lineCount " +
      "(e.g. [Source](repo:path#L10-L20)). Paths matching Effective Source Ignores are rejected.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Relative file path under the source"),
      sourceId: z
        .string()
        .optional()
        .describe("Source id when multiple sources are configured"),
      offset: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based start line (default 1)"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Max lines to return (default ${READ_SOURCE_DEFAULT_LIMIT})`,
        ),
    }),
    execute: async (input) => {
      const { id, root } = resolveSourceRoot(roots.sources, input.sourceId);
      const rel = normalizeToolPath(input.path);
      const patterns = ignoresFor(roots, id);
      if (pathMatchesIgnore(rel, patterns)) {
        throw new Error(
          `path is excluded by Effective Source Ignores (workspace ignore rules): ${rel}`,
        );
      }
      const file = await readFileContained(root, rel);
      const allLines = splitFileLines(file.content);
      const lineCount = allLines.length;
      const startLine = input.offset && input.offset > 0 ? input.offset : 1;
      const limit = input.limit && input.limit > 0
        ? input.limit
        : READ_SOURCE_DEFAULT_LIMIT;
      if (startLine > lineCount && lineCount > 0) {
        return {
          sourceId: id,
          path: file.path,
          lineCount,
          startLine,
          endLine: startLine - 1,
          content: "",
          truncated: true as const,
        };
      }
      const sliceStart = Math.max(0, startLine - 1);
      const slice = allLines.slice(sliceStart, sliceStart + limit);
      const endLine =
        slice.length === 0 ? startLine - 1 : startLine + slice.length - 1;
      const truncated = endLine < lineCount || sliceStart > 0;
      return {
        sourceId: id,
        path: file.path,
        lineCount,
        startLine: slice.length === 0 ? startLine : startLine,
        endLine,
        content: formatNumberedLines(slice, startLine),
        truncated,
      };
    },
  });

  const glob_source = createTool({
    id: "glob_source",
    description:
      "Find files under a source repository by glob pattern (e.g. **/*Listener.java, **/compose.yaml). " +
      "Respects Effective Source Ignores. Returns repository-relative paths. " +
      "Prefer this over recursive list_source for name-based discovery.",
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .describe('Glob pattern relative to source root, e.g. "**/*.java"'),
      path: z
        .string()
        .optional()
        .describe("Optional subdirectory to search under (default: source root)"),
      sourceId: z
        .string()
        .optional()
        .describe("Source id when multiple sources are configured"),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Max paths to return (default/cap ${GLOB_SOURCE_MAX_RESULTS})`),
    }),
    execute: async (input) => {
      const { id, root } = resolveSourceRoot(roots.sources, input.sourceId);
      const baseRel = normalizeToolPath(input.path ?? "");
      const patterns = ignoresFor(roots, id);
      if (baseRel && pathMatchesIgnore(baseRel, patterns)) {
        return { sourceId: id, paths: [] as string[], truncated: false };
      }
      const maxResults = Math.min(
        input.maxResults ?? GLOB_SOURCE_MAX_RESULTS,
        GLOB_SOURCE_MAX_RESULTS,
      );
      const matcher = globPatternToRegExp(input.pattern.trim());
      const paths: string[] = [];
      let truncated = false;
      const walk = await walkSourceFiles(
        root,
        baseRel,
        patterns,
        (relPath) => {
          // Match against path relative to search base when base is set,
          // and also full repo-relative path for patterns like **/*.java
          const candidates = baseRel
            ? [relPath, relPath.startsWith(baseRel + "/")
                ? relPath.slice(baseRel.length + 1)
                : relPath]
            : [relPath];
          if (candidates.some((c) => matcher.test(c))) {
            if (paths.length >= maxResults) {
              truncated = true;
              return;
            }
            paths.push(relPath);
          }
        },
        { maxFiles: 50_000 },
      );
      if (walk.truncated) {
        truncated = true;
      }
      paths.sort((a, b) => a.localeCompare(b));
      return { sourceId: id, paths, truncated };
    },
  });

  const search_source = createTool({
    id: "search_source",
    description:
      "Search file contents under a source repository with a regular expression. " +
      "Returns path, 1-based line, and matching line text (Host-owned; not shell). " +
      "Respects Effective Source Ignores. Use line numbers for Source Citations. " +
      "Prefer glob filter for language/extension scoping.",
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .describe("JavaScript regular expression source (not shell rg)"),
      path: z
        .string()
        .optional()
        .describe("Optional subdirectory or file under the source"),
      glob: z
        .string()
        .optional()
        .describe('Optional file-name glob filter, e.g. "*.java" or "**/*Listener.java"'),
      sourceId: z
        .string()
        .optional()
        .describe("Source id when multiple sources are configured"),
      maxMatches: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Max matches (default/cap ${SEARCH_SOURCE_MAX_MATCHES})`),
      caseInsensitive: z
        .boolean()
        .optional()
        .describe("Case-insensitive match (default false)"),
    }),
    execute: async (input) => {
      const { id, root } = resolveSourceRoot(roots.sources, input.sourceId);
      const baseRel = normalizeToolPath(input.path ?? "");
      const patterns = ignoresFor(roots, id);
      if (baseRel && pathMatchesIgnore(baseRel, patterns)) {
        return {
          sourceId: id,
          matches: [] as Array<{ path: string; line: number; text: string }>,
          truncated: false,
        };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(
          input.pattern,
          input.caseInsensitive ? "i" : "",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid search pattern: ${message}`);
      }
      const maxMatches = Math.min(
        input.maxMatches ?? SEARCH_SOURCE_MAX_MATCHES,
        SEARCH_SOURCE_MAX_MATCHES,
      );
      const fileGlob = input.glob?.trim()
        ? globPatternToRegExp(input.glob.trim())
        : null;
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let truncated = false;

      // Single-file search when path points at a file.
      if (baseRel && !baseRel.endsWith("/")) {
        try {
          if (!pathMatchesIgnore(baseRel, patterns)) {
            const file = await readFileContained(root, baseRel);
            const lines = splitFileLines(file.content);
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i]!)) {
                matches.push({
                  path: file.path,
                  line: i + 1,
                  text: lines[i]!.slice(0, 500),
                });
                if (matches.length >= maxMatches) {
                  truncated = true;
                  break;
                }
              }
              // Reset lastIndex for global-less patterns is fine; for safety:
              regex.lastIndex = 0;
            }
          }
          return { sourceId: id, matches, truncated };
        } catch {
          // Fall through to directory walk if not a file.
        }
      }

      const walk = await walkSourceFiles(
        root,
        baseRel,
        patterns,
        async (relPath) => {
          if (truncated) {
            return;
          }
          if (fileGlob && !fileGlob.test(relPath)) {
            return;
          }
          let content: string;
          try {
            const file = await readFileContained(root, relPath);
            content = file.content;
          } catch {
            return;
          }
          const lines = splitFileLines(content);
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              matches.push({
                path: relPath,
                line: i + 1,
                text: lines[i]!.slice(0, 500),
              });
              if (matches.length >= maxMatches) {
                truncated = true;
                return;
              }
            }
            regex.lastIndex = 0;
          }
        },
        { maxFiles: SEARCH_SOURCE_MAX_FILES },
      );
      if (walk.truncated) {
        truncated = true;
      }
      return { sourceId: id, matches, truncated };
    },
  });

  const list_skill = createTool({
    id: "list_skill",
    description: "List files under the producer skill directory (read-only).",
    inputSchema: z.object({
      path: z.string().default("").describe("Relative directory path under the skill root"),
    }),
    execute: async (input) => {
      const entries = await listDirContained(roots.skillRoot, input.path ?? "");
      return { entries };
    },
  });

  const read_skill = createTool({
    id: "read_skill",
    description:
      "Read a skill file (e.g. SKILL.md, templates/*.md, references/*.md). Start with SKILL.md.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Relative file path under the skill root"),
    }),
    execute: async (input) => {
      return readFileContained(roots.skillRoot, input.path);
    },
  });

  const list_wiki = createTool({
    id: "list_wiki",
    description: "List files under the staged Wiki directory for this run.",
    inputSchema: z.object({
      path: z.string().default("").describe("Relative directory path under the wiki staging root"),
    }),
    execute: async (input) => {
      const entries = await listDirContained(roots.wikiRoot, input.path ?? "");
      return { entries };
    },
  });

  const read_wiki = createTool({
    id: "read_wiki",
    description: "Read a staged Wiki markdown page.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Relative file path under the wiki staging root"),
    }),
    execute: async (input) => {
      return readFileContained(roots.wikiRoot, input.path);
    },
  });

  const write_wiki = createTool({
    id: "write_wiki",
    description:
      "Write a markdown page into the staged Wiki. Begin pages with YAML frontmatter including title. " +
      "Use relative .md paths (e.g. overview.md, architecture.md). " +
      "Include Source Citations with line ranges from read_source/search_source (never invent line numbers).",
    inputSchema: z.object({
      path: z.string().min(1).describe("Relative .md path under the wiki staging root"),
      content: z.string().min(1).describe("Full markdown page content"),
    }),
    execute: async (input) => {
      return writeFileContained(roots.wikiRoot, input.path, input.content);
    },
  });

  const workspaceRoot = roots.workspaceRoot?.trim();
  const runId = roots.runId?.trim();
  const specEnabled = Boolean(workspaceRoot && runId);

  const read_spec = createTool({
    id: "read_spec",
    description:
      "Read the living WikiRunSpec (JSON) for this run: domains, pages, questions, acceptance, changelog. " +
      "Call when replanning or checking intended page set.",
    inputSchema: z.object({}),
    execute: async () => {
      if (!workspaceRoot || !runId) {
        return { ok: false as const, error: "analysis scratch not configured" };
      }
      const spec = await readWikiRunSpec(workspaceRoot, runId);
      if (!spec) {
        return { ok: false as const, error: "spec.json not found or invalid" };
      }
      return { ok: true as const, spec };
    },
  });

  const write_spec = createTool({
    id: "write_spec",
    description:
      "Write/update the living WikiRunSpec for this run. Use when discovery changes domains or pages. " +
      "Always include version:1, summary, audience, domains, pages (with purpose/questions), acceptance, changelog.",
    inputSchema: z.object({
      spec: z.unknown().describe("Full WikiRunSpec JSON object"),
      changelogEntry: z
        .string()
        .optional()
        .describe("Optional short replan note appended to changelog"),
    }),
    execute: async (input) => {
      if (!workspaceRoot || !runId) {
        throw new Error("analysis scratch not configured");
      }
      const base = WikiRunSpecSchema.parse(input.spec);
      const entry = input.changelogEntry?.trim();
      const spec = WikiRunSpecSchema.parse({
        ...base,
        changelog: entry
          ? [...(base.changelog ?? []), entry.slice(0, 500)].slice(-40)
          : base.changelog,
      });
      await writeWikiRunSpec(workspaceRoot, runId, spec);
      return { ok: true as const, path: "spec.json", pageCount: spec.pages.length };
    },
  });

  return {
    list_source,
    read_source,
    glob_source,
    search_source,
    list_skill,
    read_skill,
    list_wiki,
    read_wiki,
    write_wiki,
    ...(specEnabled ? { read_spec, write_spec } : {}),
  };
}

export type WikiRunTools = ReturnType<typeof createWikiRunTools>;
