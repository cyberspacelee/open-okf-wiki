/**
 * String / message extractors for projection surfaces.
 */

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

/** Default cap for tool / payload surfaces (pretty JSON can grow fast). */
export const PAYLOAD_TEXT_MAX = 12_000;

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
// Tool display — human-friendly summaries (pi-web / OpenCode style)
// Collapsed header shows verb + key arg; body avoids dumping full JSON.
// ---------------------------------------------------------------------------

export type ToolDisplaySummary = {
  /** Short verb / tool label (e.g. "read", "grep"). */
  title: string;
  /** Primary target for the header (path, pattern, command…). */
  subtitle?: string;
  /** Expanded primary content (command body, content preview…). */
  body?: string;
  /** Remaining structured args as pretty JSON when useful. */
  details?: string;
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

function remainingDetails(
  params: Record<string, unknown>,
  usedKeys: string[],
): string | undefined {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (usedKeys.includes(k)) continue;
    if (v === undefined || v === null || v === "") continue;
    rest[k] = v;
  }
  if (Object.keys(rest).length === 0) return undefined;
  try {
    return formatPayloadText(JSON.stringify(rest));
  } catch {
    return undefined;
  }
}

/**
 * Build a display summary for a tool call.
 * Known tools (read/write/edit/grep/find/ls/bash/…) get verb + key arg headers
 * instead of raw JSON — matching pi-web renderers and OpenCode BasicTool.
 */
export function formatToolDisplay(
  toolName: string,
  inputRaw?: string,
): ToolDisplaySummary {
  const name = toolName.trim() || "tool";
  const params = parseToolInput(inputRaw);

  if (!params) {
    // Non-JSON or empty — show name + truncated raw as subtitle when short.
    const raw = inputRaw?.trim();
    if (raw && raw.length <= 80 && !raw.startsWith("{") && !raw.startsWith("[")) {
      return { title: name, subtitle: raw, body: raw };
    }
    return {
      title: name,
      body: raw ? formatPayloadText(raw) : undefined,
    };
  }

  const lower = name.toLowerCase();

  // read / write / edit / ls — path-centric
  if (
    lower === "read" ||
    lower === "write" ||
    lower === "edit" ||
    lower === "ls" ||
    lower === "list"
  ) {
    const path =
      asString(params.path) ??
      asString(params.file_path) ??
      asString(params.filePath) ??
      asString(params.target);
    const used = ["path", "file_path", "filePath", "target"];
    const content =
      asString(params.content) ??
      asString(params.new_string) ??
      asString(params.newString);
    if (content) used.push("content", "new_string", "newString");
    const rangeParts: string[] = [];
    if (params.offset !== undefined) rangeParts.push(`offset=${params.offset}`);
    if (params.limit !== undefined) rangeParts.push(`limit=${params.limit}`);
    used.push("offset", "limit");

    const subtitle = path
      ? `${toolPathLabel(path)}${rangeParts.length ? ` (${rangeParts.join(", ")})` : ""}`
      : undefined;
    return {
      title: lower,
      subtitle,
      body: content
        ? formatPayloadText(content, 4_000)
        : path
          ? path
          : undefined,
      details: remainingDetails(params, used),
    };
  }

  // grep / find / glob — pattern-centric
  if (lower === "grep" || lower === "find" || lower === "glob") {
    const pattern =
      asString(params.pattern) ??
      asString(params.query) ??
      asString(params.glob);
    const path =
      asString(params.path) ??
      asString(params.include) ??
      asString(params.glob);
    const used = ["pattern", "query", "glob", "path", "include"];
    const subtitle = pattern ?? (path ? toolPathLabel(path) : undefined);
    const bodyParts = [
      pattern ? `pattern: ${pattern}` : null,
      path ? `path: ${path}` : null,
    ].filter(Boolean);
    return {
      title: lower,
      subtitle,
      body: bodyParts.length ? bodyParts.join("\n") : undefined,
      details: remainingDetails(params, used),
    };
  }

  // bash / shell — command-centric (pi BashRenderer: `> command`)
  if (lower === "bash" || lower === "shell" || lower === "run") {
    const command =
      asString(params.command) ??
      asString(params.cmd) ??
      asString(params.script);
    return {
      title: lower === "bash" || lower === "shell" ? "shell" : lower,
      subtitle: command
        ? command.length > 72
          ? `${command.slice(0, 71)}…`
          : command
        : undefined,
      body: command ? `$ ${command}` : undefined,
      details: remainingDetails(params, ["command", "cmd", "script"]),
    };
  }

  // Generic: prefer a single primary string field as subtitle
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
  let subtitle: string | undefined;
  const used: string[] = [];
  for (const key of primaryKeys) {
    const v = asString(params[key]);
    if (v) {
      subtitle = v.length > 72 ? `${v.slice(0, 71)}…` : v;
      used.push(key);
      break;
    }
  }

  // If only a few simple fields, show them as key: value lines instead of JSON
  const keys = Object.keys(params);
  if (keys.length > 0 && keys.length <= 6) {
    const lines = keys
      .map((k) => {
        const v = params[k];
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          return `${k}: ${v}`;
        }
        return null;
      })
      .filter(Boolean) as string[];
    if (lines.length === keys.length) {
      return {
        title: name,
        subtitle: subtitle ?? lines[0],
        body: lines.join("\n"),
      };
    }
  }

  return {
    title: name,
    subtitle,
    body: formatPayloadText(JSON.stringify(params)),
    details: used.length ? remainingDetails(params, used) : undefined,
  };
}
