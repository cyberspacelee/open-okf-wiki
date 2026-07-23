/**
 * String / message extractors for projection surfaces.
 */

/** Default cap for tool / payload surfaces (pretty JSON can grow fast). */
export const PAYLOAD_TEXT_MAX = 12_000;

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function safeStringify(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

/**
 * Compact JSON for tool *inputs* (still parseable by formatToolDisplay).
 * Prefer one-line when short so headers stay light.
 */
export function compactToolInput(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return undefined;
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }
  try {
    const s = JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

/**
 * Extract human-readable tool *result* text (OpenCode / pi-web style).
 * Prefer content[].text from Pi AgentToolResult; never dump full JSON envelopes.
 */
export function formatToolResultText(
  value: unknown,
  max = PAYLOAD_TEXT_MAX,
): string | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    // If the string is a JSON envelope, peel it once.
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const nested = formatToolResultText(JSON.parse(trimmed), max);
        if (nested) return nested;
      } catch {
        // keep raw string
      }
    }
    return trimmed.length > max
      ? `${trimmed.slice(0, max)}\n…[truncated ${trimmed.length - max} chars]`
      : trimmed;
  }

  if (Array.isArray(value)) {
    // Pi content array: [{type:'text', text:'…'}, …]
    const texts: string[] = [];
    for (const block of value) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) {
      return formatToolResultText(texts.join("\n"), max);
    }
    // Array of strings / scalars
    const asLines = value
      .map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : null))
      .filter(Boolean) as string[];
    if (asLines.length === value.length && asLines.length > 0) {
      return formatToolResultText(asLines.join("\n"), max);
    }
    return undefined;
  }

  if (isRecord(value)) {
    // AgentToolResult: { content: [...], details?, isError? }
    if (Array.isArray(value.content)) {
      const fromContent = formatToolResultText(value.content, max);
      if (fromContent) return fromContent;
    }
    // Common single-field results
    for (const key of ["text", "output", "stdout", "result", "message"] as const) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return formatToolResultText(value[key], max);
      }
    }
    // details.preview / details.output
    if (isRecord(value.details)) {
      const d = value.details;
      for (const key of ["preview", "output", "text", "stdout"] as const) {
        if (typeof d[key] === "string" && d[key].trim()) {
          return formatToolResultText(d[key], max);
        }
      }
    }
    // Don't fall back to full JSON dump — empty means "no displayable result"
    return undefined;
  }

  return String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract plain text from a Pi assistant/user message content array or string. */
export function extractMessageText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** Extract thinking blocks from a Pi assistant message content array. */
export function extractMessageThinking(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("");
}

/**
 * Pi assistant error fields (stopReason + errorMessage).
 * Used when the provider fails without throwing from session.prompt().
 */
export function extractAssistantError(message: unknown): {
  isError: boolean;
  errorMessage?: string;
  stopReason?: string;
} {
  if (!isRecord(message)) return { isError: false };
  const stopReason =
    typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage =
    typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : undefined;
  const isError =
    stopReason === "error" ||
    stopReason === "aborted" ||
    Boolean(errorMessage);
  return { isError, errorMessage, stopReason };
}

/**
 * Pretty-print complete JSON object/array strings for tool / payload surfaces.
 * Incomplete or non-JSON text is returned as-is. Overlong results are truncated
 * with a clear marker (avoids crushing the layout with multi-MB blobs).
 */
