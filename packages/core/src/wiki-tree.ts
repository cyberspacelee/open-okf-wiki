import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export type WikiFrontmatter = {
  body: string;
  values: Readonly<Record<string, string>>;
};

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed.trim() : "";
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Parse the bounded frontmatter subset used by validation and Wiki browsing. */
export function parseWikiFrontmatter(content: string): WikiFrontmatter | null {
  const withoutBom = content.replace(/^\uFEFF/, "");
  const firstNewline = withoutBom.indexOf("\n");
  if (firstNewline < 0 || withoutBom.slice(0, firstNewline).trim() !== "---") {
    return null;
  }
  const rest = withoutBom.slice(firstNewline + 1);
  const closingOffset = rest.search(/^---\s*$/m);
  if (closingOffset < 0) {
    return null;
  }

  const body = rest.slice(0, closingOffset);
  const values: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = unquoteYamlScalar(match[2]!);
    if (value) values[match[1]!.toLowerCase()] = value;
  }
  return { body, values: Object.freeze(values) };
}

export type WikiTreeFile = {
  absolutePath: string;
  /** POSIX path relative to the scanned root. */
  relativePath: string;
  size: number;
};

export type WikiTreeIssue = {
  kind: "io" | "symlink" | "special";
  relativePath: string;
  message: string;
  code?: string;
};

export type WikiTreeScan = {
  files: WikiTreeFile[];
  issues: WikiTreeIssue[];
};

/** Stable depth-first scan that never follows symlinks. */
export async function scanWikiTree(root: string): Promise<WikiTreeScan> {
  const resolvedRoot = path.resolve(root);
  const files: WikiTreeFile[] = [];
  const issues: WikiTreeIssue[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      issues.push({
        kind: "io",
        relativePath: relativeDirectory || ".",
        message: `cannot read directory ${relativeDirectory || "."}: ${error instanceof Error ? error.message : String(error)}`,
        ...((error as NodeJS.ErrnoException | undefined)?.code
          ? { code: (error as NodeJS.ErrnoException).code }
          : {}),
      });
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        issues.push({
          kind: "io",
          relativePath,
          message: `cannot stat ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
          ...((error as NodeJS.ErrnoException | undefined)?.code
            ? { code: (error as NodeJS.ErrnoException).code }
            : {}),
        });
        continue;
      }

      if (info.isSymbolicLink()) {
        issues.push({
          kind: "symlink",
          relativePath,
          message: `symlink not allowed in wiki tree: ${relativePath}`,
        });
      } else if (info.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (info.isFile()) {
        files.push({ absolutePath, relativePath, size: info.size });
      } else {
        issues.push({
          kind: "special",
          relativePath,
          message: `non-regular entry not allowed in wiki tree: ${relativePath}`,
        });
      }
    }
  }

  await walk(resolvedRoot, "");
  return { files, issues };
}

/** Count Markdown files using the same no-follow traversal as all Wiki readers. */
export async function countMarkdownFiles(root: string): Promise<number> {
  const scan = await scanWikiTree(root);
  const missingRoot = scan.issues.some(
    (issue) => issue.kind === "io" && issue.relativePath === "." && issue.code === "ENOENT",
  );
  if (missingRoot) return 0;
  const ioIssue = scan.issues.find((issue) => issue.kind === "io");
  if (ioIssue) throw new Error(ioIssue.message);
  return scan.files.filter((file) => file.relativePath.toLowerCase().endsWith(".md")).length;
}

/** Reserved OKF listing/history filenames, not concept pages. */
export const RESERVED_WIKI_BASENAMES = new Set(["index.md", "log.md"]);

export function isReservedWikiPath(relativePath: string): boolean {
  const basename = relativePath.split("/").pop()?.toLowerCase() ?? "";
  return RESERVED_WIKI_BASENAMES.has(basename);
}
