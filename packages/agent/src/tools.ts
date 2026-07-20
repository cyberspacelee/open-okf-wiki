import { createTool } from "@mastra/core/tools";
import {
  entryMatchesIgnore,
  pathMatchesIgnore,
} from "@okf-wiki/core";
import { z } from "zod";
import { listDirContained, readFileContained, writeFileContained } from "./fs-ops.js";

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
};

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
      "Entries matching Effective Source Ignores (workspace defaults + per-source ignore rules) are omitted by the host — do not try to re-list them.",
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
      "Read a text file from a source repository. Paths are relative to the source root. " +
      "Paths matching Effective Source Ignores are rejected by the host and cannot be read.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Relative file path under the source"),
      sourceId: z.string().optional().describe("Source id when multiple sources are configured"),
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
      return { sourceId: id, ...file };
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
      "Use relative .md paths (e.g. overview.md, architecture.md).",
    inputSchema: z.object({
      path: z.string().min(1).describe("Relative .md path under the wiki staging root"),
      content: z.string().min(1).describe("Full markdown page content"),
    }),
    execute: async (input) => {
      return writeFileContained(roots.wikiRoot, input.path, input.content);
    },
  });

  return {
    list_source,
    read_source,
    list_skill,
    read_skill,
    list_wiki,
    read_wiki,
    write_wiki,
  };
}

export type WikiRunTools = ReturnType<typeof createWikiRunTools>;
