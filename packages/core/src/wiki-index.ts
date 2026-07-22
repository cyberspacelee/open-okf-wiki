/**
 * Deterministic full-tree `index.md` generation (ADR 0028).
 * Run Boundary overwrites indexes before concept hard gates.
 */

import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAbsolutePath } from "./paths.js";
import {
  isReservedWikiBasename,
  parseOkfConceptFrontmatter,
} from "./validate-wiki.js";

export type GenerateWikiIndexesInput = {
  wikiRoot: string;
  /** Root index H1 (WorkspaceConfig.name). */
  workspaceName: string;
};

export type GenerateWikiIndexesResult = {
  /** POSIX-relative paths of index.md files written. */
  written: string[];
  /** POSIX-relative paths of stray index.md removed from non-indexable dirs. */
  removed: string[];
};

type ConceptEntry = {
  basename: string;
  title: string;
  description: string;
};

type DirNode = {
  /** POSIX rel from wiki root; "" for root. */
  rel: string;
  concepts: ConceptEntry[];
  /** Child directory basenames (non-dot). */
  childDirs: string[];
};

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function compareTitleThenBasename(a: ConceptEntry, b: ConceptEntry): number {
  const t = a.title.localeCompare(b.title, "en");
  if (t !== 0) {
    return t;
  }
  return a.basename.localeCompare(b.basename, "en");
}

/**
 * Walk wiki tree (no symlink follow). Build directory → concept/child map.
 */
async function scanWikiTree(wikiRoot: string): Promise<{
  dirs: Map<string, DirNode>;
  /** All directory rel paths that contain a stray or existing index.md. */
  existingIndexes: string[];
}> {
  const dirs = new Map<string, DirNode>();
  const existingIndexes: string[] = [];

  function ensureDir(rel: string): DirNode {
    const key = toPosix(rel);
    let node = dirs.get(key);
    if (!node) {
      node = { rel: key, concepts: [], childDirs: [] };
      dirs.set(key, node);
    }
    return node;
  }

  // Always have root node.
  ensureDir("");

  async function walk(absDir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const node = ensureDir(rel);

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absPath = path.join(absDir, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;

      let info;
      try {
        info = await lstat(absPath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        continue;
      }

      if (info.isDirectory()) {
        node.childDirs.push(entry.name);
        await walk(absPath, childRel);
        continue;
      }

      if (!info.isFile()) {
        continue;
      }

      if (entry.name.toLowerCase() === "index.md") {
        existingIndexes.push(toPosix(childRel));
        continue;
      }

      if (isReservedWikiBasename(entry.name)) {
        // log.md etc. — not concepts
        continue;
      }

      if (!entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(absPath, "utf8");
      } catch {
        continue;
      }

      const fm = parseOkfConceptFrontmatter(content);
      const title = fm.ok
        ? fm.fields.title
        : entry.name.replace(/\.md$/i, "");
      const description = fm.ok ? fm.fields.description : "";
      node.concepts.push({
        basename: entry.name,
        title,
        description,
      });
    }

    node.childDirs.sort((a, b) => a.localeCompare(b, "en"));
  }

  await walk(wikiRoot, "");
  return { dirs, existingIndexes };
}

/**
 * Directory is indexable if it has ≥1 concept or ≥1 indexable child.
 */
function computeIndexable(dirs: Map<string, DirNode>): Set<string> {
  const memo = new Map<string, boolean>();

  function isIndexable(rel: string): boolean {
    if (memo.has(rel)) {
      return memo.get(rel)!;
    }
    const node = dirs.get(rel);
    if (!node) {
      memo.set(rel, false);
      return false;
    }
    if (node.concepts.length > 0) {
      memo.set(rel, true);
      return true;
    }
    for (const child of node.childDirs) {
      const childRel = rel ? `${rel}/${child}` : child;
      if (isIndexable(childRel)) {
        memo.set(rel, true);
        return true;
      }
    }
    memo.set(rel, false);
    return false;
  }

  const out = new Set<string>();
  for (const rel of dirs.keys()) {
    if (isIndexable(rel)) {
      out.add(rel);
    }
  }
  return out;
}

function renderIndex(
  node: DirNode,
  workspaceName: string,
  indexable: Set<string>,
): string {
  const isRoot = node.rel === "";
  const h1 = isRoot ? workspaceName : path.posix.basename(node.rel);
  const lines: string[] = [`# ${h1}`, ""];

  const concepts = [...node.concepts];
  if (isRoot) {
    const overviewIdx = concepts.findIndex(
      (c) => c.basename.toLowerCase() === "overview.md",
    );
    let overview: ConceptEntry | undefined;
    if (overviewIdx >= 0) {
      overview = concepts.splice(overviewIdx, 1)[0];
    }
    concepts.sort(compareTitleThenBasename);
    if (overview) {
      concepts.unshift(overview);
    }
  } else {
    concepts.sort(compareTitleThenBasename);
  }

  if (concepts.length > 0) {
    lines.push("## Files", "");
    for (const c of concepts) {
      lines.push(`- [${c.title}](${c.basename}) - ${c.description}`);
    }
    lines.push("");
  }

  const dirs = node.childDirs.filter((name) => {
    const childRel = node.rel ? `${node.rel}/${name}` : name;
    return indexable.has(childRel);
  });
  if (dirs.length > 0) {
    lines.push("## Directories", "");
    for (const name of dirs) {
      lines.push(`- [${name}](${name}/)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Full-tree overwrite of deterministic `index.md` files.
 * Empty leaves get no index (stray indexes removed).
 */
export async function generateWikiIndexes(
  input: GenerateWikiIndexesInput,
): Promise<GenerateWikiIndexesResult> {
  const wikiRoot = path.resolve(
    assertAbsolutePath(input.wikiRoot, "wikiRoot"),
  );
  const workspaceName = input.workspaceName.trim();
  if (!workspaceName) {
    throw new Error("workspaceName must be a non-empty string");
  }

  const { dirs, existingIndexes } = await scanWikiTree(wikiRoot);
  const indexable = computeIndexable(dirs);

  const written: string[] = [];
  const removed: string[] = [];

  // Remove indexes from non-indexable directories.
  for (const indexRel of existingIndexes) {
    const dirRel = path.posix.dirname(indexRel);
    const dirKey = dirRel === "." ? "" : dirRel;
    if (!indexable.has(dirKey)) {
      await rm(path.join(wikiRoot, indexRel), { force: true });
      removed.push(indexRel);
    }
  }

  for (const rel of indexable) {
    const node = dirs.get(rel)!;
    const body = renderIndex(node, workspaceName, indexable);
    const indexRel = rel ? `${rel}/index.md` : "index.md";
    const abs = path.join(wikiRoot, indexRel);
    await writeFile(abs, body, "utf8");
    written.push(indexRel);
  }

  written.sort((a, b) => a.localeCompare(b, "en"));
  removed.sort((a, b) => a.localeCompare(b, "en"));
  return { written, removed };
}
