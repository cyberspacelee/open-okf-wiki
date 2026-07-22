import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseSourceCitations,
  validateCitationFormat,
  validateCitationPlacement,
} from "./citations.js";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";

/** Soft caps for mechanical publication validation. */
export const WIKI_VALIDATE_MAX_FILES = 500;
export const WIKI_VALIDATE_MAX_FILE_BYTES = 1_000_000;

/** Reserved wiki basenames (not Concept pages). Case-insensitive. */
export const RESERVED_WIKI_BASENAMES = ["index.md", "log.md"] as const;

export type ValidateWikiOptions = {
  /**
   * @deprecated Snapshot sources are not used by the hard gate (ADR 0028).
   * Kept for call-site compatibility; ignored for validation.
   */
  sources?: Array<{ id: string; path: string }>;
  /**
   * @deprecated Citations are never required by the hard gate (ADR 0028).
   * Kept for call-site compatibility; ignored for validation.
   */
  requireCitations?: boolean;
};

export type ValidateWikiResult = {
  ok: boolean;
  errors: string[];
  /** Count of all `.md` files found when walk succeeded far enough. */
  pageCount?: number;
  /** Count of non-reserved concept `.md` pages. */
  conceptCount?: number;
  /** Total files walked (md + non-md), when available. */
  fileCount?: number;
  /** Total Source Citations found across concept pages. */
  citationCount?: number;
};

export type OkfConceptFrontmatter = {
  type: string;
  title: string;
  description: string;
  timestamp: string;
  /** Simple scalar / flow optional keys (unknown keys preserved as raw values). */
  extras: Record<string, string>;
};

export type ParseOkfConceptFrontmatterResult =
  | { ok: true; fields: OkfConceptFrontmatter }
  | { ok: false; errors: string[] };

const REQUIRED_FM_KEYS = ["type", "title", "description", "timestamp"] as const;

/** True when basename is a reserved wiki doc (`index.md` / `log.md`). */
export function isReservedWikiBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return (RESERVED_WIKI_BASENAMES as readonly string[]).includes(lower);
}

/** True when the path's basename is reserved (any depth). */
export function isReservedWikiRelPath(relPath: string): boolean {
  return isReservedWikiBasename(path.basename(relPath));
}

function unquoteScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** ISO 8601 datetime (must include a time component; date-only fails). */
export function isIso8601Datetime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/**
 * Extract the raw YAML frontmatter block body (between leading `---` fences).
 * Returns null when delimiters are missing.
 */
function extractFrontmatterBlock(content: string): string | null {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return null;
  }
  const firstNl = trimmed.indexOf("\n");
  if (firstNl < 0) {
    return null;
  }
  if (trimmed.slice(0, firstNl).trim() !== "---") {
    return null;
  }
  const rest = trimmed.slice(firstNl + 1);
  const close = rest.search(/^---\s*$/m);
  if (close < 0) {
    return null;
  }
  return rest.slice(0, close);
}

/**
 * Minimal line-oriented OKF concept frontmatter parser (no YAML dependency).
 * Required: type, title, description, timestamp (ISO 8601 datetime).
 * Optional keys: simple single-line scalars / flow lists only; nested or
 * multi-line shapes hard-fail. Unknown keys allowed. Never rewrites content.
 */
