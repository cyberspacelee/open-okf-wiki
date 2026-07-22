/**
 * Pure helpers for tool one-line titles (no React).
 * Shared by Session UI and unit tests.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function pathFromToolInput(input: unknown): string {
  if (!isRecord(input)) {
    return ".";
  }
  const path = asString(input.path);
  return path && path.length > 0 ? path : ".";
}

export function sourceIdFromTool(
  input: unknown,
  output: unknown,
): string | undefined {
  if (isRecord(input) && typeof input.sourceId === "string") {
    return input.sourceId;
  }
  if (isRecord(output) && typeof output.sourceId === "string") {
    return output.sourceId;
  }
  return undefined;
}

function entryCount(output: unknown): number | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  if (typeof output.entryCount === "number") {
    return output.entryCount;
  }
  if (Array.isArray(output.entries)) {
    return output.entries.length;
  }
  return undefined;
}

function contentMeta(
  output: unknown,
  input: unknown,
): { chars?: number; truncated?: boolean } {
  if (isRecord(output)) {
    return {
      chars:
        typeof output.contentChars === "number"
          ? output.contentChars
          : typeof output.content === "string"
            ? output.content.length
            : undefined,
      truncated: Boolean(output.truncated),
    };
  }
  if (isRecord(input)) {
    return {
      chars:
        typeof input.contentChars === "number"
          ? input.contentChars
          : typeof input.content === "string"
            ? input.content.length
            : typeof input.contentPreview === "string"
              ? input.contentPreview.length
              : undefined,
      truncated: Boolean(input.truncated),
    };
  }
  return {};
}

export function toolSummaryTitle(
  toolName: string,
  input: unknown,
  output: unknown,
  state: string,
): string {
  const path = pathFromToolInput(input);
  const sid = sourceIdFromTool(input, output);
  const loc = sid ? `${sid}:${path}` : path;

  switch (toolName) {
    case "list_source": {
      const n = entryCount(output);
      const nLabel =
        n === undefined
          ? state === "output-available"
            ? ""
            : "…"
          : ` · ${n} entries`;
      return `List ${loc}${nLabel}`;
    }
    case "list_skill": {
      const n = entryCount(output);
      return `Skill ls ${path}${n !== undefined ? ` · ${n}` : ""}`;
    }
    case "list_wiki": {
      const n = entryCount(output);
      return `Wiki ls ${path}${n !== undefined ? ` · ${n}` : ""}`;
    }
    case "read_source": {
      const meta = contentMeta(output, input);
      const size =
        meta.chars !== undefined
          ? ` · ${meta.chars} chars${meta.truncated ? "…" : ""}`
          : "";
      return `Read ${loc}${size}`;
    }
    case "read_skill": {
      const meta = contentMeta(output, input);
      return `Skill read ${path}${meta.chars !== undefined ? ` · ${meta.chars}c` : ""}`;
    }
    case "read_wiki": {
      const meta = contentMeta(output, input);
      return `Wiki read ${path}${meta.chars !== undefined ? ` · ${meta.chars}c` : ""}`;
    }
    case "write_wiki": {
      const bytes =
        isRecord(output) && typeof output.bytes === "number"
          ? ` · ${output.bytes} B`
          : "";
      const meta = contentMeta(undefined, input);
      const chars =
        !bytes && meta.chars !== undefined ? ` · ${meta.chars} chars` : "";
      return `Write ${path}${bytes || chars}`;
    }
    case "glob_source": {
      const n =
        isRecord(output) && typeof output.pathCount === "number"
          ? output.pathCount
          : isRecord(output) && Array.isArray(output.paths)
            ? output.paths.length
            : undefined;
      const pattern =
        isRecord(input) && typeof input.pattern === "string"
          ? input.pattern
          : "*";
      return `Glob ${sid ? `${sid}:` : ""}${pattern}${n !== undefined ? ` · ${n}` : ""}`;
    }
    case "search_source": {
      const n =
        isRecord(output) && typeof output.matchCount === "number"
          ? output.matchCount
          : isRecord(output) && Array.isArray(output.matches)
            ? output.matches.length
            : undefined;
      const pattern =
        isRecord(input) && typeof input.pattern === "string"
          ? input.pattern
          : "";
      return `Search ${loc}${pattern ? ` · /${pattern}/` : ""}${n !== undefined ? ` · ${n}` : ""}`;
    }
    default:
      return toolName;
  }
}

export function languageFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "css":
      return "css";
    case "html":
      return "html";
    case "sh":
    case "bash":
      return "bash";
    default:
      return "text";
  }
}