export function formatPayloadText(
  raw: string | undefined,
  max = PAYLOAD_TEXT_MAX,
): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  let out = raw;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      out = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // keep original (incomplete stream, non-JSON braces, etc.)
    }
  }
  if (max > 0 && out.length > max) {
    const omitted = out.length - max;
    return `${out.slice(0, max)}\n…[truncated ${omitted} chars]`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool display — OpenCode BasicTool / pi-web specialized renderer style
//
// One-line header: title + subtitle + optional args chips.
// Expand body is RESULT only (no "Input" / "Output" labels).
// Args already shown in the header are never repeated as JSON.
// ---------------------------------------------------------------------------

export type ToolDisplaySummary = {
  /** Verb / tool label shown in the trigger (e.g. "read", "grep"). */
  title: string;
  /** Key target on the same line (filename, pattern, command…). */
  subtitle?: string;
  /** Secondary chips after subtitle (OpenCode args: offset=…, pattern=…). */
  args?: string[];
  /**
   * How to expand:
   * - output-only: only tool result text (read/grep/list when completed)
   * - console: shell — `$ cmd` then result (pi BashRenderer)
   * - write-body: write/edit content preview + result
   * - raw: unknown tools — pretty args only when there is no structured header
   */
  kind: "output-only" | "console" | "write-body" | "raw";
  /** For write/edit: content preview in expand (not labeled "Input"). */
  writePreview?: string;
  /** For console: full command for the `$ …` line. */
  command?: string;
  /** True when this tool is fully described by the header (no expand needed). */
  headerOnly?: boolean;
};

function parseToolInput(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** Basename-ish label for paths (OpenCode getFilename style). */
export function toolPathLabel(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return pathValue;
  if (parts.length === 1) return parts[0]!;
  return parts[parts.length - 1]!;
}

function truncateOneLine(text: string, max = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * OpenCode-style tool summary.
 * Known tools put everything useful on the trigger line; expand is result-only.
 */
export function formatToolDisplay(
  toolName: string,
  inputRaw?: string,
): ToolDisplaySummary {
  const name = toolName.trim() || "tool";
  const lower = name.toLowerCase();
  const params = parseToolInput(inputRaw);

  if (!params) {
    const raw = inputRaw?.trim();
    if (raw && raw.length <= 80 && !raw.startsWith("{") && !raw.startsWith("[")) {
      return {
        title: name,
        subtitle: raw,
        kind: "output-only",
        headerOnly: true,
      };
    }
    return {
      title: name,
      kind: "raw",
      writePreview: raw ? formatPayloadText(raw) : undefined,
    };
  }

  // ---- read / ls / list — OpenCode: header only (filename + offset/limit) ----
  if (lower === "read" || lower === "ls" || lower === "list") {
    const path =
      asString(params.path) ??
      asString(params.file_path) ??
      asString(params.filePath) ??
      asString(params.target);
    const args: string[] = [];
    if (params.offset !== undefined) args.push(`offset=${params.offset}`);
    if (params.limit !== undefined) args.push(`limit=${params.limit}`);
    return {
      title: lower === "list" ? "list" : lower,
      subtitle: path ? toolPathLabel(path) : undefined,
      args: args.length ? args : undefined,
      kind: "output-only",
      // read rarely needs expand; list/ls may show directory listing as output
      headerOnly: lower === "read",
    };
  }

  // ---- write / edit — subtitle = path; expand = content preview + result ----
  if (lower === "write" || lower === "edit") {
    const path =
      asString(params.path) ??
      asString(params.file_path) ??
      asString(params.filePath) ??
      asString(params.target);
    const content =
      asString(params.content) ??
      asString(params.new_string) ??
      asString(params.newString);
    return {
      title: lower,
      subtitle: path ? toolPathLabel(path) : undefined,
      kind: "write-body",
      writePreview: content
        ? formatPayloadText(content, 4_000)
        : undefined,
    };
  }

  // ---- grep / find / glob — title + pattern/path; expand = matches only ----
  if (lower === "grep" || lower === "find" || lower === "glob") {
    const pattern =
      asString(params.pattern) ??
      asString(params.query) ??
      asString(params.glob);
    const path = asString(params.path);
    const include = asString(params.include);
    // OpenCode: subtitle = directory, args = pattern=…
    // When no path, put pattern on the subtitle (common for our tools).
    if (path) {
      const args: string[] = [];
      if (pattern) args.push(`pattern=${truncateOneLine(pattern, 40)}`);
      if (include) args.push(`include=${include}`);
      return {
        title: lower,
        subtitle: toolPathLabel(path),
        args: args.length ? args : undefined,
        kind: "output-only",
      };
    }
    return {
      title: lower,
      subtitle: pattern ? truncateOneLine(pattern, 56) : include,
      kind: "output-only",
    };
  }

  // ---- bash / shell — pi BashRenderer: header "shell", expand console ----
  if (lower === "bash" || lower === "shell" || lower === "run") {
    const command =
      asString(params.command) ??
      asString(params.cmd) ??
      asString(params.script);
    return {
      title: lower === "run" ? "run" : "shell",
      subtitle: command ? truncateOneLine(command, 64) : undefined,
      kind: "console",
      command: command ?? undefined,
    };
  }

  // ---- generic: pick one primary field as subtitle; no Input/Output dump ----
  const primaryKeys = [
    "path",
    "file_path",
    "filePath",
    "command",
    "query",
    "pattern",
    "url",
    "name",
    "title",
    "description",
    "message",
    "prompt",
  ];
  for (const key of primaryKeys) {
    const v = asString(params[key]);
    if (v) {
      return {
        title: name,
        subtitle: truncateOneLine(v, 64),
        kind: "output-only",
      };
    }
  }

  // Few scalar fields → pack into subtitle rather than JSON body
  const keys = Object.keys(params);
  if (keys.length > 0 && keys.length <= 4) {
    const parts = keys
      .map((k) => {
        const v = params[k];
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          return `${k}=${v}`;
        }
        return null;
      })
      .filter(Boolean) as string[];
    if (parts.length === keys.length) {
      return {
        title: name,
        subtitle: truncateOneLine(parts.join(" · "), 72),
        kind: "output-only",
        headerOnly: true,
      };
    }
  }

  // Last resort: unknown structured args — show compact one-liner, expand only result
  return {
    title: name,
    subtitle: truncateOneLine(
      keys.map((k) => k).join(", "),
      48,
    ),
    kind: "output-only",
  };
}