export function parseOkfConceptFrontmatter(
  content: string,
): ParseOkfConceptFrontmatterResult {
  const block = extractFrontmatterBlock(content);
  if (block === null) {
    return { ok: false, errors: ["missing YAML frontmatter delimiters"] };
  }

  const errors: string[] = [];
  const scalars = new Map<string, string>();
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      continue;
    }
    // Nested / list item / continuation lines are not supported.
    if (/^\s/.test(line)) {
      errors.push(`unsupported nested or multi-line frontmatter near: ${line.trim()}`);
      continue;
    }
    const match = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`unparseable frontmatter line: ${line.trim()}`);
      continue;
    }
    const key = match[1]!;
    let value = match[2] ?? "";
    // Block/folded scalars are multi-line YAML the minimal parser cannot type-check.
    if (value.trim() === "|" || value.trim() === ">" || value.trim().startsWith("|") || value.trim().startsWith(">")) {
      errors.push(`unsupported multi-line frontmatter value for key: ${key}`);
      continue;
    }
    // Peek: next indented line means nested map / multi-line value.
    const next = lines[i + 1];
    if (next !== undefined && next.trim() !== "" && /^\s/.test(next)) {
      errors.push(`unsupported nested or multi-line frontmatter for key: ${key}`);
      // Skip following indented lines so we don't double-report.
      while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || /^\s/.test(lines[i + 1]!))) {
        i += 1;
      }
      continue;
    }
    value = unquoteScalar(value);
    if (scalars.has(key)) {
      errors.push(`duplicate frontmatter key: ${key}`);
      continue;
    }
    scalars.set(key, value);
  }

  const required: Partial<Record<(typeof REQUIRED_FM_KEYS)[number], string>> = {};
  for (const key of REQUIRED_FM_KEYS) {
    const raw = scalars.get(key);
    if (raw === undefined) {
      errors.push(`missing required frontmatter key: ${key}`);
      continue;
    }
    if (raw.length === 0) {
      errors.push(`empty required frontmatter key: ${key}`);
      continue;
    }
    required[key] = raw;
    scalars.delete(key);
  }

  if (required.timestamp !== undefined && !isIso8601Datetime(required.timestamp)) {
    errors.push(
      `timestamp must be parseable ISO 8601 datetime (got ${required.timestamp})`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const extras: Record<string, string> = {};
  for (const [key, value] of scalars) {
    extras[key] = value;
  }

  return {
    ok: true,
    fields: {
      type: required.type!,
      title: required.title!,
      description: required.description!,
      timestamp: required.timestamp!,
      extras,
    },
  };
}

/** True when content has valid OKF concept frontmatter. */
export function hasOkfConceptFrontmatter(content: string): boolean {
  return parseOkfConceptFrontmatter(content).ok;
}

/**
 * @deprecated Title-only check superseded by {@link hasOkfConceptFrontmatter}.
 * Kept for secondary browse helpers; does not satisfy the hard publish gate.
 */
export function hasNonEmptyTitleFrontmatter(content: string): boolean {
  const block = extractFrontmatterBlock(content);
  if (block === null) {
    return false;
  }
  const match = block.match(/^\s*title\s*:\s*(.+?)\s*$/m);
  if (!match) {
    return false;
  }
  return unquoteScalar(match[1]!).length > 0;
}

/** Markdown links: [label](target) — simple single-line form. */
const MD_LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g;

function isExternalOrSpecialTarget(target: string): boolean {
  const t = target.trim();
  if (!t || t.startsWith("#")) {
    return true;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) {
    // repo: handled as citations; http(s)/mailto/etc. are non-concept edges.
    return true;
  }
  return false;
}

/** Case-insensitive membership for concept path sets. */
function conceptSetHas(conceptRelPaths: Set<string>, relPosix: string): boolean {
  if (conceptRelPaths.has(relPosix)) {
    return true;
  }
  const lower = relPosix.toLowerCase();
  for (const c of conceptRelPaths) {
    if (c.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

type ResolvedConceptTarget =
  | { ok: true; relPosix: string }
  | { ok: false; reason: "escapes" | "not-md" | "reserved" | "missing" };

/**
 * Resolve a relative link target under wikiRoot to a POSIX path, then classify
 * against the concept set / reserved rules.
 */
function resolveConceptTarget(
  wikiRoot: string,
  joinedUnderRoot: string,
  conceptRelPaths: Set<string>,
): ResolvedConceptTarget {
  const absTarget = path.resolve(wikiRoot, joinedUnderRoot);
  const rootResolved = path.resolve(wikiRoot);
  if (
    absTarget !== rootResolved &&
    !absTarget.startsWith(rootResolved + path.sep)
  ) {
    return { ok: false, reason: "escapes" };
  }
  const relPosix = path
    .relative(rootResolved, absTarget)
    .split(path.sep)
    .join("/");
  if (!relPosix.toLowerCase().endsWith(".md")) {
    return { ok: false, reason: "not-md" };
  }
  if (isReservedWikiRelPath(relPosix)) {
    return { ok: false, reason: "reserved" };
  }
  if (!conceptSetHas(conceptRelPaths, relPosix)) {
    return { ok: false, reason: "missing" };
  }
  return { ok: true, relPosix };
}

/**
 * Resolve internal concept-edge links (relative `.md` targets).
 *
 * Resolution order (ADR 0028 + Concept ID = wiki-root path):
 * 1. **Page-relative** Markdown (standard): join target to the source page dir.
 * 2. **Wiki-root-relative** fallback when the target does not start with `.`
 *    (so not `./` / `../`): treat the target as a Concept ID path from the wiki
 *    root (e.g. `modules/core.md` from `modules/sc.md`). Agents and skill text
 *    naturally emit this form; page-relative alone would map it to
 *    `modules/modules/core.md`.
 *
 * Broken, out-of-tree, non-`.md`, or reserved targets fail.
 */
export function validateInternalConceptLinks(
  content: string,
  pageRelPath: string,
  conceptRelPaths: Set<string>,
  wikiRoot: string,
): string[] {
  const errors: string[] = [];
  const pageDir = path.dirname(pageRelPath);
  const re = new RegExp(MD_LINK_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const rawTarget = match[2]!.trim();
    if (isExternalOrSpecialTarget(rawTarget)) {
      continue;
    }
    // Strip fragment.
    const withoutHash = rawTarget.split("#")[0] ?? "";
    if (!withoutHash) {
      continue;
    }
    if (path.isAbsolute(withoutHash) || withoutHash.startsWith("/")) {
      errors.push(
        `${pageRelPath}: concept link must be wiki-relative (got ${rawTarget})`,
      );
      continue;
    }

    const pageJoined = path.normalize(
      path.join(pageDir === "." ? "" : pageDir, withoutHash),
    );
    let resolved = resolveConceptTarget(wikiRoot, pageJoined, conceptRelPaths);

    // Wiki-root fallback for targets that look like Concept IDs (no ./ or ../).
    if (
      !resolved.ok &&
      resolved.reason === "missing" &&
      !withoutHash.startsWith(".")
    ) {
      const rootJoined = path.normalize(withoutHash);
      const rootResolved = resolveConceptTarget(
        wikiRoot,
        rootJoined,
        conceptRelPaths,
      );
      if (rootResolved.ok) {
        resolved = rootResolved;
      } else if (rootResolved.reason !== "missing") {
        // Prefer concrete root-form errors (escapes / not-md / reserved) when
        // the root attempt is more specific than "missing".
        resolved = rootResolved;
      }
    }

    if (resolved.ok) {
      continue;
    }
    switch (resolved.reason) {
      case "escapes":
        errors.push(
          `${pageRelPath}: concept link escapes wiki root (${rawTarget})`,
        );
        break;
      case "not-md":
        errors.push(
          `${pageRelPath}: concept link must target a .md page (${rawTarget})`,
        );
        break;
      case "reserved":
        errors.push(
          `${pageRelPath}: concept link must not target reserved doc (${rawTarget})`,
        );
        break;
      case "missing":
        errors.push(
          `${pageRelPath}: broken concept link (cannot resolve ${rawTarget})`,
        );
        break;
    }
  }
  return errors;
}

type WalkEntry = {
  absPath: string;
  relPath: string;
  isFile: boolean;
  isDirectory: boolean;
};

/**
 * Depth-first walk that never follows symlinks. Rejects symlink entries as errors
 * rather than traversing them (path escape / reparse-point safety).
 */
async function walkTreeNoFollow(
  root: string,
  onEntry: (entry: WalkEntry) => void | Promise<void>,
  errors: string[],
): Promise<void> {
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`cannot read directory ${rel || "."}: ${message}`);
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = rel ? path.join(rel, entry.name) : entry.name;

      // Prefer lstat so we never follow reparse points.
      let info;
      try {
        info = await lstat(absPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`cannot stat ${relPath}: ${message}`);
        continue;
      }

      if (info.isSymbolicLink()) {
        errors.push(`symlink not allowed in wiki tree: ${relPath}`);
        continue;
      }

      if (info.isDirectory()) {
        await onEntry({ absPath, relPath, isFile: false, isDirectory: true });
        await walk(absPath, relPath);
      } else if (info.isFile()) {
        await onEntry({ absPath, relPath, isFile: true, isDirectory: false });
      }
      // Ignore other node types (sockets, devices, etc.)
    }
  }

  await walk(root, "");
}

function toPosixRel(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

/**
 * Mechanically validate a staging / publication-candidate Wiki tree (ADR 0028).
 *
 * Checks:
 * - Absolute path, real directory, no symlink components
 * - At least one concept `.md` (non-reserved)
 * - Concept pages: OKF four-field frontmatter; internal concept link resolve
 * - Citations: format + `# Citations` placement only (no Snapshot resolve, no require-≥1)
 * - Reserved: `index.md` not a concept; root `log.md` allowed; nested `log.md` fails
 * - No symlinks inside the tree
 * - Soft caps: ≤ {@link WIKI_VALIDATE_MAX_FILES} files, each ≤ 1MB
 */
export async function validateWikiTree(
  dir: string,
  _options: ValidateWikiOptions = {},
): Promise<ValidateWikiResult> {
  const errors: string[] = [];
  let citationCount = 0;

  let resolved: string;
  try {
    resolved = path.resolve(assertAbsolutePath(dir, "wikiDir"));
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  let rootInfo;
  try {
    rootInfo = await lstat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { ok: false, errors: [`wiki directory does not exist: ${resolved}`] };
    }
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  if (rootInfo.isSymbolicLink()) {
    return { ok: false, errors: [`wikiDir is a symlink: ${resolved}`] };
  }
  if (!rootInfo.isDirectory()) {
    return { ok: false, errors: [`wikiDir is not a directory: ${resolved}`] };
  }

  try {
    await assertNoSymlinkComponents(resolved, "wikiDir");
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  let fileCount = 0;
  let pageCount = 0;
  const mdFiles: { absPath: string; relPath: string; posixRel: string }[] = [];

  await walkTreeNoFollow(
    resolved,
    async (entry) => {
      if (!entry.isFile) {
        return;
      }
      fileCount += 1;
      if (fileCount > WIKI_VALIDATE_MAX_FILES) {
        return;
      }
      if (entry.relPath.toLowerCase().endsWith(".md")) {
        pageCount += 1;
        mdFiles.push({
          absPath: entry.absPath,
          relPath: entry.relPath,
          posixRel: toPosixRel(entry.relPath),
        });
      }
    },
    errors,
  );

  if (fileCount > WIKI_VALIDATE_MAX_FILES) {
    errors.push(
      `wiki tree has ${fileCount} files (max ${WIKI_VALIDATE_MAX_FILES})`,
    );
  }

  // First pass: classify reserved vs concept; read contents for concepts.
  const conceptRelPaths = new Set<string>();
  const conceptContents = new Map<
    string,
    { absPath: string; relPath: string; posixRel: string; content: string }
  >();

  for (const md of mdFiles) {
    const base = path.basename(md.relPath);
    if (base.toLowerCase() === "log.md") {
      // Root-only log.md; nested log.md is a hard fail.
      const parent = path.dirname(md.posixRel);
      if (parent !== ".") {
        errors.push(
          `${md.posixRel}: log.md is root-only (nested log.md not allowed)`,
        );
      }
      // Root log.md is reserved — not a concept; no FM check.
      continue;
    }
    if (base.toLowerCase() === "index.md") {
      // Reserved directory listing — not a concept; no FM check.
      continue;
    }

    let size: number;
    try {
      const info = await lstat(md.absPath);
      if (info.isSymbolicLink()) {
        errors.push(`symlink not allowed in wiki tree: ${md.relPath}`);
        continue;
      }
      if (!info.isFile()) {
        errors.push(`not a regular file: ${md.relPath}`);
        continue;
      }
      size = info.size;
    } catch (error) {
      errors.push(
        `cannot stat ${md.relPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (size > WIKI_VALIDATE_MAX_FILE_BYTES) {
      errors.push(
        `${md.relPath} exceeds max file size (${size} > ${WIKI_VALIDATE_MAX_FILE_BYTES} bytes)`,
      );
      continue;
    }
    let content: string;
    try {
      content = await readFile(md.absPath, "utf8");
    } catch (error) {
      errors.push(
        `cannot read ${md.relPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    conceptRelPaths.add(md.posixRel);
    conceptContents.set(md.posixRel, {
      absPath: md.absPath,
      relPath: md.relPath,
      posixRel: md.posixRel,
      content,
    });
  }

  if (conceptContents.size < 1) {
    errors.push(`wiki tree has no concept pages: ${resolved}`);
  }

  // Second pass: FM, citations placement/format, internal links.
  for (const concept of conceptContents.values()) {
    const fm = parseOkfConceptFrontmatter(concept.content);
    if (!fm.ok) {
      errors.push(
        `${concept.posixRel}: invalid OKF concept frontmatter (${fm.errors.join("; ")})`,
      );
    }

    const citations = parseSourceCitations(concept.content);
    citationCount += citations.length;
    errors.push(
      ...validateCitationPlacement(citations, concept.content, concept.posixRel),
    );
    errors.push(...validateCitationFormat(citations, concept.posixRel));

    errors.push(
      ...validateInternalConceptLinks(
        concept.content,
        concept.posixRel,
        conceptRelPaths,
        resolved,
      ),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    pageCount,
    conceptCount: conceptContents.size,
    fileCount,
    citationCount,
  };
}
