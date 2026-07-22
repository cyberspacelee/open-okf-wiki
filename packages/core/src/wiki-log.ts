/**
 * Root-only `log.md` append helpers (ADR 0028).
 * Written by Run Boundary inside the successful publish transaction.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAbsolutePath } from "./paths.js";
import { isReservedWikiBasename } from "./validate-wiki.js";

export type ConceptDiff = {
  added: string[];
  updated: string[];
  removed: string[];
};

export type PublishLogEntryInput = {
  runId: string;
  skill: string;
  at?: Date;
  added: string[];
  updated: string[];
  removed: string[];
};

const LOG_TITLE = "# Wiki Update Log";

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function formatPathList(paths: string[]): string {
  if (paths.length === 0) {
    return "(none)";
  }
  return paths.map((p) => `\`${p}\``).join(", ");
}

/** Format one Publish entry block (no trailing newline after last line). */
export function formatPublishLogEntry(entry: PublishLogEntryInput): string {
  const at = (entry.at ?? new Date()).toISOString();
  const runId = entry.runId.trim() || "unknown";
  const skill = entry.skill.trim() || "unknown";
  const lines = [
    `* **Publish** \`runId=${runId}\` skill=\`${skill}\` at \`${at}\``,
    `  * Added: ${formatPathList(entry.added)}`,
    `  * Updated: ${formatPathList(entry.updated)}`,
    `  * Removed: ${formatPathList(entry.removed)}`,
  ];
  return lines.join("\n");
}

/**
 * Diff previous vs next concept path→content-hash maps.
 * Paths sorted for stable log output.
 */
export function diffConceptSnapshots(
  previous: Map<string, string>,
  next: Map<string, string>,
): ConceptDiff {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  for (const [p, hash] of next) {
    if (!previous.has(p)) {
      added.push(p);
    } else if (previous.get(p) !== hash) {
      updated.push(p);
    }
  }
  for (const p of previous.keys()) {
    if (!next.has(p)) {
      removed.push(p);
    }
  }

  const sort = (xs: string[]) => xs.sort((a, b) => a.localeCompare(b, "en"));
  return {
    added: sort(added),
    updated: sort(updated),
    removed: sort(removed),
  };
}

/**
 * Walk a wiki root and return concept path → content hash (reserved skipped).
 */
export async function listConceptContentHashes(
  wikiRoot: string,
): Promise<Map<string, string>> {
  const root = path.resolve(assertAbsolutePath(wikiRoot, "wikiRoot"));
  const out = new Map<string, string>();

  async function walk(absDir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
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
        await walk(absPath, childRel);
        continue;
      }
      if (!info.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      if (isReservedWikiBasename(entry.name)) {
        continue;
      }
      try {
        const content = await readFile(absPath, "utf8");
        out.set(toPosix(childRel), contentHash(content));
      } catch {
        // skip unreadable
      }
    }
  }

  await walk(root, "");
  return out;
}

type DateSection = {
  date: string;
  /** Body under the date heading (entries), without the heading line. */
  body: string;
};

/**
 * Parse a wiki log into title + date sections. Returns null if corrupt.
 */
export function parseWikiLogOrNull(
  content: string,
): { title: string; sections: DateSection[] } | null {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith(`${LOG_TITLE}\n`) && text.trim() !== LOG_TITLE) {
    return null;
  }

  // Split on ## YYYY-MM-DD headings
  const withoutTitle = text.startsWith(`${LOG_TITLE}\n`)
    ? text.slice(LOG_TITLE.length + 1)
    : "";
  const sections: DateSection[] = [];
  const re = /^## (\d{4}-\d{2}-\d{2})[ \t]*$/gm;
  const matches = [...withoutTitle.matchAll(re)];
  if (matches.length === 0) {
    // Empty log with only title is still valid skeleton.
    if (withoutTitle.trim() === "") {
      return { title: LOG_TITLE, sections: [] };
    }
    // Has non-date content → corrupt for safe insert.
    return null;
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const date = m[1]!;
    const start = (m.index ?? 0) + m[0].length;
    // skip newline after heading
    let bodyStart = start;
    if (withoutTitle[bodyStart] === "\n") {
      bodyStart += 1;
    }
    const end =
      i + 1 < matches.length ? (matches[i + 1]!.index ?? withoutTitle.length) : withoutTitle.length;
    const body = withoutTitle.slice(bodyStart, end).replace(/\n+$/, "");
    sections.push({ date, body });
  }

  // Date sections must be unique for safe insert; duplicates → corrupt.
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.date)) {
      return null;
    }
    seen.add(s.date);
  }

  return { title: LOG_TITLE, sections };
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function renderLog(sections: DateSection[]): string {
  const lines: string[] = [LOG_TITLE, ""];
  for (const s of sections) {
    lines.push(`## ${s.date}`, "");
    if (s.body) {
      lines.push(s.body);
      if (!s.body.endsWith("\n")) {
        // body stored without trailing blank; ensure separation
      }
      lines.push("");
    }
  }
  // Ensure trailing newline
  let out = lines.join("\n");
  if (!out.endsWith("\n")) {
    out += "\n";
  }
  return out;
}

/**
 * Append a Publish entry to root `log.md`.
 * Missing → create; corrupt → replace with skeleton + this entry.
 * UTC day headings newest-first; same-day entries newest-first.
 */
export async function appendRootLog(
  wikiRoot: string,
  entry: PublishLogEntryInput,
): Promise<void> {
  const root = path.resolve(assertAbsolutePath(wikiRoot, "wikiRoot"));
  const logPath = path.join(root, "log.md");
  const at = entry.at ?? new Date();
  const day = utcDay(at);
  const entryBlock = formatPublishLogEntry({ ...entry, at });

  let existing: string | null = null;
  try {
    existing = await readFile(logPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  let sections: DateSection[] = [];
  if (existing !== null) {
    const parsed = parseWikiLogOrNull(existing);
    if (parsed) {
      sections = parsed.sections;
    }
    // corrupt → sections stay empty (replace)
  }

  const idx = sections.findIndex((s) => s.date === day);
  if (idx >= 0) {
    const current = sections[idx]!;
    const body = current.body
      ? `${entryBlock}\n\n${current.body}`
      : entryBlock;
    sections[idx] = { date: day, body };
  } else {
    sections.unshift({ date: day, body: entryBlock });
  }

  // Keep date sections newest-first.
  sections.sort((a, b) => b.date.localeCompare(a.date));

  await writeFile(logPath, renderLog(sections), "utf8");
}
